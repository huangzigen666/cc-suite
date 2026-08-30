import { createHash } from "node:crypto";
import net from "node:net";

import {
  AGY_PROXY_FIXED_LIMITS,
  AGY_PROXY_POLICY_SCHEMA_VERSION,
} from "./agy-proxy-policy.mjs";
import { AGY_HOST_PROXY_NETWORK } from "./agy-host-proxy-bridge.mjs";
import { auditAgyR15ProxyPolicy } from "./agy-r15-proxy-policy.mjs";

export const AGY_R15_CAPSULE_IMAGE = "cc-suite/agy-r14-capsule:1.1.11";
export const AGY_R15_PROXY_IMAGE = "cc-suite/agy-r15-egress:probe";
export const AGY_R15_BOOTSTRAP_CONTAINER_PORT = 18083;

export const AGY_R15_AUTH_HOSTS = Object.freeze([
  "antigravity-unleash.goog",
  "businessaicode.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "lh3.googleusercontent.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
]);

export const AGY_R15_OAUTH_SCOPES = Object.freeze([
  "aicode",
  "cclog",
  "experimentsandconfigs",
  "https://www.googleapis.com/auth/cloud-platform",
  "openid",
  "userinfo.email",
  "userinfo.profile",
]);

export const AGY_R15_AUTH_PROFILE_HASH = `sha256:${createHash("sha256")
  .update(JSON.stringify({
    allowedHosts: AGY_R15_AUTH_HOSTS,
    capsuleImage: AGY_R15_CAPSULE_IMAGE,
    oauthScopes: AGY_R15_OAUTH_SCOPES,
    proxyImage: AGY_R15_PROXY_IMAGE,
    schemaVersion: 1,
  }))
  .digest("hex")}`;

const CLIENT_NAME_PATTERN = /^cc-suite-agy-r15-auth-[a-f0-9]{12}$/;
const PROXY_NAME_PATTERN = /^cc-suite-agy-r15-proxy-[a-f0-9]{12}$/;
const OAUTH_VOLUME_NAME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;

function authError(code, message, findings) {
  const error = new Error(message);
  error.code = code;
  if (findings) error.findings = findings;
  return error;
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

function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function buildAgyR15AuthPolicy({
  clientIPv4,
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
  const audit = auditAgyR15ProxyPolicy(policy, {
    expectedClientIPv4: clientIPv4,
    expectedListenHost: "0.0.0.0",
    expectedUpstreamUrl: upstreamProxyUrl,
  });
  if (!audit.ready) {
    throw authError(
      "AGY_R15_AUTH_POLICY_INVALID",
      "R15 auth egress policy is invalid",
      audit.findings
    );
  }
  return audit;
}

export function buildAgyR15ClientCreateArgs(options = {}) {
  const {
    bootstrapHostPort,
    bootstrapNonce,
    clientName,
    networkName,
    networkPrefix,
    oauthVolumeName,
    profileHash,
    proxyPort,
    runId,
  } = options;
  if (
    !validPort(bootstrapHostPort) ||
    !NONCE_PATTERN.test(bootstrapNonce || "") ||
    !CLIENT_NAME_PATTERN.test(clientName || "") ||
    networkName !== AGY_HOST_PROXY_NETWORK ||
    !validPrivatePrefix(networkPrefix) ||
    !OAUTH_VOLUME_NAME_PATTERN.test(oauthVolumeName || "") ||
    profileHash !== AGY_R15_AUTH_PROFILE_HASH ||
    !validPort(proxyPort) ||
    !NONCE_PATTERN.test(runId || "")
  ) {
    throw authError("AGY_R15_AUTH_SCOPE_INVALID", "R15 auth client scope is invalid");
  }

  return [
    "create",
    "--interactive",
    "--tty",
    "--name",
    clientName,
    "--label",
    "cc-suite.owner=cc-suite",
    "--label",
    "cc-suite.purpose=agy-r15-interactive-auth",
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
    "/usr/local/bin/agy",
  ];
}

export function buildAgyR15ProxyRunArgs(options = {}) {
  const { networkName, policy, proxyName } = options;
  if (
    networkName !== AGY_HOST_PROXY_NETWORK ||
    !PROXY_NAME_PATTERN.test(proxyName || "") ||
    policy === null || typeof policy !== "object" || Array.isArray(policy)
  ) {
    throw authError("AGY_R15_AUTH_SCOPE_INVALID", "R15 auth proxy scope is invalid");
  }
  const audit = auditAgyR15ProxyPolicy(policy, {
    expectedClientIPv4: policy.allowedClientIPv4,
    expectedListenHost: "0.0.0.0",
    expectedUpstreamUrl: policy.upstream?.url,
  });
  if (!audit.ready || JSON.stringify(audit.policy.allowedHosts) !== JSON.stringify(AGY_R15_AUTH_HOSTS)) {
    throw authError(
      "AGY_R15_AUTH_POLICY_INVALID",
      "R15 auth proxy policy is invalid",
      audit.findings
    );
  }

  return [
    "run",
    "--detach",
    "--name",
    proxyName,
    "--label",
    "cc-suite.owner=cc-suite",
    "--label",
    "cc-suite.purpose=agy-r15-auth-egress",
    "--network",
    networkName,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--env",
    `AGY_PROXY_POLICY=${JSON.stringify(audit.policy)}`,
    AGY_R15_PROXY_IMAGE,
    "--policy-env",
    "AGY_PROXY_POLICY",
    "--expected-listen-host",
    "0.0.0.0",
    "--expected-client-ipv4",
    audit.policy.allowedClientIPv4,
  ];
}
