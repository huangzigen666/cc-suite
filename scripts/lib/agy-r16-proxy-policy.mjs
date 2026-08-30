import { createHash } from "node:crypto";
import net from "node:net";

import { auditAgyProxyPolicy } from "./agy-proxy-policy.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function privateIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function validGatewayUrl(value, expectedGatewayIPv4) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" &&
      parsed.username === "" && parsed.password === "" &&
      privateIPv4(expectedGatewayIPv4) &&
      parsed.hostname === expectedGatewayIPv4 &&
      parsed.port !== "" && Number(parsed.port) >= 1024 &&
      Number(parsed.port) <= 65535 &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

export function auditAgyR16ProxyPolicy(policy, expected = {}) {
  const expectedUpstreamUrl = expected.expectedUpstreamUrl;
  const exactUpstream = policy?.upstream !== null &&
    typeof policy?.upstream === "object" &&
    !Array.isArray(policy.upstream) &&
    Object.keys(policy.upstream).length === 1 &&
    policy.upstream.url === expectedUpstreamUrl &&
    validGatewayUrl(expectedUpstreamUrl, expected.expectedGatewayIPv4);
  const basePolicy = policy !== null && typeof policy === "object" &&
    !Array.isArray(policy)
    ? { ...policy, upstream: null }
    : policy;
  const base = auditAgyProxyPolicy(basePolicy, {
    expectedClientIPv4: expected.expectedClientIPv4,
    expectedListenHost: expected.expectedListenHost,
  });
  const findings = [...base.findings];
  if (!exactUpstream && !findings.includes("AGY_PROXY_UPSTREAM_INVALID")) {
    findings.push("AGY_PROXY_UPSTREAM_INVALID");
  }
  if (findings.length > 0) {
    return { ready: false, findings, policy: null, policyHash: null };
  }
  const acceptedPolicy = { ...base.policy, upstream: { url: expectedUpstreamUrl } };
  return {
    ready: true,
    findings: [],
    policy: acceptedPolicy,
    policyHash: `sha256:${createHash("sha256")
      .update(canonicalJson(acceptedPolicy))
      .digest("hex")}`,
  };
}
