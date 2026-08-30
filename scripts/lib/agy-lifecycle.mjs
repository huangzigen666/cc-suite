import { randomBytes } from "node:crypto";

export const AGY_SUPERVISOR_RECORD_SCHEMA_VERSION = 1;
export const AGY_SUPERVISOR_RECORD_PREFIX = "CC_SUITE_AGY_COMPLETION ";
export const AGY_SUPERVISOR_MAX_CLOCK_SKEW_MS = 250;
export const AGY_SUPERVISOR_MAX_VM_CLOCK_SKEW_MS = 5_000;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_KEYS = Object.freeze([
  "exitCode",
  "exitKind",
  "finishedAt",
  "profileHash",
  "runId",
  "schemaVersion",
  "signal",
  "startedAt",
  "supervisorPid",
  "workloadPid",
]);

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function hasExactKeys(record) {
  if (!isRecord(record)) return false;
  const actual = Object.keys(record).sort();
  return actual.length === RECORD_KEYS.length &&
    actual.every((key, index) => key === RECORD_KEYS[index]);
}

export function createAgySupervisorRunNonce() {
  return randomBytes(16).toString("hex");
}

export function auditAgySupervisorCompletion(stdout, expected = {}) {
  const findings = [];
  let completion = null;

  if (expected.cliExitCode !== 0) {
    addFinding(findings, "AGY_SUPERVISOR_CLI_FAILED");
  }

  const now = expected.now instanceof Date ? expected.now.getTime() : Number.NaN;
  const maxClockSkewMs = expected.maxClockSkewMs === undefined
    ? AGY_SUPERVISOR_MAX_CLOCK_SKEW_MS
    : expected.maxClockSkewMs;
  if (
    !RUN_ID_PATTERN.test(expected.expectedRunId || "") ||
    !SHA256_PATTERN.test(expected.expectedProfileHash || "") ||
    !Number.isFinite(now) || !Number.isInteger(maxClockSkewMs) ||
    maxClockSkewMs < 0 || maxClockSkewMs > AGY_SUPERVISOR_MAX_VM_CLOCK_SKEW_MS
  ) {
    addFinding(findings, "AGY_SUPERVISOR_EXPECTED_SCOPE_INVALID");
  }

  if (typeof stdout !== "string") {
    addFinding(findings, "AGY_SUPERVISOR_OUTPUT_INVALID");
    return {
      attributed: false,
      workloadSucceeded: false,
      workloadExitCode: null,
      completion,
      findings,
    };
  }

  const lines = stdout.split(/\r?\n/);
  const recordIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(AGY_SUPERVISOR_RECORD_PREFIX)) {
      recordIndexes.push(index);
    }
  }

  if (recordIndexes.length === 0) {
    addFinding(findings, "AGY_SUPERVISOR_RECORD_MISSING");
  } else if (recordIndexes.length !== 1) {
    addFinding(findings, "AGY_SUPERVISOR_RECORD_COUNT_INVALID");
  }

  if (recordIndexes.length === 1) {
    const recordIndex = recordIndexes[0];
    let terminalIndex = lines.length - 1;
    while (terminalIndex >= 0 && lines[terminalIndex] === "") terminalIndex -= 1;
    if (recordIndex !== terminalIndex) {
      addFinding(findings, "AGY_SUPERVISOR_RECORD_NOT_TERMINAL");
    }

    const payload = lines[recordIndex].slice(AGY_SUPERVISOR_RECORD_PREFIX.length);
    if (payload.length === 0 || payload.length > 4096) {
      addFinding(findings, "AGY_SUPERVISOR_RECORD_SIZE_INVALID");
    } else {
      try {
        completion = JSON.parse(payload);
      } catch {
        addFinding(findings, "AGY_SUPERVISOR_RECORD_JSON_INVALID");
      }
    }
  }

  if (completion !== null) {
    if (!hasExactKeys(completion)) {
      addFinding(findings, "AGY_SUPERVISOR_RECORD_SCHEMA_INVALID");
    }
    if (completion.schemaVersion !== AGY_SUPERVISOR_RECORD_SCHEMA_VERSION) {
      addFinding(findings, "AGY_SUPERVISOR_SCHEMA_VERSION_MISMATCH");
    }
    if (!RUN_ID_PATTERN.test(completion.runId || "")) {
      addFinding(findings, "AGY_SUPERVISOR_RUN_ID_INVALID");
    }
    if (completion.runId !== expected.expectedRunId) {
      addFinding(findings, "AGY_SUPERVISOR_RUN_ID_MISMATCH");
    }
    if (!SHA256_PATTERN.test(completion.profileHash || "")) {
      addFinding(findings, "AGY_SUPERVISOR_PROFILE_INVALID");
    }
    if (completion.profileHash !== expected.expectedProfileHash) {
      addFinding(findings, "AGY_SUPERVISOR_PROFILE_MISMATCH");
    }
    if (completion.supervisorPid !== 1) {
      addFinding(findings, "AGY_SUPERVISOR_PID_INVALID");
    }
    if (!Number.isInteger(completion.workloadPid) || completion.workloadPid < 2) {
      addFinding(findings, "AGY_SUPERVISOR_WORKLOAD_PID_INVALID");
    }

    const exitTupleValid =
      (
        completion.exitKind === "exit" &&
        Number.isInteger(completion.exitCode) &&
        completion.exitCode >= 0 &&
        completion.exitCode <= 255 &&
        completion.signal === null
      ) ||
      (
        completion.exitKind === "signal" &&
        completion.exitCode === null &&
        Number.isInteger(completion.signal) &&
        completion.signal >= 1 &&
        completion.signal <= 64
      );
    if (!exitTupleValid) {
      addFinding(findings, "AGY_SUPERVISOR_EXIT_TUPLE_INVALID");
    }

    const startedAt = parseTimestamp(completion.startedAt);
    const finishedAt = parseTimestamp(completion.finishedAt);
    if (startedAt === null || finishedAt === null || finishedAt < startedAt) {
      addFinding(findings, "AGY_SUPERVISOR_TIME_INVALID");
    } else {
      if (finishedAt > now + maxClockSkewMs) {
        addFinding(findings, "AGY_SUPERVISOR_TIME_FROM_FUTURE");
      }
      if (now - finishedAt > 10 * 60 * 1000) {
        addFinding(findings, "AGY_SUPERVISOR_RECORD_STALE");
      }
      if (finishedAt - startedAt > 24 * 60 * 60 * 1000) {
        addFinding(findings, "AGY_SUPERVISOR_DURATION_UNSAFE");
      }
    }
  }

  const attributed = findings.length === 0;
  const workloadExitCode = attributed
    ? completion.exitKind === "exit"
      ? completion.exitCode
      : 128 + completion.signal
    : null;

  return {
    attributed,
    workloadSucceeded: attributed && workloadExitCode === 0,
    workloadExitCode,
    completion,
    findings,
  };
}
