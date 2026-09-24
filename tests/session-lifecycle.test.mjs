import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, isolateEnv } from "./helpers.mjs";
import { claimJob, listJobs, upsertJob } from "../scripts/lib/state.mjs";
import { TERM_CONFIRM_MS } from "../scripts/lib/job-control.mjs";
import { KILL_GRACE_MS } from "../scripts/lib/runner-lifecycle.mjs";

const HOOK = fileURLToPath(
  new URL("../scripts/session-lifecycle-hook.mjs", import.meta.url)
);

// The hook resolves state from the environment; isolate so an ambient
// CLAUDE_PLUGIN_DATA / session id from the developer's own session cannot
// redirect these fixtures.
let restoreEnv;
before(() => {
  restoreEnv = isolateEnv();
});
after(() => {
  restoreEnv?.();
});

function runSessionEnd(workspace, sessionId) {
  return spawnSync(process.execPath, [HOOK, "SessionEnd"], {
    cwd: workspace,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: workspace,
      session_id: sessionId,
    }),
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("SessionEnd drops terminal jobs for the ending session", () => {
  const workspace = makeTempDir();
  try {
    upsertJob(workspace, {
      id: "done-1",
      kind: "audit",
      status: "completed",
      sessionId: "sess-a",
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listJobs(workspace), []);
  } finally {
    cleanupDir(workspace);
  }
});

test("SessionEnd leaves other sessions' jobs untouched", () => {
  const workspace = makeTempDir();
  try {
    upsertJob(workspace, {
      id: "other-1",
      kind: "audit",
      status: "running",
      sessionId: "sess-b",
      pid: 999999999,
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "other-1");
    assert.equal(jobs[0].status, "running");
  } finally {
    cleanupDir(workspace);
  }
});

test("SessionEnd drops an active job whose process is already gone", () => {
  const workspace = makeTempDir();
  try {
    upsertJob(workspace, {
      id: "dead-1",
      kind: "audit",
      status: "running",
      sessionId: "sess-a",
      pid: 999999999, // not a live pid
      pidStartedAt: "Mon Jan  1 00:00:00 2020",
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listJobs(workspace), []);
  } finally {
    cleanupDir(workspace);
  }
});

test("a job retained because its exit is unconfirmed survives the next SessionEnd too", () => {
  const workspace = makeTempDir();
  try {
    // A live pid without pidStartedAt is unverifiable: the hook cannot prove
    // the process is ours, so it must neither signal it nor drop its record.
    upsertJob(workspace, {
      id: "unverifiable-1",
      kind: "audit",
      status: "running",
      sessionId: "sess-b",
      pid: process.pid,
    });
    assert.equal(runSessionEnd(workspace, "sess-b").status, 0);
    let job = listJobs(workspace).find((j) => j.id === "unverifiable-1");
    assert.equal(job.status, "cancelled");
    assert.equal(job.terminationConfirmed, false, "retained job must be flagged for re-checking");

    // Regression: without the flag the second SessionEnd treated the record as
    // an ordinary finished job and dropped it while the process still ran.
    assert.equal(runSessionEnd(workspace, "sess-b").status, 0);
    job = listJobs(workspace).find((j) => j.id === "unverifiable-1");
    assert.ok(job, "a possibly-live job must not disappear on the next SessionEnd");
  } finally {
    cleanupDir(workspace);
  }
});

test("SessionEnd drops a queued job atomically so its worker never starts a backend", () => {
  const workspace = makeTempDir();
  try {
    upsertJob(workspace, {
      id: "queued-1",
      kind: "audit",
      status: "queued",
      sessionId: "sess-a",
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(listJobs(workspace).length, 0, "a never-started job leaves no stale record");
    // Regression: the hook snapshotted the queued job, signalled "no pid", and a
    // worker claiming it in between started a backend nobody terminated. With
    // the record gone the claim is refused and the backend never starts.
    assert.equal(claimJob(workspace, "queued-1", { status: "running" }), false);
  } finally {
    cleanupDir(workspace);
  }
});

test("SessionEnd waits long enough for a runner to finish its own tree cleanup", () => {
  // Escalating to SIGKILL on a runner mid-cleanup leaves its backend group
  // alive, so the hook uses job-control's budget instead of a shorter copy.
  const source = fs.readFileSync(HOOK, "utf8");
  assert.doesNotMatch(source, /const\s+TERM_CONFIRM_MS\s*=/, "the hook must not keep its own TERM budget");
  assert.match(source, /import \{[^}]*TERM_CONFIRM_MS[^}]*\} from "\.\/lib\/job-control\.mjs"/);
  assert.ok(TERM_CONFIRM_MS >= 2 * KILL_GRACE_MS, `TERM_CONFIRM_MS ${TERM_CONFIRM_MS} leaves no margin over KILL_GRACE_MS ${KILL_GRACE_MS}`);
});

test("SessionEnd still retains a running job with no PID as unconfirmed", () => {
  const workspace = makeTempDir();
  try {
    upsertJob(workspace, {
      id: "running-nopid",
      kind: "audit",
      status: "running",
      sessionId: "sess-a",
    });
    assert.equal(runSessionEnd(workspace, "sess-a").status, 0);
    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "a job that could not be terminated must stay visible");
    assert.equal(jobs[0].status, "cancelled");
    assert.equal(jobs[0].terminationConfirmed, false);
    assert.match(jobs[0].errorMessage, /no recorded PID/);
  } finally {
    cleanupDir(workspace);
  }
});

test("SessionEnd never signals a live PID it cannot prove is the job's own", () => {
  const workspace = makeTempDir();
  // A long-lived process standing in for an unrelated program that inherited a
  // recycled PID. The hook must not kill it.
  const bystander = spawnSync(process.execPath, [
    "-e",
    `const { spawn } = require('node:child_process');
     const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
     c.unref();
     process.stdout.write(String(c.pid));`,
  ], { encoding: "utf8" });
  const pid = Number(bystander.stdout.trim());
  try {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "failed to start bystander");
    upsertJob(workspace, {
      id: "recycled-1",
      kind: "audit",
      status: "running",
      sessionId: "sess-a",
      pid,
      pidStartedAt: "Mon Jan  1 00:00:00 2020", // deliberately stale identity
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);

    // The bystander must still be alive: a mismatched start time proves the PID
    // was recycled, so it belongs to someone else and must never be signalled.
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = error?.code === "EPERM";
    }
    assert.equal(alive, true, "hook killed a process it could not prove was its own");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    cleanupDir(workspace);
  }
});

test("SessionEnd does not signal a live PID recorded without process identity", () => {
  const workspace = makeTempDir();
  const bystander = spawnSync(process.execPath, [
    "-e",
    `const { spawn } = require('node:child_process');
     const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
     c.unref();
     process.stdout.write(String(c.pid));`,
  ], { encoding: "utf8" });
  const pid = Number(bystander.stdout.trim());
  try {
    upsertJob(workspace, {
      id: "legacy-1",
      kind: "audit",
      status: "running",
      sessionId: "sess-a",
      pid, // no pidStartedAt: written by a cc-suite that predates identity tracking
    });
    const result = runSessionEnd(workspace, "sess-a");
    assert.equal(result.status, 0, result.stderr);

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      alive = error?.code === "EPERM";
    }
    assert.equal(alive, true, "hook signalled a PID it could not verify");

    const jobs = listJobs(workspace);
    assert.equal(jobs.length, 1, "an unsignalled job must stay visible");
    assert.equal(jobs[0].status, "cancelled");
    assert.match(jobs[0].errorMessage, /process-identity/);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    cleanupDir(workspace);
  }
});
