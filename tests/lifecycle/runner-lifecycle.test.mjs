import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  createLineReader,
  killBackendTree,
  livingGroupMembers,
  spawnBackend,
  superviseBackend,
} from "../../scripts/lib/runner-lifecycle.mjs";
import { finalizeJob, upsertJob, listJobs, readJobFile, resolveJobFile } from "../../scripts/lib/state.mjs";
import { finalizedOutcome } from "../../scripts/lib/runner-lifecycle.mjs";
import path from "node:path";
import { makeTempDir, cleanupDir } from "../helpers.mjs";

const NL = String.fromCharCode(10);

// A shell that starts a SIGTERM-ignoring grandchild. The grandchild inherits
// stdout, so the pipe stays open after the shell itself exits.
const TREE_SCRIPT = "trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & echo started; wait";

// Every process group a test starts is recorded here and SIGKILLed after the
// test, whether it passed, failed an assertion, or timed out — a regression
// must fail the test, not leave SIGTERM-resistant processes on the machine.
const groups = new Set();
afterEach(() => {
  for (const pgid of groups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  }
  groups.clear();
});

function spawnTracked(command, args) {
  const spawned = spawnBackend(command, args);
  if (spawned.child.pid) groups.add(spawned.child.pid);
  return spawned;
}

// A wait on a child that can never settle would hang the file; give up after
// `ms` instead (afterEach then kills the group).
function within(promise, ms = 10000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no settle within ${ms}ms`)), ms); }),
  ]);
}

function waitFor(predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const stopAt = Date.now() + ms;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > stopAt) return reject(new Error("timed out waiting"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("killBackendTree kills a SIGTERM-resistant descendant, not just the direct child", { timeout: 20000 }, async () => {
  const { child, release } = spawnTracked("sh", ["-c", TREE_SCRIPT]);
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  await waitFor(() => out.includes("started"));
  assert.ok(livingGroupMembers(child.pid).length >= 2, "expected shell + grandchild in the group");
  const remaining = killBackendTree(child.pid, { graceMs: 300 });
  release();
  assert.deepEqual(remaining, []);
  assert.deepEqual(livingGroupMembers(child.pid), []);
});

test("superviseBackend settles when the child exits but a descendant holds the pipes", { timeout: 20000 }, async () => {
  // The shell exits at once; the backgrounded grandchild keeps stdout open, so
  // without the drain window `close` never fires.
  const { child, release } = spawnTracked("sh", ["-c", "(trap '' TERM; while :; do sleep 1; done) & echo bye"]);
  let drained = false;
  const closed = new Promise((resolve) => child.on("close", resolve));
  const supervisor = superviseBackend(child, {
    timeoutMs: 60000, release, drainMs: 200,
    onDrain: () => { drained = true; },
    onError: (e) => { throw e; },
  });
  const started = Date.now();
  await within(closed);
  supervisor.dispose();
  assert.ok(drained, "drain window should have fired");
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(livingGroupMembers(child.pid), []);
});

test("superviseBackend deadline kills the tree and lets close fire", { timeout: 20000 }, async () => {
  const { child, release } = spawnTracked("sh", ["-c", TREE_SCRIPT]);
  let timedOut = false;
  const closed = new Promise((resolve) => child.on("close", resolve));
  const supervisor = superviseBackend(child, {
    timeoutMs: 200, release,
    onDeadline: () => { timedOut = true; },
    onError: (e) => { throw e; },
  });
  await within(closed);
  supervisor.dispose();
  assert.ok(timedOut);
  assert.deepEqual(livingGroupMembers(child.pid), []);
});

test("a throwing deadline callback is reported through onError", { timeout: 20000 }, async () => {
  const { child, release } = spawnTracked("sh", ["-c", "sleep 30"]);
  const errored = new Promise((resolve) => {
    const supervisor = superviseBackend(child, {
      timeoutMs: 50, release,
      onDeadline: () => { throw new Error("ENOSPC: no space left"); },
      onError: (e) => { supervisor.dispose(); resolve(e); },
    });
  });
  const err = await within(errored);
  assert.match(err.message, /ENOSPC/);
  assert.deepEqual(livingGroupMembers(child.pid), []);
});

test("createLineReader keeps a multi-byte character split across chunks intact", { timeout: 20000 }, () => {
  const lines = [];
  const reader = createLineReader((l) => lines.push(l));
  const bytes = Buffer.from(`{"t":"中文"}${NL}尾`, "utf8");
  // Split inside the three-byte encoding of 中.
  const cut = bytes.indexOf(0xe4) + 1;
  reader.write(bytes.subarray(0, cut));
  reader.write(bytes.subarray(cut));
  reader.end();
  assert.deepEqual(lines, ['{"t":"中文"}', "尾"]);
});

test("finalizeJob will not overwrite a job cancelled while the backend ran", { timeout: 20000 }, () => {
  const dir = makeTempDir("finalize-");
  const stateDir = makeTempDir("finalize-state-");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = stateDir;
  try {
    upsertJob(dir, { id: "mimo-a-1", kind: "mimo", status: "running" });
    upsertJob(dir, { id: "mimo-a-1", status: "cancelled" });
    const refused = finalizeJob(dir, "mimo-a-1", { status: "completed" }, { rawOutput: "late" });
    assert.deepEqual(refused, { committed: false, status: "cancelled" });
    assert.equal(listJobs(dir).find((j) => j.id === "mimo-a-1").status, "cancelled");
    assert.equal(fs.existsSync(resolveJobFile(dir, "mimo-a-1")), false);

    upsertJob(dir, { id: "mimo-b-2", kind: "mimo", status: "running" });
    const ok = finalizeJob(dir, "mimo-b-2", { status: "completed" }, { rawOutput: "ANSWER" });
    assert.deepEqual(ok, { committed: true, status: "completed" });
    assert.equal(readJobFile(resolveJobFile(dir, "mimo-b-2")).rawOutput, "ANSWER");

    assert.deepEqual(finalizeJob(dir, "mimo-c-3", { status: "completed" }), { committed: false, status: null });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
    cleanupDir(dir);
    cleanupDir(stateDir);
  }
});

test("an unwritable result file commits the job as failed, never as completed", { timeout: 20000 }, () => {
  const dir = makeTempDir("finalize-rf-");
  const stateDir = makeTempDir("finalize-rf-state-");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = stateDir;
  const jobsDir = () => path.dirname(resolveJobFile(dir, "mimo-rf-1"));
  try {
    upsertJob(dir, { id: "mimo-rf-1", kind: "mimo", status: "running" });
    fs.chmodSync(jobsDir(), 0o500);
    const finalized = finalizeJob(dir, "mimo-rf-1", { status: "completed" }, { rawOutput: "ANSWER" });
    fs.chmodSync(jobsDir(), 0o700);
    assert.equal(finalized.committed, true);
    assert.equal(finalized.status, "failed");
    assert.ok(finalized.resultFileError);
    const job = listJobs(dir).find((j) => j.id === "mimo-rf-1");
    assert.equal(job.status, "failed");
    assert.match(job.errorMessage, /result file could not be written/);
    assert.equal(fs.existsSync(resolveJobFile(dir, "mimo-rf-1")), false);
    const outcome = finalizedOutcome(finalized, { status: "completed", rawOutput: "ANSWER" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.rawOutput, "");
  } finally {
    try { fs.chmodSync(jobsDir(), 0o700); } catch {}
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
    cleanupDir(dir);
    cleanupDir(stateDir);
  }
});
