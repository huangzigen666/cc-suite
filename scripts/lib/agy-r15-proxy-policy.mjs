import { createHash } from "node:crypto";

import { auditAgyProxyPolicy } from "./agy-proxy-policy.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validAppleRedirectUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" &&
      parsed.username === "" && parsed.password === "" &&
      parsed.hostname === "203.0.113.113" &&
      parsed.port !== "" && Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535 &&
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

export function auditAgyR15ProxyPolicy(policy, expected = {}) {
  const expectedUpstreamUrl = expected.expectedUpstreamUrl;
  const exactUpstream = policy?.upstream !== null &&
    typeof policy?.upstream === "object" &&
    !Array.isArray(policy.upstream) &&
    Object.keys(policy.upstream).length === 1 &&
    policy.upstream.url === expectedUpstreamUrl &&
    validAppleRedirectUrl(expectedUpstreamUrl);
  const basePolicy = policy !== null && typeof policy === "object" && !Array.isArray(policy)
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
