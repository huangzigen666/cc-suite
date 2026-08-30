import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { auditAgyR16HomeVolume } from "./agy-r16-home.mjs";
import {
  AGY_R16_CAPSULE_IMAGE,
  AGY_R16_IMAGE_DIGESTS,
  AGY_R16_PROXY_IMAGE,
  buildAgyR16ResourceNames,
} from "./agy-r16-workspace.mjs";
import { listWorkspaceChanges } from "./agy-seatbelt.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile,
} from "./state.mjs";

const MANIFEST_KIND = "cc-suite-agy-r16-run";
const MANIFEST_VERSION = 1;
const RECOVERY_DIR = "agy-r16-runs";
const SUFFIX_PATTERN = /^[a-f0-9]{12}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const OAUTH_VOLUME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const JOB_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const TERMINAL_STATUSES = new Set([
  "completed", "failed", "stalled", "cancelled", "aborted",
]);

function recoveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeEnvironment() {
  return {
    HOME: process.env.HOME || "",
    LANG: process.env.LANG || "C.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
}

function runContainer(args, timeout = 15_000) {
  const result = spawnSync("container", args, {
    encoding: "utf8",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw recoveryError("AGY_R16_RECOVERY_DIRECTORY_INVALID", "R16 recovery directory is unsafe");
  }
  fs.chmodSync(directory, 0o700);
}

function atomicWritePrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (descriptor !== null && descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitHead(workspace) {
  const result = spawnSync("git", ["-C", workspace, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8",
    env: { ...safeEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.status !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(result.stdout || "")) {
    throw recoveryError("AGY_R16_RECOVERY_BASELINE_UNAVAILABLE", "cannot read workspace baseline");
  }
  return result.stdout.trim();
}

function inspectProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="],
    { encoding: "utf8" }
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const fields = result.stdout.trim().split(/\s+/);
  const actualPid = Number(fields[0]);
  const pgid = Number(fields[1]);
  if (!Number.isSafeInteger(actualPid) || !Number.isSafeInteger(pgid)) return null;
  return { pid: actualPid, pgid, started: fields.slice(2).join(" ") };
}

function sameIdentity(expected, actual) {
  return Boolean(expected && actual && expected.pid === actual.pid &&
    expected.pgid === actual.pgid && expected.started === actual.started);
}

function readManifest(manifestPath) {
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw recoveryError("AGY_R16_RECOVERY_MANIFEST_INVALID", "R16 recovery manifest is unsafe");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw recoveryError("AGY_R16_RECOVERY_MANIFEST_INVALID", "R16 recovery manifest is invalid");
  }
  if (manifest?.kind !== MANIFEST_KIND || manifest?.version !== MANIFEST_VERSION ||
      !JOB_ID_PATTERN.test(manifest?.jobId || "") ||
      path.basename(manifestPath) !== `${manifest.jobId}.json` ||
      !SUFFIX_PATTERN.test(manifest?.suffix || "") ||
      !RUN_ID_PATTERN.test(manifest?.runId || "") ||
      !OAUTH_VOLUME_PATTERN.test(manifest?.oauthVolumeName || "")) {
    throw recoveryError("AGY_R16_RECOVERY_MANIFEST_INVALID", "R16 recovery manifest shape is invalid");
  }
  const expectedNames = buildAgyR16ResourceNames(manifest.suffix);
  if (JSON.stringify(manifest.names) !== JSON.stringify(expectedNames)) {
    throw recoveryError("AGY_R16_RECOVERY_RESOURCE_SCOPE_INVALID", "R16 resource names do not match suffix");
  }
  const expectedPath = path.join(resolveAgyR16RecoveryDir(manifest.workspace), `${manifest.jobId}.json`);
  if (path.resolve(expectedPath) !== path.resolve(manifestPath)) {
    throw recoveryError("AGY_R16_RECOVERY_MANIFEST_PATH_INVALID", "R16 manifest path is invalid");
  }
  return manifest;
}

function validateWorkspace(manifest) {
  const workspace = fs.realpathSync.native(manifest.workspace);
  const gitLink = path.join(workspace, ".git");
  const stat = fs.lstatSync(gitLink);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      sha256File(gitLink) !== manifest.gitLinkSha256 ||
      gitHead(workspace) !== manifest.baselineCommit) {
    throw recoveryError("AGY_R16_RECOVERY_WORKSPACE_MISMATCH", "R16 workspace identity changed");
  }
  return workspace;
}

function exactLabels(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.entries(value).sort()) ===
      JSON.stringify(Object.entries(expected).sort());
}

function auditContainer(raw, expectedName, expectedPurpose, expectedImage) {
  let descriptor;
  try {
    const parsed = JSON.parse(raw);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  const configuration = descriptor?.configuration;
  return Boolean(
    descriptor?.id === expectedName && configuration?.id === expectedName &&
    exactLabels(configuration?.labels, {
      "cc-suite.owner": "cc-suite",
      "cc-suite.purpose": expectedPurpose,
    }) &&
    configuration?.image?.reference === expectedImage &&
    configuration?.image?.descriptor?.digest === AGY_R16_IMAGE_DIGESTS[expectedImage]
  );
}

function containerAbsent(name) {
  const inventory = runContainer(["list", "--all", "--format", "json"], 5_000);
  if (inventory.status !== 0) return false;
  try {
    const parsed = JSON.parse(inventory.stdout);
    return Array.isArray(parsed) && !parsed.some((item) => item?.id === name ||
      item?.configuration?.id === name);
  } catch {
    return false;
  }
}

function removeExactContainer(name, purpose, image) {
  const inspected = runContainer(["inspect", name], 5_000);
  if (inspected.status !== 0) return containerAbsent(name);
  if (!auditContainer(inspected.stdout, name, purpose, image)) {
    throw recoveryError("AGY_R16_RECOVERY_CONTAINER_IDENTITY_MISMATCH", `refusing container ${name}`);
  }
  let descriptor;
  try { descriptor = JSON.parse(inspected.stdout)[0]; } catch {}
  if (descriptor?.status?.state === "running" && runContainer(["stop", name]).status !== 0) {
    throw recoveryError("AGY_R16_RECOVERY_CONTAINER_STOP_FAILED", `cannot stop ${name}`);
  }
  if (runContainer(["delete", name]).status !== 0 || !containerAbsent(name)) {
    throw recoveryError("AGY_R16_RECOVERY_CONTAINER_DELETE_FAILED", `cannot delete ${name}`);
  }
  return true;
}

function volumeAbsent(name) {
  const inventory = runContainer(["volume", "list", "--format", "json"], 5_000);
  if (inventory.status !== 0) return false;
  try {
    const parsed = JSON.parse(inventory.stdout);
    return Array.isArray(parsed) && !parsed.some((item) => item?.id === name ||
      item?.configuration?.name === name);
  } catch {
    return false;
  }
}

function removeExactHomeVolume(name) {
  const inspected = runContainer(["volume", "inspect", name], 5_000);
  if (inspected.status !== 0) return volumeAbsent(name);
  if (!auditAgyR16HomeVolume(inspected.stdout, name).ready) {
    throw recoveryError("AGY_R16_RECOVERY_VOLUME_IDENTITY_MISMATCH", `refusing volume ${name}`);
  }
  if (runContainer(["volume", "delete", name]).status !== 0 || !volumeAbsent(name)) {
    throw recoveryError("AGY_R16_RECOVERY_VOLUME_DELETE_FAILED", `cannot delete ${name}`);
  }
  return true;
}

function cleanupResources(manifest) {
  const runtime = runContainer(["system", "status"], 5_000);
  let startedForRecovery = false;
  if (runtime.status !== 0 || !/^status\s+running$/m.test(runtime.stdout)) {
    if (runContainer(["system", "start"], 30_000).status !== 0) {
      throw recoveryError("AGY_R16_RECOVERY_RUNTIME_UNAVAILABLE", "container runtime unavailable");
    }
    startedForRecovery = true;
  }
  let clean = false;
  try {
    removeExactContainer(
      manifest.names.homeHelper,
      "agy-r16-home-helper",
      AGY_R16_PROXY_IMAGE
    );
    removeExactContainer(
      manifest.names.proxy,
      "agy-r16-workspace-egress",
      AGY_R16_PROXY_IMAGE
    );
    removeExactContainer(
      manifest.names.client,
      "agy-r16-workspace-write",
      AGY_R16_CAPSULE_IMAGE
    );
    removeExactHomeVolume(manifest.names.home);
    clean = true;
  } finally {
    if (startedForRecovery && runContainer(["system", "stop"], 30_000).status !== 0) {
      throw recoveryError("AGY_R16_RECOVERY_RUNTIME_RESTORE_FAILED", "runtime restore failed");
    }
  }
  return clean;
}

async function terminateSession(manifest, graceMs) {
  const recorded = manifest.sessionProcess;
  if (!recorded) return;
  const actual = inspectProcessIdentity(recorded.pid);
  if (!actual) return;
  if (!sameIdentity(recorded.identity, actual) || actual.pgid !== recorded.pgid) {
    throw recoveryError("AGY_R16_RECOVERY_PROCESS_IDENTITY_MISMATCH", "session PID was reused");
  }
  try { process.kill(-recorded.pgid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && inspectProcessIdentity(recorded.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (inspectProcessIdentity(recorded.pid)) {
    try { process.kill(-recorded.pgid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function persistAborted(workspace, manifest, workspaceChanges) {
  const existing = listJobs(workspace).find((job) => job.id === manifest.jobId);
  const alreadyTerminal = existing && TERMINAL_STATUSES.has(existing.status);
  const message = "R16 runner exited before external capsule cleanup completed";
  if (!alreadyTerminal) {
    upsertJob(workspace, {
      id: manifest.jobId,
      kind: "agy",
      status: "aborted",
      summary: existing?.summary || "Recovered interrupted R16 AGY task",
      completedAt: new Date().toISOString(),
      errorCode: "AGY_R16_RUNNER_ABORTED",
      errorMessage: message,
      logFile: resolveJobLogFile(workspace, manifest.jobId),
    });
  }
  let payload = {};
  const jobFile = resolveJobFile(workspace, manifest.jobId);
  if (fs.existsSync(jobFile)) {
    try { payload = readJobFile(jobFile); } catch {}
  }
  writeJobFile(workspace, manifest.jobId, {
    ...payload,
    rawOutput: payload.rawOutput || "",
    workspaceChanges,
    ...(!alreadyTerminal ? { errorCode: "AGY_R16_RUNNER_ABORTED", error: message } : {}),
  });
}

export function resolveAgyR16RecoveryDir(cwd) {
  return path.join(resolveStateDir(cwd), RECOVERY_DIR);
}

export function createAgyR16RunManifest({
  cwd,
  jobId,
  logFile,
  oauthVolumeName,
  runId,
  runnerIdentity = null,
  runnerPid = process.pid,
  suffix,
} = {}) {
  if (!JOB_ID_PATTERN.test(jobId || "") || !SUFFIX_PATTERN.test(suffix || "") ||
      !RUN_ID_PATTERN.test(runId || "") ||
      !OAUTH_VOLUME_PATTERN.test(oauthVolumeName || "")) {
    throw recoveryError("AGY_R16_RECOVERY_SCOPE_INVALID", "R16 recovery scope is invalid");
  }
  const workspace = fs.realpathSync.native(cwd);
  if (path.resolve(logFile || "") !== path.resolve(resolveJobLogFile(workspace, jobId))) {
    throw recoveryError("AGY_R16_RECOVERY_LOG_PATH_INVALID", "R16 recovery log path is invalid");
  }
  const gitLink = path.join(workspace, ".git");
  const identity = runnerIdentity || inspectProcessIdentity(runnerPid);
  if (!identity || identity.pid !== runnerPid) {
    throw recoveryError("AGY_R16_RECOVERY_RUNNER_IDENTITY_UNAVAILABLE", "runner identity unavailable");
  }
  const now = new Date().toISOString();
  const manifest = {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    jobId,
    workspace,
    baselineCommit: gitHead(workspace),
    gitLinkSha256: sha256File(gitLink),
    suffix,
    runId,
    names: buildAgyR16ResourceNames(suffix),
    oauthVolumeName,
    runnerProcess: { pid: runnerPid, identity },
    sessionProcess: null,
    stage: "prepared",
    createdAt: now,
    updatedAt: now,
  };
  const manifestPath = path.join(resolveAgyR16RecoveryDir(workspace), `${jobId}.json`);
  atomicWritePrivateJson(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function recordAgyR16SessionProcess(manifestPath, { pid, pgid } = {}) {
  const manifest = readManifest(manifestPath);
  const identity = inspectProcessIdentity(pid);
  if (!identity || identity.pid !== pid || identity.pgid !== pgid) {
    throw recoveryError("AGY_R16_RECOVERY_PROCESS_IDENTITY_UNAVAILABLE", "session identity unavailable");
  }
  const updated = {
    ...manifest,
    sessionProcess: { pid, pgid, identity },
    stage: "session-spawned",
    updatedAt: new Date().toISOString(),
  };
  atomicWritePrivateJson(manifestPath, updated);
  return updated;
}

export function completeAgyR16RunManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return;
  readManifest(manifestPath);
  fs.unlinkSync(manifestPath);
}

export function recoverAgyR16OwnedRun(manifestPath) {
  const manifest = readManifest(manifestPath);
  const actualRunner = inspectProcessIdentity(process.pid);
  if (!sameIdentity(manifest.runnerProcess?.identity, actualRunner)) {
    throw recoveryError("AGY_R16_RECOVERY_RUNNER_IDENTITY_MISMATCH", "only owning runner may recover live run");
  }
  validateWorkspace(manifest);
  const session = manifest.sessionProcess && inspectProcessIdentity(manifest.sessionProcess.pid);
  if (session) {
    throw recoveryError("AGY_R16_RECOVERY_SESSION_STILL_RUNNING", "session still runs during owned recovery");
  }
  cleanupResources(manifest);
  const workspaceChanges = listWorkspaceChanges(manifest.workspace);
  completeAgyR16RunManifest(manifestPath);
  return { ready: true, workspaceChanges };
}

export async function scavengeAgyR16Runs(cwd, { graceMs = 1_000 } = {}) {
  const workspace = fs.realpathSync.native(cwd);
  const directory = resolveAgyR16RecoveryDir(workspace);
  if (!fs.existsSync(directory)) return [];
  ensurePrivateDirectory(directory);
  const files = fs.readdirSync(directory)
    .filter((name) => JOB_ID_PATTERN.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
    .sort()
    .map((name) => path.join(directory, name));
  const results = [];
  for (const manifestPath of files) {
    let manifest;
    try {
      manifest = readManifest(manifestPath);
      const exactWorkspace = validateWorkspace(manifest);
      const liveRunner = inspectProcessIdentity(manifest.runnerProcess?.pid);
      if (sameIdentity(manifest.runnerProcess?.identity, liveRunner)) {
        results.push({ jobId: manifest.jobId, status: "active" });
        continue;
      }
      await terminateSession(manifest, graceMs);
      cleanupResources(manifest);
      const workspaceChanges = listWorkspaceChanges(exactWorkspace);
      persistAborted(exactWorkspace, manifest, workspaceChanges);
      completeAgyR16RunManifest(manifestPath);
      results.push({ jobId: manifest.jobId, status: "aborted", workspaceChanges });
    } catch (error) {
      results.push({
        jobId: manifest?.jobId || path.basename(manifestPath, ".json"),
        status: "blocked",
        errorCode: error.code || "AGY_R16_RECOVERY_FAILED",
        error: error.message,
      });
    }
  }
  return results;
}
