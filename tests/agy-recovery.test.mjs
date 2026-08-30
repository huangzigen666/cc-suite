import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  completeAgyRunManifest,
  createAgyRunManifest,
  inspectProcessIdentity,
  recordAgyProcess,
  resolveAgyRecoveryDir,
  scavengeAgyRuns,
} from "../scripts/lib/agy-recovery.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
} from "../scripts/lib/state.mjs";

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
  return result.stdout.trim();
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-recovery-test-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "worktree");
  const pluginData = path.join(root, "plugin-data");
  fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  git(source, ["worktree", "add", "--detach", workspace, "HEAD"]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-agy-seatbelt-"));
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;

  t.after(() => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", workspace]);
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: true });
  });
  return { workspace, scratch };
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} remained alive`);
}

test("run manifests are private, atomic, and record the workspace baseline", (t) => {
  const { workspace, scratch } = makeFixture(t);
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId: "agy-recovery-atomic",
    scratchDir: scratch,
    logFile: resolveJobLogFile(workspace, "agy-recovery-atomic"),
  });

  const stat = fs.lstatSync(created.manifestPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(created.manifest.workspace, fs.realpathSync.native(workspace));
  assert.equal(created.manifest.baselineCommit, git(workspace, ["rev-parse", "HEAD"]));
  assert.match(created.manifest.gitLinkSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(resolveAgyRecoveryDir(workspace)).some((name) => name.endsWith(".tmp")), false);

  completeAgyRunManifest(created.manifestPath);
  assert.equal(fs.existsSync(created.manifestPath), false);
});

test("scavenger skips a manifest owned by the live runner", async (t) => {
  const { workspace, scratch } = makeFixture(t);
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId: "agy-recovery-live",
    scratchDir: scratch,
    logFile: resolveJobLogFile(workspace, "agy-recovery-live"),
  });

  const results = await scavengeAgyRuns(workspace, { graceMs: 50 });
  assert.deepEqual(results.map((result) => result.status), ["active"]);
  assert.equal(fs.existsSync(created.manifestPath), true);
  assert.equal(fs.existsSync(scratch), true);
});

test("scavenger kills an attributable orphan group, preserves mutations, and marks aborted", async (t) => {
  const { workspace, scratch } = makeFixture(t);
  const jobId = "agy-recovery-orphan";
  const logFile = resolveJobLogFile(workspace, jobId);
  upsertJob(workspace, {
    id: jobId,
    kind: "agy",
    status: "running",
    summary: "fixture",
    pid: 99999999,
    logFile,
  });
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId,
    scratchDir: scratch,
    logFile,
    runnerPid: 99999999,
    runnerIdentity: { pid: 99999999, pgid: 99999999, started: "missing" },
  });

  const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  const identity = inspectProcessIdentity(child.pid);
  assert.ok(identity);
  recordAgyProcess(created.manifestPath, {
    pid: child.pid,
    pgid: child.pid,
    identity,
  });
  fs.writeFileSync(path.join(workspace, "recovered.txt"), "survives\n", "utf8");

  const results = await scavengeAgyRuns(workspace, { graceMs: 100 });
  assert.deepEqual(results.map((result) => result.status), ["aborted"]);
  await waitForExit(child.pid);
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(fs.existsSync(created.manifestPath), false);
  assert.equal(fs.readFileSync(path.join(workspace, "recovered.txt"), "utf8"), "survives\n");

  const job = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(job.status, "aborted");
  assert.equal(job.errorCode, "AGY_RUNNER_ABORTED");
  const payload = readJobFile(resolveJobFile(workspace, jobId));
  assert.deepEqual(payload.workspaceChanges, ["?? recovered.txt"]);
});

test("identity mismatch blocks signals and scratch deletion", async (t) => {
  const { workspace, scratch } = makeFixture(t);
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId: "agy-recovery-mismatch",
    scratchDir: scratch,
    logFile: resolveJobLogFile(workspace, "agy-recovery-mismatch"),
    runnerPid: 99999999,
    runnerIdentity: { pid: 99999999, pgid: 99999999, started: "missing" },
  });
  const actual = inspectProcessIdentity(process.pid);
  recordAgyProcess(created.manifestPath, {
    pid: process.pid,
    pgid: actual.pgid,
    identity: { ...actual, started: "wrong" },
  });

  const results = await scavengeAgyRuns(workspace, { graceMs: 50 });
  assert.deepEqual(results.map((result) => result.status), ["blocked"]);
  assert.equal(fs.existsSync(created.manifestPath), true);
  assert.equal(fs.existsSync(scratch), true);
});

test("tampered scratch paths are never deleted", async (t) => {
  const { workspace, scratch } = makeFixture(t);
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId: "agy-recovery-unsafe-delete",
    scratchDir: scratch,
    logFile: resolveJobLogFile(workspace, "agy-recovery-unsafe-delete"),
    runnerPid: 99999999,
    runnerIdentity: { pid: 99999999, pgid: 99999999, started: "missing" },
  });
  const protectedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-protected-"));
  const sentinel = path.join(protectedDir, "keep.txt");
  fs.writeFileSync(sentinel, "keep\n", "utf8");
  t.after(() => fs.rmSync(protectedDir, { recursive: true, force: true }));

  const tampered = JSON.parse(fs.readFileSync(created.manifestPath, "utf8"));
  tampered.scratchDir = fs.realpathSync.native(protectedDir);
  fs.writeFileSync(created.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(created.manifestPath, 0o600);

  const results = await scavengeAgyRuns(workspace, { graceMs: 50 });
  assert.deepEqual(results.map((result) => result.status), ["blocked"]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep\n");
  assert.equal(fs.existsSync(protectedDir), true);
  assert.equal(fs.existsSync(created.manifestPath), true);
});

test("tampered log paths are rejected before recovery", async (t) => {
  const { workspace, scratch } = makeFixture(t);
  const jobId = "agy-recovery-log-path";
  const created = createAgyRunManifest({
    cwd: workspace,
    jobId,
    scratchDir: scratch,
    logFile: resolveJobLogFile(workspace, jobId),
    runnerPid: 99999999,
    runnerIdentity: { pid: 99999999, pgid: 99999999, started: "missing" },
  });
  const tampered = JSON.parse(fs.readFileSync(created.manifestPath, "utf8"));
  tampered.logFile = "/etc/passwd";
  fs.writeFileSync(created.manifestPath, `${JSON.stringify(tampered, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(created.manifestPath, 0o600);

  const results = await scavengeAgyRuns(workspace, { graceMs: 50 });
  assert.equal(results[0].status, "blocked");
  assert.equal(results[0].errorCode, "AGY_RECOVERY_LOG_PATH_INVALID");
  assert.equal(fs.existsSync(scratch), true);
  assert.equal(fs.existsSync(created.manifestPath), true);
});
