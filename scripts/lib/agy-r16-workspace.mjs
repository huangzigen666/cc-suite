import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
} from "./agy-r15-auth.mjs";
import { AGY_HOST_PROXY_NETWORK } from "./agy-host-proxy-bridge.mjs";
import {
  AGY_SUPERVISOR_MAX_VM_CLOCK_SKEW_MS,
  AGY_SUPERVISOR_RECORD_PREFIX,
  auditAgySupervisorCompletion,
} from "./agy-lifecycle.mjs";
import {
  AGY_OAUTH_VOLUME_SIZE_BYTES,
  auditAgyOAuthVolumeDescriptor,
} from "./agy-oauth-volume.mjs";
import {
  AGY_PROXY_FIXED_LIMITS,
  AGY_PROXY_POLICY_SCHEMA_VERSION,
} from "./agy-proxy-policy.mjs";
import { auditAgyR16ProxyPolicy } from "./agy-r16-proxy-policy.mjs";
import { isAgyR16HomeVolumeName } from "./agy-r16-home.mjs";

export const AGY_R16_CAPSULE_IMAGE = "cc-suite/agy-r16-capsule:1.1.14";
export const AGY_R16_CAPSULE_INDEX_DIGEST =
  "sha256:5a1fae53d2d35098c261460144675989f47712c0ab28e0dc4587a50c6d2932d1";
export const AGY_R16_CAPSULE_ARM64_DIGEST =
  "sha256:d9bcdf32cfe312918c225bba33d6951225a2c455deff443fc912baa541263c27";
export const AGY_R16_AGY_VERSION = "1.1.14";
export const AGY_R16_PROJECT = "default-cli-project";
export const AGY_R16_PROXY_IMAGE = "cc-suite/agy-r16-egress:probe";
export const AGY_R16_MIN_REFRESH_AGE_MS = 2 * 60 * 60 * 1000;
export const AGY_R16_MAX_VOLUME_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const AGY_R16_MAX_PROMPT_BYTES = 128 * 1024;
export const AGY_R16_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const SUFFIX_PATTERN = /^[a-f0-9]{12}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OAUTH_VOLUME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const CLIENT_PATTERN = /^cc-suite-agy-r16-workspace-[a-f0-9]{12}$/;
const PROXY_PATTERN = /^cc-suite-agy-r16-proxy-[a-f0-9]{12}$/;
const HOME_HELPER_PATTERN = /^cc-suite-agy-r16-home-helper-[a-f0-9]{12}$/;
const MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const AGY_R16_IMAGE_DIGESTS = Object.freeze({
  [AGY_R16_CAPSULE_IMAGE]: AGY_R16_CAPSULE_INDEX_DIGEST,
  [AGY_R16_PROXY_IMAGE]:
    "sha256:239b9520901ddeef0dcb624d64c2eb46dd9aff1ce4b8d3e3cc2f6a729681d2fc",
});
export const AGY_R16_IMAGE_VARIANT_DIGESTS = Object.freeze({
  [AGY_R16_CAPSULE_IMAGE]: AGY_R16_CAPSULE_ARM64_DIGEST,
  [AGY_R16_PROXY_IMAGE]:
    "sha256:12fcf923cb710b8a23343bbdb149253150c90cfd23933d2373fd9bc16281cb8c",
});

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pathStaysWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
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

function canonicalWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw workspaceError("AGY_R16_WORKSPACE_INVALID", "workspace must be absolute");
  }
  let canonical;
  try {
    canonical = fs.realpathSync.native(value);
  } catch {
    throw workspaceError("AGY_R16_WORKSPACE_INVALID", "workspace does not exist");
  }
  if (
    canonical === path.parse(canonical).root ||
    /[\u0000\r\n,]/.test(canonical) ||
    !fs.statSync(canonical).isDirectory()
  ) {
    throw workspaceError("AGY_R16_WORKSPACE_INVALID", "workspace path is unsafe");
  }
  const gitLink = path.join(canonical, ".git");
  let gitStat;
  try {
    gitStat = fs.lstatSync(gitLink);
  } catch {
    throw workspaceError(
      "AGY_R16_WORKSPACE_GIT_LINK_INVALID",
      "workspace must contain a linked-worktree .git file"
    );
  }
  if (!gitStat.isFile() || gitStat.isSymbolicLink()) {
    throw workspaceError(
      "AGY_R16_WORKSPACE_GIT_LINK_INVALID",
      "workspace .git must be a regular linked-worktree file"
    );
  }
  return canonical;
}

export function buildAgyR16ResourceNames(suffix) {
  if (!SUFFIX_PATTERN.test(suffix || "")) {
    throw workspaceError("AGY_R16_RESOURCE_SUFFIX_INVALID", "resource suffix is invalid");
  }
  return {
    client: `cc-suite-agy-r16-workspace-${suffix}`,
    home: `cc-suite-agy-r16-home-${suffix}`,
    homeHelper: `cc-suite-agy-r16-home-helper-${suffix}`,
    network: AGY_HOST_PROXY_NETWORK,
    proxy: `cc-suite-agy-r16-proxy-${suffix}`,
  };
}

export function auditAgyR16Images(rawJson) {
  const findings = [];
  let descriptors;
  try {
    descriptors = JSON.parse(rawJson);
  } catch {
    return { ready: false, findings: ["AGY_R16_IMAGE_INSPECT_JSON_INVALID"] };
  }
  const expectedNames = Object.keys(AGY_R16_IMAGE_DIGESTS).sort();
  if (!Array.isArray(descriptors) || descriptors.length !== expectedNames.length) {
    return { ready: false, findings: ["AGY_R16_IMAGE_SET_INVALID"] };
  }
  const byName = new Map();
  for (const descriptor of descriptors) {
    const name = descriptor?.configuration?.name;
    if (typeof name !== "string" || byName.has(name)) {
      addFinding(findings, "AGY_R16_IMAGE_SET_INVALID");
    } else {
      byName.set(name, descriptor);
    }
  }
  for (const name of expectedNames) {
    const descriptor = byName.get(name);
    if (
      descriptor?.configuration?.descriptor?.digest !==
        AGY_R16_IMAGE_DIGESTS[name]
    ) {
      addFinding(findings, "AGY_R16_IMAGE_DIGEST_MISMATCH");
    }
    const variants = descriptor?.variants;
    const variant = Array.isArray(variants) && variants.length === 1
      ? variants[0]
      : null;
    if (
      variant?.platform?.architecture !== "arm64" ||
      variant?.platform?.os !== "linux" ||
      variant?.digest !== AGY_R16_IMAGE_VARIANT_DIGESTS[name]
    ) {
      addFinding(findings, "AGY_R16_IMAGE_VARIANT_MISMATCH");
    }
  }
  return { ready: findings.length === 0, findings };
}

export function buildAgyR16Profile({
  hostProxyContract,
  model,
  prompt,
  workspaceFingerprint,
} = {}) {
  if (
    !SHA256_PATTERN.test(hostProxyContract || "") ||
    !MODEL_PATTERN.test(model || "") ||
    typeof prompt !== "string" ||
    Buffer.byteLength(prompt, "utf8") < 1 ||
    Buffer.byteLength(prompt, "utf8") > AGY_R16_MAX_PROMPT_BYTES ||
    !SHA256_PATTERN.test(workspaceFingerprint || "")
  ) {
    throw workspaceError("AGY_R16_PROFILE_SCOPE_INVALID", "workspace profile scope is invalid");
  }
  const promptSha256 = sha256(prompt);
  const profileHash = sha256(JSON.stringify({
    allowedHosts: AGY_R15_AUTH_HOSTS,
    capsuleDigest: AGY_R16_CAPSULE_INDEX_DIGEST,
    capsuleImage: AGY_R16_CAPSULE_IMAGE,
    hostProxyContract,
    model,
    project: AGY_R16_PROJECT,
    promptSha256,
    proxyImage: AGY_R16_PROXY_IMAGE,
    schemaVersion: 1,
    workspaceFingerprint,
  }));
  return { profileHash, promptSha256 };
}

export function auditAgyR16OAuthVolume(rawJson, expected = {}) {
  const findings = [];
  if (
    !OAUTH_VOLUME_PATTERN.test(expected.expectedName || "") ||
    typeof expected.homeDirectory !== "string" ||
    !path.isAbsolute(expected.homeDirectory) ||
    !(expected.now instanceof Date) ||
    !Number.isFinite(expected.now.getTime())
  ) {
    return { ready: false, refreshAgeProven: false, findings: [
      "AGY_R16_OAUTH_VOLUME_SCOPE_INVALID",
    ] };
  }
  let descriptor;
  try {
    const parsed = JSON.parse(rawJson);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  if (!descriptor) {
    return { ready: false, refreshAgeProven: false, findings: [
      "AGY_R16_OAUTH_VOLUME_DESCRIPTOR_INVALID",
    ] };
  }
  const base = auditAgyOAuthVolumeDescriptor(descriptor, {
    expectedName: expected.expectedName,
    expectedSizeInBytes: AGY_OAUTH_VOLUME_SIZE_BYTES,
    expectedSourceRoot: path.join(
      expected.homeDirectory,
      "Library",
      "Application Support",
      "com.apple.container",
      "volumes"
    ),
    maxCreationAgeMs: AGY_R16_MAX_VOLUME_AGE_MS,
    now: expected.now,
  });
  findings.push(...base.findings);
  const creationTime = Date.parse(descriptor.configuration?.creationDate || "");
  const ageMs = Number.isFinite(creationTime)
    ? expected.now.getTime() - creationTime
    : Number.NaN;
  const refreshAgeProven = Number.isFinite(ageMs) &&
    ageMs >= AGY_R16_MIN_REFRESH_AGE_MS;
  if (!refreshAgeProven) addFinding(findings, "AGY_R16_REFRESH_AGE_NOT_PROVEN");
  return {
    ready: findings.length === 0,
    refreshAgeProven,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    findings,
  };
}

export function buildAgyR16ClientCreateArgs(options = {}) {
  const {
    bootstrapHostPort,
    bootstrapNonce,
    clientName,
    model,
    networkName,
    networkPrefix,
    homeVolumeName,
    profileHash,
    prompt,
    proxyPort,
    runId,
    timeoutMs,
    workspacePath,
  } = options;
  const workspace = canonicalWorkspace(workspacePath);
  if (
    !validPort(bootstrapHostPort) ||
    !NONCE_PATTERN.test(bootstrapNonce || "") ||
    !CLIENT_PATTERN.test(clientName || "") ||
    networkName !== AGY_HOST_PROXY_NETWORK ||
    !validPrivatePrefix(networkPrefix) ||
    !isAgyR16HomeVolumeName(homeVolumeName) ||
    !SHA256_PATTERN.test(profileHash || "") ||
    !validPort(proxyPort) ||
    !NONCE_PATTERN.test(runId || "") ||
    !MODEL_PATTERN.test(model || "") ||
    typeof prompt !== "string" ||
    Buffer.byteLength(prompt, "utf8") < 1 ||
    Buffer.byteLength(prompt, "utf8") > AGY_R16_MAX_PROMPT_BYTES ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000
  ) {
    throw workspaceError("AGY_R16_WORKSPACE_SCOPE_INVALID", "workspace run scope is invalid");
  }
  return [
    "create",
    "--name", clientName,
    "--label", "cc-suite.owner=cc-suite",
    "--label", "cc-suite.purpose=agy-r16-workspace-write",
    "--network", networkName,
    "--no-dns",
    "--read-only",
    "--tmpfs", "/tmp",
    "--cap-add", "NET_ADMIN",
    "--cap-add", "KILL",
    "--mount", `type=volume,source=${homeVolumeName},target=/home/agy`,
    "--mount", `type=bind,source=${workspace},target=/workspace`,
    "--read-only-path", "/workspace/.git",
    "--publish", `127.0.0.1:${bootstrapHostPort}:${AGY_R15_BOOTSTRAP_CONTAINER_PORT}`,
    "--env", `AGY_PROXY_PORT=${proxyPort}`,
    "--env", `AGY_NETWORK_PREFIX=${networkPrefix}`,
    "--env", `AGY_BOOTSTRAP_PORT=${AGY_R15_BOOTSTRAP_CONTAINER_PORT}`,
    "--env", `AGY_BOOTSTRAP_NONCE=${bootstrapNonce}`,
    "--env", `AGY_RUN_ID=${runId}`,
    "--env", `AGY_PROFILE_HASH=${profileHash}`,
    "--env", `AGY_OAUTH_VOLUME_NAME=${homeVolumeName}`,
    "--env", "SSH_CONNECTION=127.0.0.1 1 127.0.0.1 22",
    AGY_R16_CAPSULE_IMAGE,
    "/usr/local/bin/agy",
    "--project", AGY_R16_PROJECT,
    "--model", model,
    "--sandbox",
    "--disable-slash-commands",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--print-timeout", `${Math.max(1, Math.round(timeoutMs / 1000))}s`,
    "-p", prompt,
  ];
}

export function buildAgyR16AuthPolicy({
  clientIPv4,
  gatewayIPv4,
  listenPort,
  upstreamProxyUrl,
} = {}) {
  const policy = {
    allowedClientIPv4: clientIPv4,
    allowedHosts: [...AGY_R15_AUTH_HOSTS],
    limits: { ...AGY_PROXY_FIXED_LIMITS },
    listen: { host: "0.0.0.0", port: listenPort },
    schemaVersion: AGY_PROXY_POLICY_SCHEMA_VERSION,
    upstream: { url: upstreamProxyUrl },
  };
  const audit = auditAgyR16ProxyPolicy(policy, {
    expectedClientIPv4: clientIPv4,
    expectedGatewayIPv4: gatewayIPv4,
    expectedListenHost: "0.0.0.0",
    expectedUpstreamUrl: upstreamProxyUrl,
  });
  if (!audit.ready) {
    const error = workspaceError(
      "AGY_R16_PROXY_POLICY_INVALID",
      "R16 egress policy is invalid"
    );
    error.findings = audit.findings;
    throw error;
  }
  return audit;
}

export function buildAgyR16ProxyRunArgs(options = {}) {
  const { gatewayIPv4, networkName, policy, proxyName } = options;
  if (
    networkName !== AGY_HOST_PROXY_NETWORK ||
    !PROXY_PATTERN.test(proxyName || "") ||
    policy === null || typeof policy !== "object" || Array.isArray(policy)
  ) {
    throw workspaceError("AGY_R16_PROXY_SCOPE_INVALID", "R16 proxy scope is invalid");
  }
  const audit = auditAgyR16ProxyPolicy(policy, {
    expectedClientIPv4: policy.allowedClientIPv4,
    expectedGatewayIPv4: gatewayIPv4,
    expectedListenHost: "0.0.0.0",
    expectedUpstreamUrl: policy.upstream?.url,
  });
  if (
    !audit.ready ||
    JSON.stringify(audit.policy.allowedHosts) !== JSON.stringify(AGY_R15_AUTH_HOSTS)
  ) {
    const error = workspaceError(
      "AGY_R16_PROXY_POLICY_INVALID",
      "R16 proxy policy is invalid"
    );
    error.findings = audit.findings;
    throw error;
  }
  return [
    "run",
    "--detach",
    "--name", proxyName,
    "--label", "cc-suite.owner=cc-suite",
    "--label", "cc-suite.purpose=agy-r16-workspace-egress",
    "--network", networkName,
    "--read-only",
    "--tmpfs", "/tmp",
    "--cap-drop", "ALL",
    "--env", `AGY_PROXY_POLICY=${JSON.stringify(audit.policy)}`,
    AGY_R16_PROXY_IMAGE,
    "--policy-env", "AGY_PROXY_POLICY",
    "--expected-listen-host", "0.0.0.0",
    "--expected-client-ipv4", audit.policy.allowedClientIPv4,
    "--expected-gateway-ipv4", gatewayIPv4,
  ];
}

export function buildAgyR16CaptureSpec(clientName) {
  if (!CLIENT_PATTERN.test(clientName || "")) {
    throw workspaceError("AGY_R16_WORKSPACE_SCOPE_INVALID", "workspace client is invalid");
  }
  return {
    command: "container",
    args: ["start", "--attach", clientName],
    options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
  };
}

export function parseAgyR16ContainerIPv4(rawJson, expectedName, expectedNetwork) {
  if (!CLIENT_PATTERN.test(expectedName || "") || expectedNetwork !== AGY_HOST_PROXY_NETWORK) {
    throw workspaceError("AGY_R16_CLIENT_NETWORK_AUDIT_FAILED", "client scope is invalid");
  }
  let descriptor;
  try {
    const parsed = JSON.parse(rawJson);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  const networks = descriptor?.status?.networks;
  const address = Array.isArray(networks) && networks.length === 1
    ? networks[0]?.ipv4Address
    : null;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/24$/.exec(address || "");
  const ipv4 = match?.[1];
  if (
    descriptor?.id !== expectedName ||
    descriptor?.status?.state !== "running" ||
    !Array.isArray(networks) || networks.length !== 1 ||
    networks[0]?.network !== expectedNetwork ||
    !ipv4 || net.isIP(ipv4) !== 4
  ) {
    throw workspaceError("AGY_R16_CLIENT_NETWORK_AUDIT_FAILED", "client network audit failed");
  }
  return ipv4;
}

export function parseAgyR16ProxyIPv4(rawJson, expectedName, expectedNetwork) {
  if (!PROXY_PATTERN.test(expectedName || "") || expectedNetwork !== AGY_HOST_PROXY_NETWORK) {
    throw workspaceError("AGY_R16_PROXY_NETWORK_AUDIT_FAILED", "proxy scope is invalid");
  }
  let descriptor;
  try {
    const parsed = JSON.parse(rawJson);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    descriptor = null;
  }
  const networks = descriptor?.status?.networks;
  const address = Array.isArray(networks) && networks.length === 1
    ? networks[0]?.ipv4Address
    : null;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/24$/.exec(address || "");
  const ipv4 = match?.[1];
  if (
    descriptor?.id !== expectedName ||
    descriptor?.status?.state !== "running" ||
    !Array.isArray(networks) || networks.length !== 1 ||
    networks[0]?.network !== expectedNetwork ||
    !ipv4 || net.isIP(ipv4) !== 4
  ) {
    throw workspaceError(
      "AGY_R16_PROXY_NETWORK_AUDIT_FAILED",
      "proxy network audit failed"
    );
  }
  return ipv4;
}

export function auditAgyR16WorkspaceTranscript(stdout, expected = {}) {
  const findings = [];
  const toolCounts = {};
  const lifecycle = auditAgySupervisorCompletion(stdout, {
    cliExitCode: expected.cliExitCode,
    expectedProfileHash: expected.expectedProfileHash,
    expectedRunId: expected.expectedRunId,
    now: expected.now,
    maxClockSkewMs: AGY_SUPERVISOR_MAX_VM_CLOCK_SKEW_MS,
  });
  findings.push(...lifecycle.findings);
  const lines = typeof stdout === "string" ? stdout.split(/\r?\n/) : [];
  const completionIndex = lines.findIndex((line) =>
    line.startsWith(AGY_SUPERVISOR_RECORD_PREFIX)
  );
  const workloadOutput = completionIndex >= 0
    ? lines.slice(0, completionIndex).join("\n").trim()
    : "";
  if (Buffer.byteLength(workloadOutput, "utf8") > AGY_R16_MAX_OUTPUT_BYTES) {
    addFinding(findings, "AGY_R16_WORKSPACE_OUTPUT_TOO_LARGE");
  }
  let finalized = null;
  let diagnostic = null;
  if (workloadOutput) {
    try {
      const state = createAgyEventState();
      for (const line of workloadOutput.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event?.event === "result") {
          diagnostic = {
            status: typeof event.result?.status === "string"
              ? event.result.status.slice(0, 64)
              : null,
            response: typeof event.result?.response === "string"
              ? event.result.response.slice(0, 1_000)
              : null,
          };
        }
        if (event?.event === "step_update" && event?.step_update?.step_type === "tool") {
          const name = event.step_update?.tool_info?.name ??
            event.step_update?.tool_name ?? "unknown";
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
        consumeAgyEventLine(state, line);
      }
      finalized = finalizeAgyEventState(state);
    } catch (error) {
      addFinding(findings, error?.code || "AGY_R16_WORKSPACE_STREAM_INVALID");
      diagnostic = {
        ...(diagnostic || {}),
        code: error?.code || "AGY_R16_WORKSPACE_STREAM_INVALID",
        message: String(error?.message || "stream validation failed").slice(0, 500),
      };
    }
  } else {
    addFinding(findings, "AGY_R16_WORKSPACE_STREAM_INVALID");
  }
  if (finalized?.runtime?.cwd !== "/workspace") {
    addFinding(findings, "AGY_R16_WORKSPACE_RUNTIME_CWD_INVALID");
  }
  if (finalized?.runtime?.model !== expected.expectedModel) {
    addFinding(findings, "AGY_R16_WORKSPACE_MODEL_MISMATCH");
  }
  const totalTokens = finalized?.usage?.total_tokens;
  if (!Number.isInteger(totalTokens) || totalTokens < 1) {
    addFinding(findings, "AGY_R16_WORKSPACE_USAGE_INVALID");
  }
  const ready = findings.length === 0 && lifecycle.workloadSucceeded;
  const observedAtMs = expected.now instanceof Date ? expected.now.getTime() : null;
  const finishedAtMs = Date.parse(lifecycle.completion?.finishedAt || "");
  return {
    ready,
    conversationId: ready ? finalized.conversationId : null,
    rawOutput: ready ? finalized.rawOutput : "",
    runtime: ready ? finalized.runtime : null,
    totalTokens: ready ? totalTokens : null,
    toolCounts,
    workloadSha256: workloadOutput ? sha256(workloadOutput) : null,
    lifecycleTiming: Number.isFinite(finishedAtMs) && Number.isFinite(observedAtMs)
      ? {
          finishedAt: lifecycle.completion.finishedAt,
          observedAt: expected.now.toISOString(),
          skewMs: finishedAtMs - observedAtMs,
        }
      : null,
    diagnostic,
    findings,
  };
}

export function auditAgyR16WorkspaceMutationBinding({
  runId,
  toolTargets,
  workspacePath,
} = {}) {
  const findings = [];
  let workspace;
  if (!NONCE_PATTERN.test(runId || "") || !Array.isArray(toolTargets) ||
      toolTargets.length < 1 || toolTargets.length > 128) {
    return { ready: false, bindings: [], findings: [
      "AGY_R16_MUTATION_BINDING_SCOPE_INVALID",
    ] };
  }
  try {
    workspace = canonicalWorkspace(workspacePath);
  } catch {
    return { ready: false, bindings: [], findings: [
      "AGY_R16_MUTATION_BINDING_SCOPE_INVALID",
    ] };
  }
  const uniqueTargets = [...new Set(toolTargets)].sort();
  if (
    uniqueTargets.length !== toolTargets.length ||
    uniqueTargets.some((target) =>
      typeof target !== "string" || path.posix.normalize(target) !== target ||
      !target.startsWith("/workspace/") || target.startsWith("/workspace/.git/")
    )
  ) {
    return { ready: false, bindings: [], findings: [
      "AGY_R16_MUTATION_BINDING_TARGET_INVALID",
    ] };
  }

  const status = spawnSync("git", [
    "-C", workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all",
  ], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (status.status !== 0 || status.stderr) {
    return { ready: false, bindings: [], findings: [
      "AGY_R16_WORKSPACE_INVENTORY_FAILED",
    ] };
  }
  const records = status.stdout ? status.stdout.split("\0").filter(Boolean) : [];
  const changedTargets = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") {
      addFinding(findings, "AGY_R16_WORKSPACE_STATUS_INVALID");
      continue;
    }
    const statusCode = record.slice(0, 2);
    if (/[RC]/.test(statusCode)) {
      addFinding(findings, "AGY_R16_WORKSPACE_RENAME_NOT_ALLOWED");
      index += 1;
      continue;
    }
    if (statusCode.includes("D")) {
      addFinding(findings, "AGY_R16_WORKSPACE_DELETE_NOT_ALLOWED");
      continue;
    }
    const relative = record.slice(3);
    if (!relative || path.isAbsolute(relative) || relative.includes("\0")) {
      addFinding(findings, "AGY_R16_WORKSPACE_STATUS_INVALID");
      continue;
    }
    changedTargets.push(`/workspace/${relative.split(path.sep).join("/")}`);
  }
  changedTargets.sort();
  if (JSON.stringify(changedTargets) !== JSON.stringify(uniqueTargets)) {
    addFinding(findings, "AGY_R16_TOOL_FILESYSTEM_TARGET_MISMATCH");
  }

  const bindings = [];
  for (const target of uniqueTargets) {
    const relative = target.slice("/workspace/".length);
    const candidate = path.resolve(workspace, ...relative.split("/"));
    let canonical;
    let stat;
    try {
      canonical = fs.realpathSync.native(candidate);
      stat = fs.lstatSync(candidate);
    } catch {
      addFinding(findings, "AGY_R16_MUTATION_RESULT_MISSING");
      continue;
    }
    if (
      !pathStaysWithin(workspace, canonical) || canonical !== candidate ||
      !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    ) {
      addFinding(findings, "AGY_R16_MUTATION_RESULT_UNSAFE");
      continue;
    }
    const content = fs.readFileSync(candidate);
    bindings.push({
      bytes: content.length,
      contentSha256: sha256(content),
      runId,
      target,
      targetSha256: sha256(target),
    });
  }
  return { ready: findings.length === 0, bindings, findings };
}

export function isAgyR16OwnedResourceName(value) {
  return CLIENT_PATTERN.test(value || "") || PROXY_PATTERN.test(value || "") ||
    HOME_HELPER_PATTERN.test(value || "") || isAgyR16HomeVolumeName(value);
}
