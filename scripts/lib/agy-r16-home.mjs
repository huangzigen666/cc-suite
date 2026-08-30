import { createHash } from "node:crypto";
import path from "node:path";

export const AGY_R16_HOME_VOLUME_SIZE = "256M";
export const AGY_R16_HOME_VOLUME_SIZE_BYTES = 256 * 1024 * 1024;
export const AGY_R16_TOKEN_RELATIVE_PATH =
  ".gemini/antigravity-cli/antigravity-oauth-token";

const HOME_VOLUME_PATTERN = /^cc-suite-agy-r16-home-[a-f0-9]{12}$/;
const HELPER_NAME_PATTERN = /^cc-suite-agy-r16-home-helper-[a-f0-9]{12}$/;
const OAUTH_VOLUME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONVERSATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE_PATTERN = /^cc-suite\/agy-r16-egress:[a-zA-Z0-9._-]+$/;
const HOME_LABELS = Object.freeze({
  "cc-suite.owner": "cc-suite",
  "cc-suite.purpose": "agy-r16-ephemeral-home",
  "cc-suite.schema": "1",
  "cc-suite.sensitivity": "transient",
});

function homeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function tokenShape(value) {
  if (!exactKeys(value, ["auth_method", "token"])) return null;
  if (!exactKeys(value.token, ["access_token", "expiry", "refresh_token", "token_type"])) {
    return null;
  }
  if (
    !boundedString(value.auth_method, 64) ||
    !boundedString(value.token.access_token, 8192) ||
    !boundedString(value.token.refresh_token, 8192) ||
    !boundedString(value.token.token_type, 64) ||
    !boundedString(value.token.expiry, 128)
  ) return null;
  const expiryMs = Date.parse(value.token.expiry);
  if (!Number.isFinite(expiryMs)) return null;
  return { expiryMs };
}

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function auditAgyR16ToolTranscript(raw) {
  const findings = [];
  const counts = {};
  const targets = [];
  if (typeof raw !== "string" || raw.length < 1 || Buffer.byteLength(raw) > 4 * 1024 * 1024) {
    return { ready: false, findings: ["AGY_R16_TOOL_TRANSCRIPT_INVALID"] };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (!findings.includes("AGY_R16_TOOL_TRANSCRIPT_INVALID")) {
        findings.push("AGY_R16_TOOL_TRANSCRIPT_INVALID");
      }
      continue;
    }
    if (!Array.isArray(event?.tool_calls)) continue;
    for (const call of event.tool_calls) {
      const name = call?.name;
      const target = call?.args?.TargetFile;
      if (!["replace_file_content", "write_to_file"].includes(name)) {
        if (!findings.includes("AGY_R16_TOOL_NOT_ALLOWED")) {
          findings.push("AGY_R16_TOOL_NOT_ALLOWED");
        }
        continue;
      }
      counts[name] = (counts[name] || 0) + 1;
      if (
        typeof target !== "string" ||
        path.posix.normalize(target) !== target ||
        !target.startsWith("/workspace/") ||
        target === "/workspace/.git" || target.startsWith("/workspace/.git/")
      ) {
        if (!findings.includes("AGY_R16_TOOL_TARGET_OUTSIDE_WORKSPACE")) {
          findings.push("AGY_R16_TOOL_TARGET_OUTSIDE_WORKSPACE");
        }
      } else {
        targets.push(target);
      }
    }
  }
  const targetCount = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (targetCount < 1) findings.push("AGY_R16_TOOL_CALL_NOT_PROVEN");
  const uniqueTargets = [...new Set(targets)].sort();
  if (uniqueTargets.length > 128) findings.push("AGY_R16_TOOL_TARGET_SET_TOO_LARGE");
  const ready = findings.length === 0 && targets.length === targetCount;
  return {
    ready,
    counts,
    findings,
    targetCount,
    targets: uniqueTargets,
    targetsSha256: sha256(JSON.stringify(targets.sort())),
  };
}

export function parseAgyR16TokenBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer.length > 16 * 1024) {
    throw homeError("AGY_R16_TOKEN_INVALID", "OAuth token byte shape is invalid");
  }
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw homeError("AGY_R16_TOKEN_INVALID", "OAuth token JSON is invalid");
  }
  const shape = tokenShape(value);
  if (!shape) throw homeError("AGY_R16_TOKEN_INVALID", "OAuth token schema is invalid");
  return { hash: sha256(buffer), shape, value };
}

export function auditAgyR16TokenTransition(beforeBuffer, afterBuffer, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw homeError("AGY_R16_TOKEN_TRANSITION_INVALID", "token transition time is invalid");
  }
  const before = parseAgyR16TokenBuffer(beforeBuffer);
  const after = parseAgyR16TokenBuffer(afterBuffer);
  if (before.hash === after.hash) {
    return { ready: true, changed: false, beforeHash: before.hash, afterHash: after.hash };
  }
  const sameStableFields =
    before.value.auth_method === after.value.auth_method &&
    before.value.token.refresh_token === after.value.token.refresh_token &&
    before.value.token.token_type === after.value.token.token_type;
  const expiryIsFresh = after.shape.expiryMs > before.shape.expiryMs &&
    after.shape.expiryMs >= now.getTime() + 5 * 60 * 1000 &&
    after.shape.expiryMs <= now.getTime() + 24 * 60 * 60 * 1000;
  if (
    !sameStableFields ||
    before.value.token.access_token === after.value.token.access_token ||
    !expiryIsFresh
  ) {
    throw homeError(
      "AGY_R16_TOKEN_TRANSITION_INVALID",
      "token change is not a bounded OAuth refresh"
    );
  }
  return { ready: true, changed: true, beforeHash: before.hash, afterHash: after.hash };
}

export function buildAgyR16HomeVolumeCreateArgs(homeVolumeName) {
  if (!HOME_VOLUME_PATTERN.test(homeVolumeName || "")) {
    throw homeError("AGY_R16_HOME_VOLUME_NAME_INVALID", "home volume name is invalid");
  }
  return [
    "volume", "create",
    "--label", "cc-suite.owner=cc-suite",
    "--label", "cc-suite.purpose=agy-r16-ephemeral-home",
    "--label", "cc-suite.schema=1",
    "--label", "cc-suite.sensitivity=transient",
    "-s", AGY_R16_HOME_VOLUME_SIZE,
    homeVolumeName,
  ];
}

export function auditAgyR16HomeVolume(rawJson, expectedName) {
  let descriptor;
  try {
    const parsed = JSON.parse(rawJson);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  const configuration = descriptor?.configuration;
  const labels = configuration?.labels;
  const exactLabels = labels !== null && typeof labels === "object" &&
    !Array.isArray(labels) && JSON.stringify(Object.entries(labels).sort()) ===
      JSON.stringify(Object.entries(HOME_LABELS).sort());
  const ready = HOME_VOLUME_PATTERN.test(expectedName || "") &&
    descriptor?.id === expectedName && configuration?.name === expectedName &&
    configuration?.driver === "local" && configuration?.format === "ext4" &&
    configuration?.sizeInBytes === AGY_R16_HOME_VOLUME_SIZE_BYTES &&
    configuration?.options?.size === AGY_R16_HOME_VOLUME_SIZE && exactLabels;
  return {
    ready,
    findings: ready ? [] : ["AGY_R16_HOME_VOLUME_AUDIT_FAILED"],
  };
}

function baseHelperArgs({ helperImage, helperName, homeVolumeName }) {
  if (
    !IMAGE_PATTERN.test(helperImage || "") ||
    !HELPER_NAME_PATTERN.test(helperName || "") ||
    !HOME_VOLUME_PATTERN.test(homeVolumeName || "")
  ) {
    throw homeError("AGY_R16_HOME_HELPER_SCOPE_INVALID", "home helper scope is invalid");
  }
  return [
    "run", "--rm", "--progress", "none",
    "--name", helperName,
    "--label", "cc-suite.owner=cc-suite",
    "--label", "cc-suite.purpose=agy-r16-home-helper",
    "--network", "default", "--no-dns", "--read-only", "--tmpfs", "/tmp",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--cap-add", "FOWNER",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "DAC_READ_SEARCH",
    "--user", "0:0",
    "--entrypoint", "/usr/local/bin/node",
  ];
}

export function buildAgyR16HomeSeedArgs(options = {}) {
  const { helperImage, helperName, homeVolumeName, oauthVolumeName } = options;
  if (!OAUTH_VOLUME_PATTERN.test(oauthVolumeName || "")) {
    throw homeError("AGY_R16_HOME_HELPER_SCOPE_INVALID", "OAuth volume is invalid");
  }
  return [
    ...baseHelperArgs({ helperImage, helperName, homeVolumeName }),
    "--mount", `type=volume,source=${oauthVolumeName},target=/source,readonly`,
    "--mount", `type=volume,source=${homeVolumeName},target=/target`,
    helperImage,
    "/app/agy-r16-home-helper.mjs", "seed",
  ];
}

export function buildAgyR16HomeMergeArgs(options = {}) {
  const {
    expectedDurableHash,
    helperImage,
    helperName,
    homeVolumeName,
    oauthVolumeName,
    runId,
  } = options;
  if (
    !OAUTH_VOLUME_PATTERN.test(oauthVolumeName || "") ||
    !RUN_ID_PATTERN.test(runId || "") ||
    !SHA256_PATTERN.test(expectedDurableHash || "")
  ) {
    throw homeError("AGY_R16_HOME_HELPER_SCOPE_INVALID", "token merge scope is invalid");
  }
  return [
    ...baseHelperArgs({ helperImage, helperName, homeVolumeName }),
    "--mount", `type=volume,source=${homeVolumeName},target=/source,readonly`,
    "--mount", `type=volume,source=${oauthVolumeName},target=/target`,
    helperImage,
    "/app/agy-r16-home-helper.mjs", "merge", runId, expectedDurableHash,
  ];
}

export function buildAgyR16HomeToolAuditArgs(options = {}) {
  const {
    conversationId,
    helperImage,
    helperName,
    homeVolumeName,
  } = options;
  if (!CONVERSATION_ID_PATTERN.test(conversationId || "")) {
    throw homeError("AGY_R16_HOME_HELPER_SCOPE_INVALID", "conversation ID is invalid");
  }
  return [
    ...baseHelperArgs({ helperImage, helperName, homeVolumeName }),
    "--mount", `type=volume,source=${homeVolumeName},target=/source,readonly`,
    helperImage,
    "/app/agy-r16-home-helper.mjs", "audit-tools", conversationId,
  ];
}

export function parseAgyR16HomeHelperResult(stdout, expectedMode) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  let result;
  try {
    result = lines.length === 1 ? JSON.parse(lines[0]) : null;
  } catch {
    result = null;
  }
  const validHash = (value) => SHA256_PATTERN.test(value || "");
  const ready = expectedMode === "seed"
    ? exactKeys(result, ["sourceHash", "status", "targetHash"]) &&
      result.status === "seeded" && validHash(result.sourceHash) &&
      result.sourceHash === result.targetHash
    : expectedMode === "merge" ?
      exactKeys(result, ["afterHash", "beforeHash", "changed", "status"]) &&
      result.status === "merged" && typeof result.changed === "boolean" &&
      validHash(result.beforeHash) && validHash(result.afterHash)
      : expectedMode === "audit-tools" &&
        exactKeys(result, ["counts", "status", "targetCount", "targets", "targetsSha256"]) &&
        result.status === "tool-audited" &&
        result.counts !== null && typeof result.counts === "object" &&
        !Array.isArray(result.counts) &&
        Number.isInteger(result.targetCount) && result.targetCount >= 1 &&
        Array.isArray(result.targets) && result.targets.length >= 1 &&
        result.targets.length <= 128 &&
        result.targets.every((target) =>
          typeof target === "string" && target.startsWith("/workspace/")
        ) &&
        validHash(result.targetsSha256);
  if (!ready) {
    throw homeError("AGY_R16_HOME_HELPER_RESULT_INVALID", "home helper result is invalid");
  }
  return result;
}

export function isAgyR16HomeVolumeName(value) {
  return HOME_VOLUME_PATTERN.test(value || "");
}
