// A background worker whose job was removed (SessionEnd drops queued records
// and their logs) or cancelled before it started must exit without starting
// its backend, without resurrecting the record, and without recreating the log
// as an orphan. The six job-runner runners are covered in tests/lifecycle/;
// these are the four runners with their own worker code.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";
import { listJobs, resolveJobFile, upsertJob } from "../scripts/lib/state.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));

// Runner script, the backend binary it would spawn, and the args it needs to
// reach its worker path.
const RUNNERS = {
  codex: { bin: "codex", args: ["--kind", "codex"] },
  agy: { bin: "agy", args: ["--kind", "agy"] },
  grok: { bin: "grok", args: ["--kind", "grok"] },
  qwen: { bin: "qwen", args: ["--target", "t.txt"] },
};

const FAKE_BACKEND = `#!/usr/bin/env node
require("fs").writeFileSync(process.env.FAKE_MARKER, "started");
`;

function runWorker(name, { jobId, seed }) {
  const workspace = fs.realpathSync(makeTempDir(`${name}-claim-`));
  const stateDir = makeTempDir(`${name}-claim-state-`);
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, RUNNERS[name].bin), FAKE_BACKEND);
  fs.writeFileSync(path.join(workspace, "t.txt"), "target\n");
  const marker = path.join(workspace, "marker");
  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
    CLAUDE_PLUGIN_DATA: stateDir,
    CODEX_TOOLKIT_SESSION_ID: "",
    CODEX_TOOLKIT_BACKGROUND_JOB_ID: jobId,
    FAKE_MARKER: marker,
  };
  const withState = (fn) => {
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = stateDir;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
    }
  };
  if (seed) withState(() => upsertJob(workspace, seed));
  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, `${name}-runner.mjs`), ...RUNNERS[name].args, "--", "hi"],
    { cwd: workspace, env, encoding: "utf8", timeout: 20000 }
  );
  const logFile = withState(() => path.join(path.dirname(resolveJobFile(workspace, jobId)), `${jobId}.log`));
  const outcome = {
    status: result.status,
    stderr: result.stderr,
    backendStarted: fs.existsSync(marker),
    logExists: fs.existsSync(logFile),
    jobs: withState(() => listJobs(workspace)),
  };
  cleanupDir(workspace);
  cleanupDir(stateDir);
  return outcome;
}

for (const name of Object.keys(RUNNERS)) {
  test(`${name}: a worker whose record was removed exits without a backend, a record, or an orphan log`, () => {
    const r = runWorker(name, { jobId: `${name}-gone-1` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.backendStarted, false, "backend must not start");
    assert.equal(r.jobs.length, 0, "record must not be resurrected");
    assert.equal(r.logExists, false, "orphan log recreated");
  });

  test(`${name}: a worker whose job was cancelled while queued leaves it cancelled and writes no log`, () => {
    const jobId = `${name}-cancelled-1`;
    const r = runWorker(name, { jobId, seed: { id: jobId, kind: name, status: "cancelled" } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.backendStarted, false, "backend must not start");
    assert.equal(r.jobs.find((j) => j.id === jobId).status, "cancelled");
    assert.equal(r.logExists, false, "log created for a job the worker never ran");
  });
}
