import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { cleanupSeatbeltScratch, listWorkspaceChanges } from "./agy-seatbelt.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile,
} from "./state.mjs";

const MANIFEST_VERSION = 1;
const MANIFEST_KIND = "cc-suite-agy-run";
const RECOVERY_DIR_NAME = "agy-runs";
const RECOVERY_MARKER_NAME = ".cc-suite-agy-run.json";
const SCRATCH_PREFIX = "cc-suite-agy-seatbelt-";
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stalled",
  "cancelled",
  "aborted",
]);

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalExisting(value) {
  return fs.realpathSync.native(path.resolve(value));
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runGit(workspace, args, code) {
  const result = spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) {
    throw recoveryError(
      code,
      (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim()
    );
  }
  return result.stdout.trim();
}

function pathStaysWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function ensurePrivateDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw recoveryError("AGY_RECOVERY_DIRECTORY_INVALID", `Expected a private directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw recoveryError(
      "AGY_RECOVERY_DIRECTORY_OWNER_MISMATCH",
      `Recovery directory is owned by uid ${stat.uid}: ${directory}`
    );
  }
  fs.chmodSync(directory, 0o700);
}

function assertPrivateRegularFile(file, code) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw recoveryError(code, `Expected a regular recovery file: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw recoveryError(code, `Recovery file is owned by uid ${stat.uid}: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw recoveryError(code, `Recovery file permissions are broader than 0600: ${file}`);
  }
}

function atomicWritePrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    const directoryHandle = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(directoryHandle);
    } finally {
      fs.closeSync(directoryHandle);
    }
  } finally {
    if (handle !== null && handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function sameIdentity(expected, actual) {
  return Boolean(
    expected &&
    actual &&
    expected.pid === actual.pid &&
    expected.pgid === actual.pgid &&
    expected.started === actual.started
  );
}

function assertScratchPathShape(scratchPath) {
  const scratchRoot = canonicalExisting(os.tmpdir());
  const resolved = path.resolve(scratchPath);
  const absolute = path.join(
    canonicalExisting(path.dirname(resolved)),
    path.basename(resolved)
  );
  if (!pathStaysWithin(scratchRoot, absolute) || !path.basename(absolute).startsWith(SCRATCH_PREFIX)) {
    throw recoveryError(
      "AGY_RECOVERY_SCRATCH_INVALID",
      `Refusing unexpected AGY scratch path: ${scratchPath}`
    );
  }
  return absolute;
}

function assertScratchDirectory(scratchPath) {
  assertScratchPathShape(scratchPath);
  const absolute = canonicalExisting(scratchPath);
  assertScratchPathShape(absolute);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw recoveryError("AGY_RECOVERY_SCRATCH_INVALID", `Expected AGY scratch directory: ${scratchPath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw recoveryError(
      "AGY_RECOVERY_SCRATCH_OWNER_MISMATCH",
      `AGY scratch is owned by uid ${stat.uid}: ${scratchPath}`
    );
  }
  return canonicalExisting(absolute);
}

function readManifest(manifestPath) {
  assertPrivateRegularFile(manifestPath, "AGY_RECOVERY_MANIFEST_INVALID");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw recoveryError("AGY_RECOVERY_MANIFEST_INVALID", `Cannot parse ${manifestPath}: ${error.message}`);
  }
  if (
    manifest?.kind !== MANIFEST_KIND ||
    manifest?.version !== MANIFEST_VERSION ||
    !/^[a-zA-Z0-9._-]+$/.test(manifest?.jobId || "") ||
    !/^[a-f0-9]{64}$/.test(manifest?.recoveryToken || "") ||
    path.basename(manifestPath) !== `${manifest.jobId}.json`
  ) {
    throw recoveryError("AGY_RECOVERY_MANIFEST_INVALID", `Invalid AGY recovery manifest: ${manifestPath}`);
  }
  const expectedPath = path.join(
    resolveAgyRecoveryDir(manifest.workspace),
    `${manifest.jobId}.json`
  );
  if (path.resolve(manifestPath) !== path.resolve(expectedPath)) {
    throw recoveryError("AGY_RECOVERY_MANIFEST_PATH_MISMATCH", `Unexpected manifest path: ${manifestPath}`);
  }
  return manifest;
}

function validateRecoveryBoundary(cwd, manifest) {
  const workspace = canonicalExisting(cwd);
  if (workspace !== manifest.workspace) {
    throw recoveryError(
      "AGY_RECOVERY_WORKSPACE_MISMATCH",
      `Manifest workspace '${manifest.workspace}' does not match '${workspace}'`
    );
  }
  const expectedLogFile = resolveJobLogFile(workspace, manifest.jobId);
  if (manifest.logFile && path.resolve(manifest.logFile) !== path.resolve(expectedLogFile)) {
    throw recoveryError(
      "AGY_RECOVERY_LOG_PATH_INVALID",
      `Manifest log path does not match the job state path: ${manifest.logFile}`
    );
  }
  const gitLink = path.join(workspace, ".git");
  const gitLinkStat = fs.lstatSync(gitLink);
  if (!gitLinkStat.isFile() || gitLinkStat.isSymbolicLink()) {
    throw recoveryError("AGY_RECOVERY_GIT_LINK_INVALID", "Linked-worktree .git pointer is not a regular file");
  }
  if (sha256File(gitLink) !== manifest.gitLinkSha256) {
    throw recoveryError("AGY_RECOVERY_GIT_LINK_MISMATCH", "Linked-worktree .git pointer changed since launch");
  }
  const baselineCommit = runGit(
    workspace,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "AGY_RECOVERY_BASELINE_UNAVAILABLE"
  );
  if (baselineCommit !== manifest.baselineCommit) {
    throw recoveryError(
      "AGY_RECOVERY_BASELINE_MISMATCH",
      `Workspace HEAD changed from ${manifest.baselineCommit} to ${baselineCommit}`
    );
  }

  assertScratchPathShape(manifest.scratchDir);
  if (fs.existsSync(manifest.scratchDir)) {
    const scratch = assertScratchDirectory(manifest.scratchDir);
    const markerFile = path.join(scratch, RECOVERY_MARKER_NAME);
    assertPrivateRegularFile(markerFile, "AGY_RECOVERY_MARKER_INVALID");
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    } catch (error) {
      throw recoveryError("AGY_RECOVERY_MARKER_INVALID", `Cannot parse scratch marker: ${error.message}`);
    }
    if (
      marker?.kind !== MANIFEST_KIND ||
      marker?.jobId !== manifest.jobId ||
      marker?.workspace !== workspace ||
      marker?.scratchDir !== scratch ||
      marker?.recoveryToken !== manifest.recoveryToken
    ) {
      throw recoveryError("AGY_RECOVERY_MARKER_MISMATCH", "Scratch marker does not match the run manifest");
    }
  }
}

function isProcessGroupAlive(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    return match && Number(match[1]) === pgid && !match[2].startsWith("Z");
  });
}

async function waitForProcessGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pgid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessGroupAlive(pgid);
}

async function terminateRecordedProcessGroup(manifest, graceMs) {
  const recorded = manifest.agyProcess;
  if (!recorded) return;
  const actual = inspectProcessIdentity(recorded.pid);
  if (!actual) {
    if (isProcessGroupAlive(recorded.pgid)) {
      throw recoveryError(
        "AGY_RECOVERY_PROCESS_UNATTRIBUTABLE",
        `Recorded AGY leader ${recorded.pid} is gone while process group ${recorded.pgid} remains`
      );
    }
    return;
  }
  if (!sameIdentity(recorded.identity, actual) || actual.pgid !== recorded.pgid) {
    throw recoveryError(
      "AGY_RECOVERY_PROCESS_IDENTITY_MISMATCH",
      `PID ${recorded.pid} no longer identifies the recorded AGY process`
    );
  }

  try {
    process.kill(-recorded.pgid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (await waitForProcessGroupExit(recorded.pgid, graceMs)) return;
  try {
    process.kill(-recorded.pgid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (!(await waitForProcessGroupExit(recorded.pgid, graceMs))) {
    throw recoveryError(
      "AGY_RECOVERY_PROCESS_SURVIVED",
      `AGY process group ${recorded.pgid} survived SIGKILL`
    );
  }
}

function persistRecoveredJob(cwd, manifest, workspaceChanges) {
  const existingJob = listJobs(cwd).find((job) => job.id === manifest.jobId);
  const errorMessage = "AGY runner exited before its cleanup transaction completed";
  const alreadyTerminal = existingJob && TERMINAL_STATUSES.has(existingJob.status);
  if (!alreadyTerminal) {
    upsertJob(cwd, {
      id: manifest.jobId,
      kind: "agy",
      status: "aborted",
      summary: existingJob?.summary || "Recovered interrupted AGY task",
      completedAt: new Date().toISOString(),
      errorCode: "AGY_RUNNER_ABORTED",
      errorMessage,
      ...(manifest.logFile ? { logFile: manifest.logFile } : {}),
    });
  }
  let existingPayload = {};
  const jobFile = resolveJobFile(cwd, manifest.jobId);
  if (fs.existsSync(jobFile)) {
    try { existingPayload = readJobFile(jobFile); } catch {}
  }
  writeJobFile(cwd, manifest.jobId, {
    ...existingPayload,
    rawOutput: existingPayload.rawOutput || "",
    workspaceChanges,
    ...(!alreadyTerminal
      ? { errorCode: "AGY_RUNNER_ABORTED", error: errorMessage }
      : {}),
  });
  return !alreadyTerminal;
}

export function resolveAgyRecoveryDir(cwd) {
  return path.join(resolveStateDir(cwd), RECOVERY_DIR_NAME);
}

export function inspectProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="],
    { encoding: "utf8" }
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length < 4) return null;
  const actualPid = Number(fields[0]);
  const pgid = Number(fields[1]);
  if (!Number.isSafeInteger(actualPid) || !Number.isSafeInteger(pgid)) return null;
  return { pid: actualPid, pgid, started: fields.slice(2).join(" ") };
}

export function createAgyRunManifest({
  cwd,
  jobId,
  scratchDir,
  logFile = null,
  runnerPid = process.pid,
  runnerIdentity = null,
}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(jobId || "")) {
    throw recoveryError("AGY_RECOVERY_JOB_ID_INVALID", `Invalid AGY job id: ${jobId}`);
  }
  const workspace = canonicalExisting(cwd);
  const scratch = assertScratchDirectory(scratchDir);
  const gitLink = path.join(workspace, ".git");
  const gitLinkStat = fs.lstatSync(gitLink);
  if (!gitLinkStat.isFile() || gitLinkStat.isSymbolicLink()) {
    throw recoveryError("AGY_RECOVERY_GIT_LINK_INVALID", "Linked-worktree .git pointer is not a regular file");
  }
  const identity = runnerIdentity || inspectProcessIdentity(runnerPid);
  if (!identity || identity.pid !== runnerPid) {
    throw recoveryError("AGY_RECOVERY_RUNNER_IDENTITY_UNAVAILABLE", "Cannot capture AGY runner process identity");
  }
  const recoveryToken = randomBytes(32).toString("hex");
  const expectedLogFile = resolveJobLogFile(workspace, jobId);
  if (logFile && path.resolve(logFile) !== path.resolve(expectedLogFile)) {
    throw recoveryError(
      "AGY_RECOVERY_LOG_PATH_INVALID",
      `AGY recovery logs must use the job state path: ${expectedLogFile}`
    );
  }
  const timestamp = new Date().toISOString();
  const manifest = {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    jobId,
    stage: "scratch-prepared",
    workspace,
    baselineCommit: runGit(
      workspace,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "AGY_RECOVERY_BASELINE_UNAVAILABLE"
    ),
    gitLinkSha256: sha256File(gitLink),
    scratchDir: scratch,
    recoveryToken,
    runnerProcess: { pid: runnerPid, identity },
    agyProcess: null,
    logFile: logFile ? expectedLogFile : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const marker = {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    jobId,
    workspace,
    scratchDir: scratch,
    recoveryToken,
  };
  atomicWritePrivateJson(path.join(scratch, RECOVERY_MARKER_NAME), marker);
  const manifestPath = path.join(resolveAgyRecoveryDir(workspace), `${jobId}.json`);
  atomicWritePrivateJson(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function recordAgyProcess(manifestPath, { pid, pgid, identity = null }) {
  const manifest = readManifest(manifestPath);
  const actualIdentity = identity || inspectProcessIdentity(pid);
  if (!actualIdentity || actualIdentity.pid !== pid || actualIdentity.pgid !== pgid) {
    throw recoveryError("AGY_RECOVERY_PROCESS_IDENTITY_UNAVAILABLE", "Cannot capture AGY process identity");
  }
  const updated = {
    ...manifest,
    stage: "child-spawned",
    agyProcess: { pid, pgid, identity: actualIdentity },
    updatedAt: new Date().toISOString(),
  };
  atomicWritePrivateJson(manifestPath, updated);
  return updated;
}

export function recordAgyRunStage(manifestPath, stage) {
  const manifest = readManifest(manifestPath);
  const updated = { ...manifest, stage, updatedAt: new Date().toISOString() };
  atomicWritePrivateJson(manifestPath, updated);
  return updated;
}

export function completeAgyRunManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return;
  readManifest(manifestPath);
  fs.unlinkSync(manifestPath);
}

export async function scavengeAgyRuns(cwd, { graceMs = 1000 } = {}) {
  const workspace = canonicalExisting(cwd);
  const recoveryDir = resolveAgyRecoveryDir(workspace);
  if (!fs.existsSync(recoveryDir)) return [];
  ensurePrivateDirectory(recoveryDir);
  const manifestFiles = fs.readdirSync(recoveryDir)
    .filter((name) => /^[a-zA-Z0-9._-]+\.json$/.test(name))
    .sort()
    .map((name) => path.join(recoveryDir, name));
  const results = [];

  for (const manifestPath of manifestFiles) {
    let manifest;
    try {
      manifest = readManifest(manifestPath);
      validateRecoveryBoundary(workspace, manifest);
      const liveRunner = inspectProcessIdentity(manifest.runnerProcess?.pid);
      if (sameIdentity(manifest.runnerProcess?.identity, liveRunner)) {
        results.push({ jobId: manifest.jobId, status: "active" });
        continue;
      }

      await terminateRecordedProcessGroup(manifest, graceMs);
      const workspaceChanges = listWorkspaceChanges(workspace);
      if (fs.existsSync(manifest.scratchDir)) cleanupSeatbeltScratch(manifest.scratchDir);
      const markedAborted = persistRecoveredJob(workspace, manifest, workspaceChanges);
      completeAgyRunManifest(manifestPath);
      results.push({
        jobId: manifest.jobId,
        status: markedAborted ? "aborted" : "cleaned",
        workspaceChanges,
      });
    } catch (error) {
      results.push({
        jobId: manifest?.jobId || path.basename(manifestPath, ".json"),
        status: "blocked",
        errorCode: error.code || "AGY_RECOVERY_FAILED",
        error: error.message,
      });
    }
  }
  return results;
}
