import assert from "node:assert/strict";
import test from "node:test";

import {
  auditAgyProxyPolicy,
  isPublicIPv4,
  parseAgyConnectAuthority,
} from "../scripts/lib/agy-proxy-policy.mjs";
import { auditAgyR15ProxyPolicy } from "../scripts/lib/agy-r15-proxy-policy.mjs";

function validPolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    listen: { host: "0.0.0.0", port: 18081 },
    allowedClientIPv4: "172.30.250.3",
    allowedHosts: ["accounts.google.com", "oauth2.googleapis.com"],
    upstream: { url: "http://127.0.0.1:7890" },
    limits: {
      connectTimeoutMs: 8000,
      dnsTimeoutMs: 5000,
      idleTimeoutMs: 90000,
      maxTunnelMs: 300000,
      maxConcurrentTunnels: 16,
    },
    ...overrides,
  };
}

const EXPECTED = {
  expectedListenHost: "0.0.0.0",
  expectedClientIPv4: "172.30.250.3",
};

test("R14 accepts one canonical exact-host proxy policy", () => {
  const result = auditAgyProxyPolicy(validPolicy(), EXPECTED);

  assert.equal(result.ready, true);
  assert.deepEqual(result.findings, []);
  assert.match(result.policyHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.policy.allowedHosts, [
    "accounts.google.com",
    "oauth2.googleapis.com",
  ]);
});

test("R14 hashes canonical policy content rather than object insertion order", () => {
  const canonical = auditAgyProxyPolicy(validPolicy(), EXPECTED);
  const reorderedPolicy = {
    upstream: { url: "http://127.0.0.1:7890" },
    allowedHosts: ["accounts.google.com", "oauth2.googleapis.com"],
    allowedClientIPv4: "172.30.250.3",
    schemaVersion: 1,
    limits: {
      maxTunnelMs: 300000,
      maxConcurrentTunnels: 16,
      idleTimeoutMs: 90000,
      dnsTimeoutMs: 5000,
      connectTimeoutMs: 8000,
    },
    listen: { port: 18081, host: "0.0.0.0" },
  };
  const reordered = auditAgyProxyPolicy(reorderedPolicy, EXPECTED);

  assert.equal(reordered.ready, true);
  assert.equal(reordered.policyHash, canonical.policyHash);
});

test("R14 binds inside the sidecar and permits only the exact AGY client IPv4", () => {
  for (const host of ["127.0.0.1", "192.168.1.50", "8.8.8.8"]) {
    const result = auditAgyProxyPolicy(
      validPolicy({ listen: { host, port: 18081 } }),
      EXPECTED
    );
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes("AGY_PROXY_LISTEN_HOST_MISMATCH"));
  }

  for (const client of ["172.30.250.4", "127.0.0.1", "8.8.8.8"]) {
    const result = auditAgyProxyPolicy(
      validPolicy({ allowedClientIPv4: client }),
      EXPECTED
    );
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes("AGY_PROXY_CLIENT_IPV4_MISMATCH"));
  }

  const missingExpected = auditAgyProxyPolicy(validPolicy(), {});
  assert.equal(missingExpected.ready, false);
  assert.ok(missingExpected.findings.includes("AGY_PROXY_EXPECTED_SCOPE_INVALID"));
});

test("R14 rejects wildcard, IP, Unicode, non-canonical, and malformed hostnames", () => {
  for (const host of [
    "*.google.com",
    "8.8.8.8",
    "accounts.google.com.",
    "Accounts.Google.Com",
    "localhost",
    "metadata.google.internal",
    "bad_label.google.com",
    "-bad.google.com",
    "例子.测试",
  ]) {
    const result = auditAgyProxyPolicy(
      validPolicy({ allowedHosts: [host] }),
      EXPECTED
    );
    assert.equal(result.ready, false, host);
    assert.ok(result.findings.includes("AGY_PROXY_ALLOWED_HOST_INVALID"), host);
  }

  const duplicate = auditAgyProxyPolicy(
    validPolicy({ allowedHosts: ["accounts.google.com", "accounts.google.com"] }),
    EXPECTED
  );
  assert.equal(duplicate.ready, false);
  assert.ok(duplicate.findings.includes("AGY_PROXY_ALLOWED_HOST_DUPLICATE"));
});

test("R14 permits only a credential-free explicit loopback HTTP upstream", () => {
  assert.equal(
    auditAgyProxyPolicy(validPolicy({ upstream: null }), EXPECTED).ready,
    true
  );

  for (const url of [
    "https://127.0.0.1:7890",
    "http://localhost:7890",
    "http://0.0.0.0:7890",
    "http://user:pass@127.0.0.1:7890",
    "http://127.0.0.1:7890/path",
    "http://127.0.0.1",
  ]) {
    const result = auditAgyProxyPolicy(
      validPolicy({ upstream: { url } }),
      EXPECTED
    );
    assert.equal(result.ready, false, url);
    assert.ok(result.findings.includes("AGY_PROXY_UPSTREAM_INVALID"), url);
  }
});

test("R15 permits only the exact credential-free Apple localhost redirect upstream", () => {
  const redirectUrl = "http://203.0.113.113:49152";
  const accepted = auditAgyR15ProxyPolicy(
    validPolicy({ upstream: { url: redirectUrl } }),
    { ...EXPECTED, expectedUpstreamUrl: redirectUrl }
  );
  assert.equal(accepted.ready, true);

  for (const url of [
    "http://203.0.113.114:49152",
    "https://203.0.113.113:49152",
    "http://user:pass@203.0.113.113:49152",
    "http://203.0.113.113:7892",
  ]) {
    const result = auditAgyR15ProxyPolicy(
      validPolicy({ upstream: { url } }),
      { ...EXPECTED, expectedUpstreamUrl: redirectUrl }
    );
    assert.equal(result.ready, false, url);
    assert.ok(result.findings.includes("AGY_PROXY_UPSTREAM_INVALID"), url);
  }
});

test("R14 denies every non-public or non-IPv4 resolution target", () => {
  for (const ip of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.64.1",
    "192.0.2.1",
    "192.0.0.8",
    "192.0.0.170",
    "192.0.0.171",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  assert.equal(isPublicIPv4("142.250.72.238"), true);
});

test("R14 CONNECT parsing requires the allowed canonical hostname and port 443", () => {
  const allowed = new Set(validPolicy().allowedHosts);
  assert.deepEqual(
    parseAgyConnectAuthority(
      "accounts.google.com:443",
      "accounts.google.com:443",
      allowed
    ),
    { host: "accounts.google.com", port: 443 }
  );

  for (const [authority, hostHeader] of [
    ["accounts.google.com:80", "accounts.google.com:80"],
    ["8.8.8.8:443", "8.8.8.8:443"],
    ["Accounts.Google.Com:443", "Accounts.Google.Com:443"],
    ["www.google.com:443", "www.google.com:443"],
    ["accounts.google.com:443", "oauth2.googleapis.com:443"],
    ["user@accounts.google.com:443", "user@accounts.google.com:443"],
  ]) {
    assert.throws(
      () => parseAgyConnectAuthority(authority, hostHeader, allowed),
      (error) => error.code === "AGY_PROXY_DESTINATION_DENIED"
    );
  }
});
