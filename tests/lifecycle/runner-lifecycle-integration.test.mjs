// End-to-end lifecycle checks for the runners that share lib/job-runner.mjs
// and lib/runner-lifecycle.mjs. Each test drives a real runner process against
// a fake backend that ignores SIGTERM and leaves a SIGTERM-ignoring grandchild,
// then checks what actually happened to the processes and the job record.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "../helpers.mjs";
import { listJobs, resolveJobFile, upsertJob } from "../../scripts/lib/state.mjs";
import { cancelJob } from "../../scripts/lib/job-control.mjs";
import { processAlive } from "../../scripts/lib/process.mjs";

const TEST_TIMEOUT = { timeout: 30000 };

const SCRIPTS = fileURLToPath(new URL("../../scripts/", import.meta.url));
const NL = String.fromCharCode(10);

// How each runner finds its backend binary.
const RUNNERS = {
  qoder: { bin: "qoder" },
  zcode: { bin: "zcode", env: "ZCODE_BIN" },
  doubao: { bin: "doubao", env: "DOUBAO_BIN" },
  mimo: { bin: "mimo", env: "MIMO_BIN" },
  codebuddy: { bin: "codebuddy" },
  hermes: { bin: "hermes" },
};

// FAKE_MODE:
//   hang          start a SIGTERM-ignoring grandchild, ignore SIGTERM, never answer
//   mimo-orphan   print a mimo answer, leave a grandchild holding stdout, exit 0
//   mimo-split    print a mimo answer whose 中 is split across two writes
//   mimo-stderr   write to stderr every 100ms, never answer
//   escaped-stderr  like mimo-stderr, but the grandchild calls setsid (leaves
//                 the backend's process group) and keeps stdout open, so no
//                 group kill can reach it and only closing the pipes frees the runner
//   epipe         close stdin, then send a JSON-RPC request the runner must
//                 answer: the answer is written to a pipe with no reader
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const { spawn } = require("child_process");
const NL = String.fromCharCode(10);
const mode = process.env.FAKE_MODE || "hang";
if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, String(process.pid));
function grandchild(stdio, detached = false) {
  const g = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio, detached });
  fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(g.pid));
  return g;
}
const event = (text) => JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text } }) + NL;
if (mode === "epipe") {
  fs.closeSync(0);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "x/ping", params: {} }) + NL);
  setInterval(() => {}, 1000);
}
if (mode === "hang") {
  grandchild(["ignore", "inherit", "inherit"]);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "mimo-orphan") {
  process.stdout.write(event("ORPHAN OK"));
  grandchild(["ignore", "inherit", "inherit"]).unref();
  setTimeout(() => process.exit(0), 50);
} else if (mode === "mimo-split") {
  const bytes = Buffer.from(event("中文答案"), "utf8");
  const cut = bytes.indexOf(0xe4) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => { process.stdout.write(bytes.subarray(cut)); setTimeout(() => process.exit(0), 20); }, 150);
} else if (mode === "mimo-stderr") {
  grandchild(["ignore", "ignore", "ignore"]);
  setInterval(() => process.stderr.write("tick" + NL), 100);
} else if (mode === "escaped-stderr") {
  grandchild(["ignore", "inherit", "ignore"], true).unref();
  setInterval(() => process.stderr.write("tick" + NL), 100);
}
`;

function setup(backend) {
  const workspace = fs.realpathSync(makeTempDir(`${backend}-life-`));
  const stateDir = makeTempDir(`${backend}-life-state-`);
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir);
  const bin = path.join(binDir, RUNNERS[backend].bin);
  writeExecutable(bin, FAKE);
  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
    CLAUDE_PLUGIN_DATA: stateDir,
    CODEX_TOOLKIT_SESSION_ID: "",
    CODEX_TOOLKIT_BACKGROUND_JOB_ID: "",
    FAKE_MARKER: path.join(workspace, "marker"),
    FAKE_GRANDCHILD: path.join(workspace, "grandchild.pid"),
    ...(RUNNERS[backend].env ? { [RUNNERS[backend].env]: bin } : {}),
  };
  return {
    workspace, stateDir, env,
    runnerArgs: (extra = []) => [path.join(SCRIPTS, `${backend}-runner.mjs`), "--kind", backend, ...extra, "--", "hi"],
    cleanup() {
      // The backend leads its own process group (marker pid = pgid), so kill
      // the whole group, then the recorded grandchild in case it escaped.
      try { process.kill(-Number(fs.readFileSync(env.FAKE_MARKER, "utf8")), "SIGKILL"); } catch { /* gone or never started */ }
      try { process.kill(Number(fs.readFileSync(env.FAKE_GRANDCHILD, "utf8")), "SIGKILL"); } catch { /* gone or never started */ }
      for (const pgid of this.groups) {
        try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
      }
      for (const child of this.children) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* exited */ }
      }
      cleanupDir(workspace);
      cleanupDir(stateDir);
    },
    children: [],
    groups: [],
  };
}

// State helpers read the same CLAUDE_PLUGIN_DATA the runner writes to.
function withState(ctx, fn) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = ctx.stateDir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

function waitFor(predicate, ms = 10000) {
  return new Promise((resolve, reject) => {
    const stopAt = Date.now() + ms;
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > stopAt) return reject(new Error("timed out waiting"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function startRunner(ctx, extra = [], env = {}) {
  const child = spawn(process.execPath, ctx.runnerArgs(extra), { cwd: ctx.workspace, env: { ...ctx.env, ...env } });
  ctx.children.push(child);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c; });
  const done = settleWithin(new Promise((resolve) => child.on("close", (code) => {
    const line = stdout.trim().split(NL).filter(Boolean).pop();
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* reported by the assertion */ }
    resolve({ code, parsed, stdout });
  })), child);
  return { child, done };
}

const pidFrom = (file) => Number(fs.readFileSync(file, "utf8"));

// node:test's per-test timeout cancels the test but not the child processes it
// is waiting on, so an open pipe would keep the file running forever. Every
// wait on a child goes through this: it kills the child and rejects instead.
function settleWithin(promise, child, ms = 20000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* exited */ }
        reject(new Error(`child ${child.pid} did not exit within ${ms}ms`));
      }, ms);
    }),
  ]);
}

for (const backend of Object.keys(RUNNERS)) {
  test(`${backend}: /cancel kills the runner and a SIGTERM-resistant backend tree, and the job stays cancelled`, TEST_TIMEOUT, async () => {
    const ctx = setup(backend);
    try {
      const { child, done } = startRunner(ctx, ["--timeout-ms", "60000"]);
      await waitFor(() => fs.existsSync(ctx.env.FAKE_GRANDCHILD));
      const job = withState(ctx, () => listJobs(ctx.workspace)[0]);
      assert.ok(job.pidStartedAt, "running record must carry pidStartedAt");

      const cancelled = withState(ctx, () => cancelJob(ctx.workspace, job.id));
      assert.equal(cancelled.terminated, true, JSON.stringify(cancelled));
      await done;
      assert.equal(processAlive(child.pid), false);
      assert.equal(processAlive(pidFrom(ctx.env.FAKE_MARKER)), false, "backend survived");
      assert.equal(processAlive(pidFrom(ctx.env.FAKE_GRANDCHILD)), false, "grandchild survived");
      const after = withState(ctx, () => listJobs(ctx.workspace).find((j) => j.id === job.id));
      assert.equal(after.status, "cancelled");
      assert.equal(withState(ctx, () => fs.existsSync(resolveJobFile(ctx.workspace, job.id))), false);
    } finally { ctx.cleanup(); }
  });

  test(`${backend}: a job cancelled while queued is not resurrected by its worker`, TEST_TIMEOUT, () => {
    const ctx = setup(backend);
    try {
      const jobId = `${backend}-queued-1`;
      withState(ctx, () => upsertJob(ctx.workspace, { id: jobId, kind: backend, status: "cancelled" }));
      const r = spawnSync(process.execPath, ctx.runnerArgs(["--timeout-ms", "60000"]), {
        cwd: ctx.workspace, encoding: "utf8", timeout: 15000,
        env: { ...ctx.env, CODEX_TOOLKIT_BACKGROUND_JOB_ID: jobId },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(ctx.env.FAKE_MARKER), false, "backend must not start");
      assert.equal(withState(ctx, () => listJobs(ctx.workspace).find((j) => j.id === jobId).status), "cancelled");
    } finally { ctx.cleanup(); }
  });

  test(`${backend}: a worker whose queued record was removed exits without recreating its log`, TEST_TIMEOUT, () => {
    const ctx = setup(backend);
    try {
      // SessionEnd drops queued records (and their logs); a late worker must
      // neither start the backend nor leave an orphan log behind.
      const jobId = `${backend}-gone-1`;
      const logFile = withState(ctx, () => path.join(path.dirname(resolveJobFile(ctx.workspace, jobId)), `${jobId}.log`));
      const r = spawnSync(process.execPath, ctx.runnerArgs(["--timeout-ms", "60000"]), {
        cwd: ctx.workspace, encoding: "utf8", timeout: 15000,
        env: { ...ctx.env, CODEX_TOOLKIT_BACKGROUND_JOB_ID: jobId },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(ctx.env.FAKE_MARKER), false, "backend must not start");
      assert.equal(fs.existsSync(logFile), false, "orphan log recreated");
      assert.equal(withState(ctx, () => listJobs(ctx.workspace).length), 0, "record resurrected");
    } finally { ctx.cleanup(); }
  });

  test(`${backend}: the deadline kills the whole backend tree and reports stalled`, TEST_TIMEOUT, async () => {
    const ctx = setup(backend);
    try {
      const { done } = startRunner(ctx, ["--timeout-ms", "1500"]);
      const { parsed, stdout } = await done;
      assert.ok(parsed, stdout);
      assert.equal(parsed.status, "stalled", JSON.stringify(parsed));
      assert.equal(processAlive(pidFrom(ctx.env.FAKE_MARKER)), false, "backend survived the deadline");
      assert.equal(processAlive(pidFrom(ctx.env.FAKE_GRANDCHILD)), false, "grandchild survived the deadline");
    } finally { ctx.cleanup(); }
  });
}

test("mimo: a descendant holding stdout does not keep the runner from settling", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    const started = Date.now();
    const { done } = startRunner(ctx, ["--timeout-ms", "60000"], { FAKE_MODE: "mimo-orphan" });
    const { parsed, stdout } = await done;
    assert.ok(parsed, stdout);
    assert.equal(parsed.status, "completed", JSON.stringify(parsed));
    assert.equal(parsed.rawOutput, "ORPHAN OK");
    assert.ok(Date.now() - started < 15000, "runner waited on the orphan's pipe");
    assert.equal(processAlive(pidFrom(ctx.env.FAKE_GRANDCHILD)), false, "orphan survived");
  } finally { ctx.cleanup(); }
});

test("mimo: a character split across stdout chunks arrives intact", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    const { done } = startRunner(ctx, ["--timeout-ms", "60000"], { FAKE_MODE: "mimo-split" });
    const { parsed, stdout } = await done;
    assert.ok(parsed, stdout);
    assert.equal(parsed.rawOutput, "中文答案");
  } finally { ctx.cleanup(); }
});

test("mimo: a log write failure fails the job and kills the backend instead of stranding it", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    const { done } = startRunner(ctx, ["--timeout-ms", "60000"], { FAKE_MODE: "mimo-stderr" });
    await waitFor(() => fs.existsSync(ctx.env.FAKE_GRANDCHILD));
    const job = withState(ctx, () => listJobs(ctx.workspace)[0]);
    fs.chmodSync(job.logFile, 0o400);
    const { parsed, stdout } = await done;
    assert.ok(parsed, stdout);
    assert.equal(parsed.status, "failed", JSON.stringify(parsed));
    assert.match(parsed.error, /Runner callback failed/);
    assert.equal(processAlive(pidFrom(ctx.env.FAKE_GRANDCHILD)), false, "backend tree survived");
    assert.equal(withState(ctx, () => listJobs(ctx.workspace)[0].status), "failed");
  } finally { ctx.cleanup(); }
});

for (const backend of ["codebuddy", "hermes"]) {
  test(`${backend}: a write to an agent that closed its stdin (EPIPE) fails the job cleanly`, TEST_TIMEOUT, async () => {
    const ctx = setup(backend);
    try {
      const { done } = startRunner(ctx, ["--timeout-ms", "60000"], { FAKE_MODE: "epipe" });
      const { parsed, stdout, code } = await done;
      assert.ok(parsed, stdout);
      assert.equal(parsed.status, "failed", JSON.stringify(parsed));
      assert.match(parsed.error, /EPIPE/, "the failure must come from the broken pipe");
      assert.equal(code, 1);
      assert.equal(withState(ctx, () => listJobs(ctx.workspace)[0].status), "failed");
    } finally { ctx.cleanup(); }
  });
}

const LIFECYCLE = fileURLToPath(new URL("../../scripts/lib/runner-lifecycle.mjs", import.meta.url));
const JOB_RUNNER = fileURLToPath(new URL("../../scripts/lib/job-runner.mjs", import.meta.url));
const STATE = fileURLToPath(new URL("../../scripts/lib/state.mjs", import.meta.url));

test("a SIGTERM that lands during dispose() does not leave the backend alive", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    // dispose() kills a SIGTERM-resistant tree, which takes the full grace
    // period; the signal arrives 100ms into it.
    const script = path.join(ctx.workspace, "dispose.mjs");
    fs.writeFileSync(script, [
      'import fs from "node:fs";',
      `import { spawnBackend, superviseBackend } from ${JSON.stringify(LIFECYCLE)};`,
      `const { child, release } = spawnBackend("sh", ["-c", "trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & echo started; wait"]);`,
      "const sup = superviseBackend(child, { timeoutMs: 60000, release, onError: (e) => { throw e; } });",
      'child.stdout.once("data", () => {',
      '  fs.writeSync(1, "DISPOSING " + child.pid + String.fromCharCode(10));',
      "  sup.dispose();",
      '  fs.writeSync(1, "DISPOSED" + String.fromCharCode(10));',
      "});",
      "setInterval(() => {}, 1000);",
    ].join(NL));
    const runner = spawn(process.execPath, [script], { cwd: ctx.workspace });
    ctx.children.push(runner);
    let out = "";
    runner.stdout.on("data", (c) => { out += c; });
    await waitFor(() => /DISPOSING (\d+)/.test(out));
    const pgid = Number(out.match(/DISPOSING (\d+)/)[1]);
    ctx.groups.push(pgid);
    await new Promise((r) => setTimeout(r, 100));
    runner.kill("SIGTERM");
    // The runner must die from the signal, not hang with it dropped.
    const exit = await settleWithin(new Promise((r) => runner.on("close", (code, signal) => r({ code, signal }))), runner);
    assert.equal(exit.signal, "SIGTERM", JSON.stringify(exit));
    const { livingGroupMembers } = await import(LIFECYCLE);
    assert.deepEqual(livingGroupMembers(pgid), [], "backend group survived a signal during dispose");
  } finally { ctx.cleanup(); }
});

test("a crash after the job was cancelled reports cancelled, matching the state file", TEST_TIMEOUT, () => {
  const ctx = setup("mimo");
  try {
    const script = path.join(ctx.workspace, "crash-runner.mjs");
    fs.writeFileSync(script, [
      `import { runJobMain } from ${JSON.stringify(JOB_RUNNER)};`,
      `import { listJobs, upsertJob } from ${JSON.stringify(STATE)};`,
      "runJobMain({",
      '  args: { kind: "mimo", prompt: "hi", sandbox: "read-only", timeoutMs: 60000 },',
      '  label: "crash-test",',
      "  scriptPath: import.meta.url,",
      "  execute: async (cwd) => {",
      "    const job = listJobs(cwd)[0];",
      '    upsertJob(cwd, { id: job.id, status: "cancelled" });',
      '    throw new Error("backend exploded");',
      "  },",
      "});",
    ].join(NL));
    const r = spawnSync(process.execPath, [script], { cwd: ctx.workspace, env: ctx.env, encoding: "utf8", timeout: 15000 });
    const parsed = JSON.parse(r.stdout.trim().split(NL).pop());
    assert.equal(parsed.status, "cancelled", JSON.stringify(parsed));
    assert.equal(withState(ctx, () => listJobs(ctx.workspace)[0].status), "cancelled");
  } finally { ctx.cleanup(); }
});

test("a callback error while an escaped descendant holds stdout still ends the runner", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    const { done } = startRunner(ctx, ["--timeout-ms", "60000"], { FAKE_MODE: "escaped-stderr" });
    await waitFor(() => fs.existsSync(ctx.env.FAKE_GRANDCHILD));
    const job = withState(ctx, () => listJobs(ctx.workspace)[0]);
    fs.chmodSync(job.logFile, 0o400);
    // Regression: the error path disposed without closing the pipes, so the
    // escaped holder kept the runner's stdout handle open and it never exited.
    const { parsed, stdout } = await done;
    assert.ok(parsed, stdout);
    assert.equal(parsed.status, "failed", JSON.stringify(parsed));
    assert.match(parsed.error, /Runner callback failed/);
  } finally { ctx.cleanup(); }
});

test("a backend that answered and exited is not stalled by a deadline during the drain", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    // The deadline (1000ms) falls inside the 2000ms drain window that starts
    // when the backend exits with its answer and an orphan holds the pipe.
    const { done } = startRunner(ctx, ["--timeout-ms", "1000"], { FAKE_MODE: "mimo-orphan" });
    const { parsed, stdout } = await done;
    assert.ok(parsed, stdout);
    assert.equal(parsed.status, "completed", JSON.stringify(parsed));
    assert.equal(parsed.rawOutput, "ORPHAN OK");
    assert.equal(processAlive(pidFrom(ctx.env.FAKE_GRANDCHILD)), false, "orphan survived");
  } finally { ctx.cleanup(); }
});

test("after dispose, a late signal is re-raised without signalling any process group", TEST_TIMEOUT, async () => {
  const ctx = setup("mimo");
  try {
    // By the time a late signal arrives the backend's pgid may belong to an
    // unrelated process, so the handler must not attempt a tree kill at all.
    const record = path.join(ctx.workspace, "late-kills.txt");
    const script = path.join(ctx.workspace, "late-signal.mjs");
    fs.writeFileSync(script, [
      'import fs from "node:fs";',
      `import { killBackendTree, spawnBackend, superviseBackend } from ${JSON.stringify(LIFECYCLE)};`,
      "let disposed = false;",
      "// Record any tree kill the forwarding handler attempts after dispose.",
      "const killTree = (pid) => {",
      `  if (disposed) fs.appendFileSync(${JSON.stringify(record)}, String(pid) + String.fromCharCode(10));`,
      "  return killBackendTree(pid);",
      "};",
      'const { child, release } = spawnBackend("sh", ["-c", "echo started; sleep 0.2"], { killTree });',
      "const sup = superviseBackend(child, { timeoutMs: 60000, release, onError: (e) => { throw e; } });",
      'child.on("close", () => {',
      "  sup.dispose();",
      "  disposed = true;",
      '  fs.writeSync(1, "DISPOSED" + String.fromCharCode(10));',
      "});",
      "setInterval(() => {}, 1000);",
    ].join(NL));
    const runner = spawn(process.execPath, [script], { cwd: ctx.workspace });
    ctx.children.push(runner);
    let out = "";
    runner.stdout.on("data", (c) => { out += c; });
    await waitFor(() => out.includes("DISPOSED"));
    runner.kill("SIGTERM");
    const exit = await settleWithin(new Promise((r) => runner.on("close", (code, signal) => r({ code, signal }))), runner);
    assert.equal(exit.signal, "SIGTERM", "the late signal must still end the runner");
    assert.equal(fs.existsSync(record), false, `tree kill attempted after dispose: ${fs.existsSync(record) ? fs.readFileSync(record, "utf8") : ""}`);
  } finally { ctx.cleanup(); }
});
