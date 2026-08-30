import { createHash } from "node:crypto";
import net from "node:net";

export const AGY_PROXY_POLICY_SCHEMA_VERSION = 1;
export const AGY_PROXY_FIXED_LIMITS = Object.freeze({
  connectTimeoutMs: 8000,
  dnsTimeoutMs: 5000,
  idleTimeoutMs: 90000,
  maxTunnelMs: 300000,
  maxConcurrentTunnels: 16,
});

const POLICY_KEYS = Object.freeze([
  "allowedClientIPv4",
  "allowedHosts",
  "limits",
  "listen",
  "schemaVersion",
  "upstream",
]);
const LISTEN_KEYS = Object.freeze(["host", "port"]);
const LIMIT_KEYS = Object.freeze(Object.keys(AGY_PROXY_FIXED_LIMITS).sort());

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
}

function ipv4Octets(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split(".").map(Number);
}

function isPrivateIPv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

export function isPublicIPv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isCanonicalAgyProxyHostname(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 253) {
    return false;
  }
  if (value !== value.toLowerCase() || !value.includes(".")) return false;
  if (net.isIP(value) !== 0 || value.includes("*") || value.endsWith(".")) {
    return false;
  }
  if (value.endsWith(".local") || value.endsWith(".internal")) return false;
  const labels = value.split(".");
  if (!/^[a-z]{2,63}$/.test(labels.at(-1))) return false;
  return labels.every(
    (label) => label.length >= 1 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

function validUpstream(upstream) {
  if (upstream === null) return true;
  if (!hasExactKeys(upstream, ["url"])) return false;
  try {
    const parsed = new URL(upstream.url);
    return parsed.protocol === "http:" &&
      parsed.username === "" && parsed.password === "" &&
      net.isIP(parsed.hostname) === 4 && parsed.hostname.startsWith("127.") &&
      parsed.port !== "" && Number(parsed.port) >= 1 && Number(parsed.port) <= 65535 &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

export function auditAgyProxyPolicy(policy, expected = {}) {
  const findings = [];
  const expectedScopeValid =
    expected.expectedListenHost === "0.0.0.0" &&
    typeof expected.expectedClientIPv4 === "string" &&
    isPrivateIPv4(expected.expectedClientIPv4);
  if (!expectedScopeValid) {
    addFinding(findings, "AGY_PROXY_EXPECTED_SCOPE_INVALID");
  }

  if (!hasExactKeys(policy, POLICY_KEYS)) {
    addFinding(findings, "AGY_PROXY_POLICY_SCHEMA_INVALID");
  }
  if (policy?.schemaVersion !== AGY_PROXY_POLICY_SCHEMA_VERSION) {
    addFinding(findings, "AGY_PROXY_POLICY_VERSION_MISMATCH");
  }
  if (!hasExactKeys(policy?.listen, LISTEN_KEYS)) {
    addFinding(findings, "AGY_PROXY_LISTEN_INVALID");
  }
  if (policy?.listen?.host !== expected.expectedListenHost) {
    addFinding(findings, "AGY_PROXY_LISTEN_HOST_MISMATCH");
  }
  if (
    !Number.isInteger(policy?.listen?.port) ||
    policy.listen.port < 1024 || policy.listen.port > 65535
  ) {
    addFinding(findings, "AGY_PROXY_LISTEN_PORT_INVALID");
  }
  if (
    policy?.allowedClientIPv4 !== expected.expectedClientIPv4 ||
    !isPrivateIPv4(policy?.allowedClientIPv4)
  ) {
    addFinding(findings, "AGY_PROXY_CLIENT_IPV4_MISMATCH");
  }

  if (
    !Array.isArray(policy?.allowedHosts) ||
    policy.allowedHosts.length === 0 || policy.allowedHosts.length > 32
  ) {
    addFinding(findings, "AGY_PROXY_ALLOWED_HOSTS_INVALID");
  } else {
    const seen = new Set();
    for (const host of policy.allowedHosts) {
      if (!isCanonicalAgyProxyHostname(host)) {
        addFinding(findings, "AGY_PROXY_ALLOWED_HOST_INVALID");
      }
      if (seen.has(host)) addFinding(findings, "AGY_PROXY_ALLOWED_HOST_DUPLICATE");
      seen.add(host);
    }
    const sorted = [...policy.allowedHosts].sort();
    if (!policy.allowedHosts.every((host, index) => host === sorted[index])) {
      addFinding(findings, "AGY_PROXY_ALLOWED_HOSTS_NOT_CANONICAL");
    }
  }

  if (!validUpstream(policy?.upstream)) {
    addFinding(findings, "AGY_PROXY_UPSTREAM_INVALID");
  }
  if (!hasExactKeys(policy?.limits, LIMIT_KEYS)) {
    addFinding(findings, "AGY_PROXY_LIMITS_INVALID");
  } else {
    for (const [key, value] of Object.entries(AGY_PROXY_FIXED_LIMITS)) {
      if (policy.limits[key] !== value) {
        addFinding(findings, "AGY_PROXY_LIMITS_INVALID");
      }
    }
  }

  const ready = findings.length === 0;
  return {
    ready,
    findings,
    policy: ready ? policy : null,
    policyHash: ready
      ? `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`
      : null,
  };
}

function denied() {
  const error = new Error("AGY proxy destination denied");
  error.code = "AGY_PROXY_DESTINATION_DENIED";
  return error;
}

export function parseAgyConnectAuthority(authority, hostHeader, allowedHosts) {
  if (
    typeof authority !== "string" ||
    typeof hostHeader !== "string" ||
    authority !== hostHeader ||
    authority.includes("@") ||
    !(allowedHosts instanceof Set)
  ) {
    throw denied();
  }
  const match = /^([^:]+):(\d+)$/.exec(authority);
  if (!match) throw denied();
  const host = match[1];
  const port = Number(match[2]);
  if (
    port !== 443 ||
    !isCanonicalAgyProxyHostname(host) ||
    !allowedHosts.has(host)
  ) {
    throw denied();
  }
  return { host, port };
}
