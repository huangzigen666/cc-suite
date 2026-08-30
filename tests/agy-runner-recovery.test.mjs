import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const RUNNER = path.resolve("scripts/agy-runner.mjs");
const CRASH_POINTS = [
  "scratch-prepared",
  "child-spawned",
  "stream-active",
  "child-closed",
];

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cc-suite test",
      GIT_AUTHOR_EMAIL: "cc-suite@example.invalid",
      GIT_COMMITTER_NAME: "cc-suite test",
      GIT_COMMITTER_EMAIL: "cc-suite@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeFixture(t, crashPoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cc-suite-runner-${crashPoint}-`));
  const source = path.join(root, "source");
  const workspace = path.join(root, "worktree");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(source);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gemini", "antigravity-cli", "installation_id"),
    "fixture-installation-id\n",
    "utf8"
  );
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  git(source, ["worktree", "add", "--detach", workspace, "HEAD"]);

  const agyFile = path.join(bin, "agy");
  const shouldMutate = crashPoint === "stream-active" || crashPoint === "child-closed";
  const shouldExit = crashPoint === "child-closed";
  writeExecutable(agyFile, `#!/bin/sh
${shouldMutate ? 'printf "%s\\n" recovered > "$PWD/recovery-change.txt"' : ":"}
printf "%s\\n" "$$" > "$PWD/fake-agy.pid"
FAKE_CWD="$(pwd -P)"
printf '{"event":"init","conversation_id":"fixture-crash","init":{"model":"gemini-3.6-flash-low","cwd":"%s","tools":["write_to_file"],"permission_mode":"request-review"}}\\n' "$FAKE_CWD"
${shouldExit ? 'printf "%s\\n" \'{"event":"result","result":{"conversation_id":"fixture-crash","status":"SUCCESS","response":"DONE"}}\'' : "sleep 60"}
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_PLUGIN_DATA: pluginData,
    NODE_ENV: "test",
    HTTP_PROXY: "http://127.0.0.1:7892",
    HTTPS_PROXY: "http://127.0.0.1:7892",
    ALL_PROXY: "http://127.0.0.1:7892",
    http_proxy: "http://127.0.0.1:7892",
    https_proxy: "http://127.0.0.1:7892",
    all_proxy: "http://127.0.0.1:7892",
  };
  const liveGroups = new Set();
  t.after(() => {
    for (const pgid of liveGroups) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", workspace]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { agyFile, env, liveGroups, pluginData, source, workspace };
}

function runnerArgs() {
  return [
    RUNNER,
    "--kind", "agy",
    "--project", "fixture-project",
    "--model", "gemini-3.6-flash-low",
    "--sandbox", "workspace-write",
    "--candidate-workspace-write",
    "--timeout-ms", "10000",
    "--", "recovery probe",
  ];
}

function runAsync(cwd, env) {
  const child = spawn(process.execPath, runnerArgs(), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function findSingleManifest(pluginData) {
  const stateRoot = path.join(pluginData, "state");
  const stateDirs = fs.readdirSync(stateRoot).map((name) => path.join(stateRoot, name));
  const manifests = stateDirs.flatMap((stateDir) => {
    const recoveryDir = path.join(stateDir, "agy-runs");
    if (!fs.existsSync(recoveryDir)) return [];
    return fs.readdirSync(recoveryDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(recoveryDir, name));
  });
  assert.equal(manifests.length, 1);
  return manifests[0];
}

function processGroupAlive(pgid) {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  return result.stdout.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    return match && Number(match[1]) === pgid && !match[2].startsWith("Z");
  });
}

for (const crashPoint of CRASH_POINTS) {
  test(`runner restart recovers SIGKILL at ${crashPoint}`, { timeout: 15000 }, async (t) => {
    const fixture = makeFixture(t, crashPoint);
    const crashed = await runAsync(fixture.workspace, {
      ...fixture.env,
      CC_SUITE_AGY_TEST_CRASH_AT: crashPoint,
    });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr || crashed.stdout);

    const manifestPath = findSingleManifest(fixture.pluginData);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.stage, crashPoint);
    assert.equal(fs.existsSync(manifest.scratchDir), true);
    if (manifest.agyProcess?.pgid) fixture.liveGroups.add(manifest.agyProcess.pgid);

    writeExecutable(fixture.agyFile, `#!/bin/sh
FAKE_CWD="$(pwd -P)"
printf '{"event":"init","conversation_id":"fixture-restart","init":{"model":"gemini-3.6-flash-low","cwd":"%s","tools":["view_file"],"permission_mode":"request-review"}}\\n' "$FAKE_CWD"
printf "%s\\n" '{"event":"result","result":{"conversation_id":"fixture-restart","status":"SUCCESS","response":"RECOVERED"}}'
`);
    await runAsync(fixture.workspace, fixture.env);

    assert.equal(fs.existsSync(manifestPath), false);
    assert.equal(fs.existsSync(manifest.scratchDir), false);
    if (manifest.agyProcess?.pgid) {
      assert.equal(processGroupAlive(manifest.agyProcess.pgid), false);
      fixture.liveGroups.delete(manifest.agyProcess.pgid);
    }

    const stateFile = fs.readdirSync(path.join(fixture.pluginData, "state"))
      .map((name) => path.join(fixture.pluginData, "state", name, "state.json"))
      .find((file) => fs.existsSync(file));
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const recoveredJob = state.jobs.find((job) => job.id === manifest.jobId);
    assert.equal(recoveredJob.status, "aborted");
    assert.equal(recoveredJob.errorCode, "AGY_RUNNER_ABORTED");

    const jobFile = path.join(path.dirname(stateFile), "jobs", `${manifest.jobId}.json`);
    const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (crashPoint === "stream-active" || crashPoint === "child-closed") {
      assert.ok(stored.workspaceChanges.includes("?? recovery-change.txt"));
      assert.equal(
        fs.readFileSync(path.join(fixture.workspace, "recovery-change.txt"), "utf8"),
        "recovered\n"
      );
    }
  });
}
