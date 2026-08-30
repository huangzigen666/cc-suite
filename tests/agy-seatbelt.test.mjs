import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import test from "node:test";

import {
  AGY_SEATBELT_PROFILE,
  auditDisposableWorktree,
  buildSeatbeltEnvironment,
  cleanupSeatbeltScratch,
  createDetachedProbeWorktree,
  createSeatbeltLaunch,
  resolveAgyEgressProxy,
} from "../scripts/lib/agy-seatbelt.mjs";

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

function makeDetachedWorktree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-seatbelt-test-"));
  const source = path.join(root, "source");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  git(source, ["worktree", "add", "--detach", worktree, "HEAD"]);

  t.after(() => {
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", worktree]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, source, worktree };
}

function fixtureProxyEnv() {
  return Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map(
      (name) => [name, "http://127.0.0.1:7892"]
    )
  );
}

test("Seatbelt profile uses parameterized workspace and scratch roots", () => {
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_WORKSPACE\"/);
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_SCRATCH\"/);
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_GIT_LINK\"/);
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_AGY_HOOKS\"/);
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_AGY_TOOL_POLICY\"/);
  assert.match(AGY_SEATBELT_PROFILE, /param \"CC_SUITE_EGRESS_PROXY\"/);
  assert.match(AGY_SEATBELT_PROFILE, /deny file-write\*/);
  assert.match(AGY_SEATBELT_PROFILE, /deny appleevent-send/);
  assert.match(AGY_SEATBELT_PROFILE, /remote unix-socket/);
});

test("Seatbelt child environment drops ambient credentials", () => {
  const proxyEnv = {
    HTTP_PROXY: "http://127.0.0.1:7892",
    HTTPS_PROXY: "http://127.0.0.1:7892",
    ALL_PROXY: "http://127.0.0.1:7892",
    http_proxy: "http://127.0.0.1:7892",
    https_proxy: "http://127.0.0.1:7892",
    all_proxy: "http://127.0.0.1:7892",
  };
  const egressProxy = resolveAgyEgressProxy(proxyEnv);
  const childEnv = buildSeatbeltEnvironment(
    {
      HOME: "/Users/fixture",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      ...proxyEnv,
      NO_PROXY: "*",
      ANTHROPIC_API_KEY: "must-not-cross",
      CUSTOM_DEPLOY_TOKEN: "must-not-cross",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    },
    "/tmp/cc-suite-scratch",
    egressProxy
  );

  assert.equal(childEnv.HOME, "/Users/fixture");
  assert.equal(childEnv.PATH, "/usr/bin:/bin");
  assert.equal(childEnv.TMPDIR, "/tmp/cc-suite-scratch");
  assert.equal(childEnv.HTTPS_PROXY, "http://127.0.0.1:7892/");
  assert.equal(childEnv.HTTP_PROXY, "http://127.0.0.1:7892/");
  assert.equal(childEnv.ALL_PROXY, "http://127.0.0.1:7892/");
  assert.equal(childEnv.NO_PROXY, undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.CUSTOM_DEPLOY_TOKEN, undefined);
  assert.equal(childEnv.SSH_AUTH_SOCK, undefined);
});

test("AGY egress requires one credential-free loopback HTTP proxy endpoint", () => {
  const complete = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].map(
      (name) => [name, "http://127.0.0.1:7892"]
    )
  );
  assert.deepEqual(resolveAgyEgressProxy(complete), {
    url: "http://127.0.0.1:7892/",
    seatbeltRemote: "localhost:7892",
  });

  for (const env of [
    {},
    { ...complete, HTTPS_PROXY: "http://127.0.0.1:7893" },
    { ...complete, HTTPS_PROXY: "http://user:secret@127.0.0.1:7892" },
    { ...complete, HTTPS_PROXY: "https://127.0.0.1:7892" },
    { ...complete, HTTPS_PROXY: "http://proxy.example:7892" },
    { ...complete, HTTPS_PROXY: "http://127.0.0.1" },
  ]) {
    assert.throws(
      () => resolveAgyEgressProxy(env),
      (error) => error.code === "AGY_EGRESS_PROXY_UNSAFE"
    );
  }
});

test("worktree preparer creates an attributable detached checkout and rejects dirty sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-worktree-source-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);

  const prepared = createDetachedProbeWorktree({ sourcePath: source });
  t.after(() => {
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", prepared.worktreePath]);
    fs.rmSync(prepared.cleanupRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(auditDisposableWorktree(prepared.worktreePath), []);
  assert.equal(git(prepared.worktreePath, ["rev-parse", "HEAD"]), prepared.revision);

  fs.writeFileSync(path.join(source, "dirty.txt"), "dirty\n", "utf8");
  assert.throws(
    () => createDetachedProbeWorktree({ sourcePath: source }),
    (error) => error.code === "AGY_WORKTREE_SOURCE_DIRTY"
  );
});

test("worktree gate requires a clean detached linked worktree", (t) => {
  const { source, worktree } = makeDetachedWorktree(t);

  assert.ok(auditDisposableWorktree(source).includes("LINKED_WORKTREE_REQUIRED"));
  assert.deepEqual(auditDisposableWorktree(worktree), []);

  fs.writeFileSync(path.join(worktree, "dirty.txt"), "dirty\n", "utf8");
  assert.ok(auditDisposableWorktree(worktree).includes("WORKTREE_NOT_CLEAN"));
});

test("worktree gate rejects external symlinks, dangling links, and hardlinks", (t) => {
  const { root, worktree } = makeDetachedWorktree(t);
  const external = path.join(root, "external.txt");
  fs.writeFileSync(external, "outside\n", "utf8");

  fs.symlinkSync(external, path.join(worktree, "external-link"));
  fs.symlinkSync(path.join(root, "missing"), path.join(worktree, "dangling-link"));
  fs.linkSync(external, path.join(worktree, "external-hardlink"));

  const findings = auditDisposableWorktree(worktree);
  assert.ok(findings.includes("WORKTREE_EXTERNAL_SYMLINK_PRESENT"));
  assert.ok(findings.includes("WORKTREE_DANGLING_SYMLINK_PRESENT"));
  assert.ok(findings.includes("WORKTREE_HARDLINK_PRESENT"));
});

test(
  "full-process Seatbelt allows workspace writes and blocks sibling writes",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { root, worktree } = makeDetachedWorktree(t);
    const inside = path.join(worktree, "inside.txt");
    const outside = path.join(root, "outside.txt");
    const launch = createSeatbeltLaunch({
      workspacePath: worktree,
      executable: "/bin/sh",
      argv: [
        "-c",
        'printf inside > "$1"; printf outside > "$2"',
        "cc-suite-test",
        inside,
        outside,
      ],
      env: process.env,
    });
    t.after(() => {
      if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
        cleanupSeatbeltScratch(launch.scratchDir);
      }
    });

    const result = spawnSync(launch.command, launch.args, {
      cwd: worktree,
      env: launch.env,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(inside, "utf8"), "inside");
    assert.equal(fs.existsSync(outside), false);
    assert.match(result.stderr, /Operation not permitted/);
  }
);

test("isolated AGY runtime contains settings, project state, logs, and identity", (t) => {
  const { root, worktree } = makeDetachedWorktree(t);
  const installationId = path.join(root, "installation_id");
  fs.writeFileSync(installationId, "fixture-installation-id\n", "utf8");
  const launch = createSeatbeltLaunch({
    workspacePath: worktree,
    executable: "/bin/echo",
    argv: ["payload"],
    env: { ...process.env, ...fixtureProxyEnv() },
    agyRuntime: {
      projectId: "fixture-project",
      installationIdFile: installationId,
    },
  });
  t.after(() => {
    if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
      cleanupSeatbeltScratch(launch.scratchDir);
    }
  });

  const runtime = launch.isolatedRuntime;
  const canonicalWorktree = fs.realpathSync.native(worktree);
  assert.ok(runtime);
  assert.ok(launch.args.includes(`--gemini_dir=${runtime.geminiDir}`));
  assert.ok(launch.args.includes("--app_data_dir=antigravity-cli"));
  assert.ok(launch.args.includes(runtime.logFile));

  const settings = JSON.parse(fs.readFileSync(runtime.boundaryFiles.settingsFile, "utf8"));
  const project = JSON.parse(fs.readFileSync(runtime.boundaryFiles.projectFile, "utf8"));
  const mcpConfig = JSON.parse(
    fs.readFileSync(runtime.boundaryFiles.mcpConfigFile, "utf8")
  );
  const pluginsConfig = JSON.parse(
    fs.readFileSync(runtime.boundaryFiles.pluginsConfigFile, "utf8")
  );
  const hooksConfig = JSON.parse(
    fs.readFileSync(runtime.boundaryFiles.hooksConfigFile, "utf8")
  );
  assert.deepEqual(settings.trustedWorkspaces, [canonicalWorktree]);
  assert.deepEqual(settings.permissions.allow, [`write_file(${canonicalWorktree})`]);
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.equal(project.id, "fixture-project");
  assert.equal(project.projectResources.resources.length, 1);
  assert.deepEqual(mcpConfig, { mcpServers: {} });
  assert.deepEqual(pluginsConfig, { entries: [], inherits: [] });
  const hook = hooksConfig["cc-suite-r9-deny-all"];
  assert.equal(hook.enabled, true);
  assert.equal(hook.PreToolUse[0].matcher, "*");
  assert.equal(hook.PreToolUse[0].hooks[0].type, "command");
  assert.equal(hook.PreToolUse[0].hooks[0].timeout, 5);
  assert.match(hook.PreToolUse[0].hooks[0].command, /agy-tool-policy\.mjs/);
  assert.match(
    fs.readFileSync(runtime.boundaryFiles.toolPolicyFile, "utf8"),
    /CC_SUITE_R9_POLICY_DENY/
  );
  assert.equal(fs.statSync(runtime.boundaryFiles.hooksConfigFile).mode & 0o777, 0o400);
  assert.equal(fs.statSync(runtime.boundaryFiles.toolPolicyFile).mode & 0o777, 0o400);
  assert.equal(
    fs.readFileSync(path.join(runtime.geminiDir, "antigravity-cli", "installation_id"), "utf8"),
    "fixture-installation-id\n"
  );
});

test(
  "Seatbelt keeps the R9 hook configuration and policy immutable",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { root, worktree } = makeDetachedWorktree(t);
    const installationId = path.join(root, "installation_id");
    fs.writeFileSync(installationId, "fixture-installation-id\n", "utf8");
    const proxyEnv = fixtureProxyEnv();
    const launch = createSeatbeltLaunch({
      workspacePath: worktree,
      executable: "/bin/sh",
      argv: [
        "-c",
        'chmod 600 "$1"; printf tampered > "$1"; chmod 600 "$2"; printf tampered > "$2"',
        "r9-tamper",
      ],
      env: { ...process.env, ...proxyEnv },
      agyRuntime: {
        projectId: "fixture-project",
        installationIdFile: installationId,
      },
    });
    t.after(() => {
      if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
        cleanupSeatbeltScratch(launch.scratchDir);
      }
    });
    const { hooksConfigFile, toolPolicyFile } = launch.isolatedRuntime.boundaryFiles;
    const executableIndex = launch.args.indexOf("/bin/sh");
    const tamperArgs = [
      ...launch.args.slice(0, executableIndex),
      "/bin/sh",
      "-c",
      'chmod 600 "$1"; printf tampered > "$1"; chmod 600 "$2"; printf tampered > "$2"',
      "r9-tamper",
      hooksConfigFile,
      toolPolicyFile,
    ];
    const hooksBefore = fs.readFileSync(hooksConfigFile, "utf8");
    const policyBefore = fs.readFileSync(toolPolicyFile, "utf8");
    const result = spawnSync(launch.command, tamperArgs, {
      cwd: worktree,
      env: launch.env,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(hooksConfigFile, "utf8"), hooksBefore);
    assert.equal(fs.readFileSync(toolPolicyFile, "utf8"), policyBefore);
    assert.match(result.stderr, /Operation not permitted/);
  }
);

test(
  "Seatbelt permits only the declared TCP proxy endpoint",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const listen = () =>
      new Promise((resolve) => {
        const server = net.createServer((socket) => socket.end());
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    const allowedServer = await listen();
    const deniedServer = await listen();
    t.after(() => {
      allowedServer.close();
      deniedServer.close();
    });
    const connect = (port) =>
      new Promise((resolve) => {
        const code = `const n=require("net").connect(${port},"127.0.0.1");n.on("connect",()=>{n.end();process.exit(0)});n.on("error",()=>process.exit(7))`;
        const child = spawn("/usr/bin/sandbox-exec", [
          "-D",
          `CC_SUITE_WORKSPACE=${os.tmpdir()}`,
          "-D",
          `CC_SUITE_SCRATCH=${os.tmpdir()}`,
          "-D",
          `CC_SUITE_GIT_LINK=${path.join(os.tmpdir(), "missing-git-link")}`,
          "-D",
          `CC_SUITE_AGY_HOOKS=${path.join(os.tmpdir(), "missing-hooks")}`,
          "-D",
          `CC_SUITE_AGY_TOOL_POLICY=${path.join(os.tmpdir(), "missing-policy")}`,
          "-D",
          `CC_SUITE_EGRESS_PROXY=localhost:${allowedServer.address().port}`,
          "-p",
          AGY_SEATBELT_PROFILE,
          process.execPath,
          "-e",
          code,
        ]);
        child.on("close", (status) => resolve(status));
      });

    assert.equal(await connect(allowedServer.address().port), 0);
    assert.equal(await connect(deniedServer.address().port), 7);
  }
);

test(
  "Seatbelt inheritance blocks descendant writes and external hardlink creation",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { root, worktree } = makeDetachedWorktree(t);
    const external = path.join(root, "external.txt");
    const linked = path.join(worktree, "linked.txt");
    fs.writeFileSync(external, "outside\n", "utf8");

    const launch = createSeatbeltLaunch({
      workspacePath: worktree,
      executable: "/bin/sh",
      argv: [
        "-c",
        '/bin/sh -c \'/bin/ln "$1" "$2"\' cc-suite-child "$1" "$2"',
        "cc-suite-outer",
        external,
        linked,
      ],
      env: process.env,
    });
    t.after(() => {
      if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
        cleanupSeatbeltScratch(launch.scratchDir);
      }
    });

    const result = spawnSync(launch.command, launch.args, {
      cwd: worktree,
      env: launch.env,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(linked), false);
    assert.equal(fs.readFileSync(external, "utf8"), "outside\n");
  }
);

test(
  "Seatbelt keeps the linked-worktree .git pointer immutable",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { worktree } = makeDetachedWorktree(t);
    const gitLink = path.join(worktree, ".git");
    const original = fs.readFileSync(gitLink, "utf8");
    const launch = createSeatbeltLaunch({
      workspacePath: worktree,
      executable: "/bin/sh",
      argv: ["-c", 'printf corrupted > "$PWD/.git"'],
      env: process.env,
    });
    t.after(() => {
      if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
        cleanupSeatbeltScratch(launch.scratchDir);
      }
    });

    const result = spawnSync(launch.command, launch.args, {
      cwd: worktree,
      env: launch.env,
      encoding: "utf8",
    });
    const observed = fs.readFileSync(gitLink, "utf8");
    // Repair the fixture outside Seatbelt so test cleanup remains reliable even
    // while this test is RED against an unprotected profile.
    fs.writeFileSync(gitLink, original, "utf8");

    assert.notEqual(result.status, 0);
    assert.equal(observed, original);
    assert.match(result.stderr, /Operation not permitted/);
  }
);

test(
  "Seatbelt blocks unlinking or replacing the linked-worktree .git pointer",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { worktree } = makeDetachedWorktree(t);
    const gitLink = path.join(worktree, ".git");
    const original = fs.readFileSync(gitLink, "utf8");
    const launch = createSeatbeltLaunch({
      workspacePath: worktree,
      executable: "/bin/sh",
      argv: [
        "-c",
        'rm -f "$PWD/.git"; printf replacement > replacement.git; mv -f replacement.git "$PWD/.git"',
      ],
      env: process.env,
    });
    t.after(() => {
      if (launch.scratchDir && fs.existsSync(launch.scratchDir)) {
        cleanupSeatbeltScratch(launch.scratchDir);
      }
    });

    const result = spawnSync(launch.command, launch.args, {
      cwd: worktree,
      env: launch.env,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(gitLink, "utf8"), original);
    assert.match(result.stderr, /Operation not permitted/);
  }
);
