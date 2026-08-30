import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";

import {
  createAgyEventState,
  consumeAgyEventLine,
  finalizeAgyEventState,
} from "./agy-contract.mjs";
import {
  AGY_R15_AUTH_HOSTS,
  AGY_R15_BOOTSTRAP_CONTAINER_PORT,
  AGY_R15_CAPSULE_IMAGE,
  AGY_R15_PROXY_IMAGE,
} from "./agy-r15-auth.mjs";
import {
  AGY_SUPERVISOR_RECORD_PREFIX,
  auditAgySupervisorCompletion,
} from "./agy-lifecycle.mjs";
import {
  AGY_OAUTH_VOLUME_SIZE_BYTES,
  auditAgyOAuthVolumeDescriptor,
} from "./agy-oauth-volume.mjs";
import { AGY_HOST_PROXY_NETWORK } from "./agy-host-proxy-bridge.mjs";

export const AGY_R15_MODEL_MARKER = "AGY_R15_MODEL_OK";
export const AGY_R15_VERIFY_MODEL = "gemini-3.6-flash-low";
export const AGY_R15_MODEL_PROMPT =
  "Reply with exactly AGY_R15_MODEL_OK. Do not call any tool, do not read or " +
  "write files, and do not access URLs.";
export const AGY_R15_VERIFY_MAX_OUTPUT_BYTES = 1024 * 1024;
export const AGY_R15_VERIFY_MAX_VOLUME_AGE_MS = 24 * 60 * 60 * 1000;

export const AGY_R15_VERIFY_PROFILE_HASHES = Object.freeze({
  models: `sha256:${createHash("sha256").update(JSON.stringify({
    allowedHosts: AGY_R15_AUTH_HOSTS,
    capsuleImage: AGY_R15_CAPSULE_IMAGE,
    command: ["/usr/local/bin/agy", "models"],
    phase: "models",
    proxyImage: AGY_R15_PROXY_IMAGE,
    schemaVersion: 1,
  })).digest("hex")}`,
  request: `sha256:${createHash("sha256").update(JSON.stringify({
    allowedHosts: AGY_R15_AUTH_HOSTS,
    capsuleImage: AGY_R15_CAPSULE_IMAGE,
    marker: AGY_R15_MODEL_MARKER,
    model: AGY_R15_VERIFY_MODEL,
    phase: "request",
    prompt: AGY_R15_MODEL_PROMPT,
    proxyImage: AGY_R15_PROXY_IMAGE,
    schemaVersion: 1,
  })).digest("hex")}`,
});

const VOLUME_NAME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const SUFFIX_PATTERN = /^[a-f0-9]{12}$/;
const CLIENT_NAME_PATTERN = /^cc-suite-agy-r15-(models|request)-[a-f0-9]{12}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

function verifyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function validPrivatePrefix(value) {
  if (typeof value !== "string") return false;
  const candidate = `${value}.1`;
  if (net.isIP(candidate) !== 4) return false;
  const [first, second] = candidate.split(".").map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseAgyR15VerifyArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 4 ||
    argv[0] !== "--oauth-volume" ||
    !VOLUME_NAME_PATTERN.test(argv[1] || "") ||
    argv[2] !== "--acknowledge-real-model-request" ||
    argv[3] !== "--acknowledge-host-proxy-bridge"
  ) {
    throw verifyError(
      "AGY_R15_VERIFY_ARGUMENTS_INVALID",
      "usage: --oauth-volume <exact-name> --acknowledge-real-model-request " +
        "--acknowledge-host-proxy-bridge"
    );
  }
  return { oauthVolumeName: argv[1] };
}

export function auditAgyR15ExistingOAuthVolume(rawJson, expected = {}) {
  if (
    !VOLUME_NAME_PATTERN.test(expected.expectedName || "") ||
    typeof expected.homeDirectory !== "string" ||
    !path.isAbsolute(expected.homeDirectory) ||
    !(expected.now instanceof Date) ||
    !Number.isFinite(expected.now.getTime())
  ) {
    return { ready: false, findings: ["AGY_R15_VERIFY_VOLUME_SCOPE_INVALID"] };
  }
  let descriptor;
  try {
    const parsed = JSON.parse(rawJson);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  if (!descriptor) {
    return { ready: false, findings: ["AGY_R15_VERIFY_VOLUME_DESCRIPTOR_INVALID"] };
  }
  const audit = auditAgyOAuthVolumeDescriptor(descriptor, {
    expectedName: expected.expectedName,
    expectedSizeInBytes: AGY_OAUTH_VOLUME_SIZE_BYTES,
    expectedSourceRoot: path.join(
      expected.homeDirectory,
      "Library",
      "Application Support",
      "com.apple.container",
      "volumes"
    ),
    maxCreationAgeMs: AGY_R15_VERIFY_MAX_VOLUME_AGE_MS,
    now: expected.now,
  });
  return { ready: audit.ready, findings: audit.findings };
}

export function buildAgyR15VerificationResourceNames(suffix, phase) {
  if (!SUFFIX_PATTERN.test(suffix || "")) {
    throw verifyError("AGY_R15_RESOURCE_SUFFIX_INVALID", "resource suffix is invalid");
  }
  if (phase !== "models" && phase !== "request") {
    throw verifyError("AGY_R15_VERIFY_PHASE_INVALID", "verification phase is invalid");
  }
  return {
    client: `cc-suite-agy-r15-${phase}-${suffix}`,
    network: AGY_HOST_PROXY_NETWORK,
    proxy: `cc-suite-agy-r15-proxy-${suffix}`,
  };
}

function workloadArguments(phase) {
  if (phase === "models") return ["/usr/local/bin/agy", "models"];
  if (phase === "request") {
    return [
      "/usr/local/bin/agy",
      "--project",
      "default-cli-project",
      "--model",
      AGY_R15_VERIFY_MODEL,
      "--sandbox",
      "--disable-slash-commands",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "120s",
      "-p",
      AGY_R15_MODEL_PROMPT,
    ];
  }
  throw verifyError("AGY_R15_VERIFY_PHASE_INVALID", "verification phase is invalid");
}

export function buildAgyR15VerificationClientCreateArgs(options = {}) {
  const {
    bootstrapHostPort,
    bootstrapNonce,
    clientName,
    networkName,
    networkPrefix,
    oauthVolumeName,
    phase,
    profileHash,
    proxyPort,
    runId,
  } = options;
  const expectedClientName = typeof clientName === "string" &&
    SUFFIX_PATTERN.test(clientName.slice(-12))
    ? `cc-suite-agy-r15-${phase}-${clientName.slice(-12)}`
    : null;
  if (
    !validPort(bootstrapHostPort) ||
    !NONCE_PATTERN.test(bootstrapNonce || "") ||
    !CLIENT_NAME_PATTERN.test(clientName || "") ||
    clientName !== expectedClientName ||
    networkName !== AGY_HOST_PROXY_NETWORK ||
    !validPrivatePrefix(networkPrefix) ||
    !VOLUME_NAME_PATTERN.test(oauthVolumeName || "") ||
    profileHash !== AGY_R15_VERIFY_PROFILE_HASHES[phase] ||
    !validPort(proxyPort) ||
    !NONCE_PATTERN.test(runId || "")
  ) {
    throw verifyError("AGY_R15_VERIFY_SCOPE_INVALID", "verification scope is invalid");
  }
  const workload = workloadArguments(phase);
  return [
    "create",
    "--name",
    clientName,
    "--label",
    "cc-suite.owner=cc-suite",
    "--label",
    `cc-suite.purpose=agy-r15-${phase}-verification`,
    "--network",
    networkName,
    "--no-dns",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "KILL",
    "--mount",
    `type=volume,source=${oauthVolumeName},target=/home/agy`,
    "--publish",
    `127.0.0.1:${bootstrapHostPort}:${AGY_R15_BOOTSTRAP_CONTAINER_PORT}`,
    "--env",
    `AGY_PROXY_PORT=${proxyPort}`,
    "--env",
    `AGY_NETWORK_PREFIX=${networkPrefix}`,
    "--env",
    `AGY_BOOTSTRAP_PORT=${AGY_R15_BOOTSTRAP_CONTAINER_PORT}`,
    "--env",
    `AGY_BOOTSTRAP_NONCE=${bootstrapNonce}`,
    "--env",
    `AGY_RUN_ID=${runId}`,
    "--env",
    `AGY_PROFILE_HASH=${profileHash}`,
    "--env",
    `AGY_OAUTH_VOLUME_NAME=${oauthVolumeName}`,
    "--env",
    "SSH_CONNECTION=127.0.0.1 1 127.0.0.1 22",
    AGY_R15_CAPSULE_IMAGE,
    ...workload,
  ];
}

export function buildAgyR15CaptureSpec(clientName) {
  if (!CLIENT_NAME_PATTERN.test(clientName || "")) {
    throw verifyError("AGY_R15_VERIFY_SCOPE_INVALID", "verification client is invalid");
  }
  return {
    command: "container",
    args: ["start", "--attach", clientName],
    options: {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

const STDERR_CLASSIFIERS = Object.freeze([
  ["authentication", /(?:auth(?:entication|orization)?|oauth|sign[ -]?in|token)/i],
  ["project", /(?:default-cli-project|project[^\n]*(?:invalid|missing|not found|unknown))/i],
  ["quota", /(?:quota|resource exhausted|rate limit|\b429\b)/i],
  ["permission", /(?:permission|forbidden|access denied|\b403\b)/i],
  ["network", /(?:network|proxy|connect|dns|tls|certificate)/i],
  ["timeout", /(?:timeout|timed out|deadline exceeded)/i],
  ["sandbox", /sandbox/i],
  ["model", /(?:model[^\n]*(?:invalid|missing|not found|unknown|unavailable))/i],
  ["arguments", /(?:unknown flag|invalid argument|unrecognized|usage of agy)/i],
  ["workspace", /(?:workspace|working directory|\bcwd\b)/i],
]);

export function summarizeAgyR15Capture(capture = {}) {
  const stdout = typeof capture.stdout === "string" ? capture.stdout : "";
  const stderr = typeof capture.stderr === "string" ? capture.stderr : "";
  const findings = [];
  const workloadOutput = extractWorkloadOutput(stdout, findings);
  const eventCounts = {};
  let malformedJsonLineCount = 0;
  let initHasModel = false;
  let initWorkspaceExact = false;
  let resultHasResponse = false;
  let resultHasUsage = false;
  let resultStatus = null;
  let resultError = "";
  let completionClockDeltaMs = null;

  for (const line of workloadOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const name = typeof event?.event === "string" ? event.event : "unknown";
      eventCounts[name] = (eventCounts[name] || 0) + 1;
      if (name === "init") {
        initHasModel ||= typeof event.init?.model === "string" &&
          event.init.model.length > 0;
        initWorkspaceExact ||= event.init?.cwd === "/workspace";
      }
      if (name === "result") {
        resultHasResponse ||= typeof event.result?.response === "string";
        resultHasUsage ||= Boolean(event.result?.usage) &&
          typeof event.result.usage === "object";
        if (typeof event.result?.status === "string") {
          resultStatus = event.result.status;
        }
        if (event.result?.error !== undefined && event.result?.error !== null) {
          resultError = typeof event.result.error === "string"
            ? event.result.error
            : JSON.stringify(event.result.error);
        }
      }
    } catch {
      malformedJsonLineCount += 1;
    }
  }

  if (capture.observedAt instanceof Date &&
      Number.isFinite(capture.observedAt.getTime())) {
    const completionLine = stdout.split(/\r?\n/).find((line) =>
      line.startsWith(AGY_SUPERVISOR_RECORD_PREFIX)
    );
    try {
      const completion = JSON.parse(
        completionLine.slice(AGY_SUPERVISOR_RECORD_PREFIX.length)
      );
      const finishedAt = Date.parse(completion.finishedAt);
      if (Number.isFinite(finishedAt)) {
        completionClockDeltaMs = finishedAt - capture.observedAt.getTime();
      }
    } catch {
      completionClockDeltaMs = null;
    }
  }

  return {
    exitCode: Number.isInteger(capture.exitCode) ? capture.exitCode : null,
    signal: typeof capture.signal === "string" ? capture.signal : null,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stderrSha256: stderr ? sha256(stderr) : null,
    stderrClasses: STDERR_CLASSIFIERS
      .filter(([, pattern]) => pattern.test(stderr))
      .map(([name]) => name),
    eventCounts,
    malformedJsonLineCount,
    initHasModel,
    initWorkspaceExact,
    resultHasResponse,
    resultHasUsage,
    resultStatus,
    resultErrorBytes: Buffer.byteLength(resultError, "utf8"),
    resultErrorSha256: resultError ? sha256(resultError) : null,
    resultErrorClasses: STDERR_CLASSIFIERS
      .filter(([, pattern]) => pattern.test(resultError))
      .map(([name]) => name),
    completionClockDeltaMs,
  };
}

function extractWorkloadOutput(stdout, findings) {
  if (typeof stdout !== "string") {
    addFinding(findings, "AGY_R15_VERIFY_OUTPUT_INVALID");
    return "";
  }
  if (Buffer.byteLength(stdout, "utf8") > AGY_R15_VERIFY_MAX_OUTPUT_BYTES) {
    addFinding(findings, "AGY_R15_VERIFY_OUTPUT_TOO_LARGE");
    return "";
  }
  const lines = stdout.split(/\r?\n/);
  const completionIndex = lines.findIndex((line) =>
    line.startsWith(AGY_SUPERVISOR_RECORD_PREFIX)
  );
  if (completionIndex < 0) return stdout.trim();
  return lines.slice(0, completionIndex).join("\n").trim();
}

function auditLifecycle(stdout, expected, findings) {
  const lifecycle = auditAgySupervisorCompletion(stdout, expected);
  for (const finding of lifecycle.findings) addFinding(findings, finding);
  if (!lifecycle.attributed || !lifecycle.workloadSucceeded) {
    addFinding(findings, "AGY_R15_VERIFY_WORKLOAD_NOT_PROVEN");
  }
  return lifecycle;
}

export function auditAgyR15ModelsTranscript(stdout, expected = {}) {
  const findings = [];
  auditLifecycle(stdout, expected, findings);
  const workloadOutput = extractWorkloadOutput(stdout, findings);
  if (
    /(?:please sign in|not signed in|not authenticated|accounts\.google\.com|oauth|authorization code|https?:\/\/)/i.test(
      workloadOutput
    )
  ) {
    addFinding(findings, "AGY_R15_MODELS_AUTH_NOT_PROVEN");
  }
  const models = new Set(
    workloadOutput.match(/\bgemini-[a-z0-9]+(?:[.-][a-z0-9]+)*\b/g) || []
  );
  if (models.size === 0) addFinding(findings, "AGY_R15_MODELS_EMPTY");
  if (!models.has(AGY_R15_VERIFY_MODEL)) {
    addFinding(findings, "AGY_R15_VERIFY_MODEL_UNAVAILABLE");
  }
  const ready = findings.length === 0;
  return {
    ready,
    authenticated: ready,
    modelCount: ready ? models.size : 0,
    requiredModelPresent: models.has(AGY_R15_VERIFY_MODEL),
    outputSha256: ready ? sha256(workloadOutput) : null,
    findings,
  };
}

export function auditAgyR15ModelTranscript(stdout, expected = {}) {
  const findings = [];
  auditLifecycle(stdout, expected, findings);
  const workloadOutput = extractWorkloadOutput(stdout, findings);
  const state = createAgyEventState();
  let finalized = null;
  if (workloadOutput) {
    try {
      for (const line of workloadOutput.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event?.event === "step_update" && event?.step_update?.step_type === "tool") {
          const name = event.step_update?.tool_info?.name ?? event.step_update?.tool_name;
          if (name !== "finish") addFinding(findings, "AGY_R15_MODEL_TOOL_USED");
          if (
            name === "finish" &&
            String(event.step_update?.state || "").toUpperCase() !== "SUCCESS"
          ) {
            addFinding(findings, "AGY_R15_MODEL_TOOL_STATE_INVALID");
          }
        }
        consumeAgyEventLine(state, line);
      }
      finalized = finalizeAgyEventState(state);
    } catch {
      addFinding(findings, "AGY_R15_MODEL_STREAM_INVALID");
    }
  } else {
    addFinding(findings, "AGY_R15_MODEL_STREAM_INVALID");
  }
  if (finalized?.runtime?.cwd !== "/workspace" || !finalized?.runtime?.model) {
    addFinding(findings, "AGY_R15_MODEL_RUNTIME_INVALID");
  }
  if (finalized?.runtime?.model &&
      finalized.runtime.model !== AGY_R15_VERIFY_MODEL) {
    addFinding(findings, "AGY_R15_MODEL_IDENTITY_MISMATCH");
  }
  if (finalized?.rawOutput !== AGY_R15_MODEL_MARKER) {
    addFinding(findings, "AGY_R15_MODEL_MARKER_MISMATCH");
  }
  const totalTokens = finalized?.usage?.total_tokens;
  if (!Number.isInteger(totalTokens) || totalTokens < 1) {
    addFinding(findings, "AGY_R15_MODEL_USAGE_INVALID");
  }
  const ready = findings.length === 0;
  return {
    ready,
    realModelCallProven: ready,
    markerMatched: ready,
    model: ready ? finalized.runtime.model : null,
    totalTokens: ready ? totalTokens : null,
    responseSha256: ready ? sha256(finalized.rawOutput) : null,
    findings,
  };
}
