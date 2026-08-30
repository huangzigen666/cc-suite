#!/usr/bin/env node

import { constants as fsConstants, openSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";

import { auditAgyProxyPolicy } from "./lib/agy-proxy-policy.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArguments(argv) {
  const values = new Map();
  const allowedHosts = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail("AGY_PROXY_POLICY_USAGE", "missing argument value");
    if (flag === "--allow-host") {
      allowedHosts.push(value);
    } else if (
      ["--output", "--listen-host", "--listen-port", "--client-ipv4"].includes(flag)
    ) {
      if (values.has(flag)) fail("AGY_PROXY_POLICY_USAGE", "duplicate argument");
      values.set(flag, value);
    } else {
      fail("AGY_PROXY_POLICY_USAGE", "unknown argument");
    }
  }
  if (allowedHosts.length === 0) {
    fail("AGY_PROXY_POLICY_USAGE", "at least one host is required");
  }
  const output = values.get("--output");
  if (!path.isAbsolute(output || "")) {
    fail("AGY_PROXY_POLICY_OUTPUT_INVALID", "output must be absolute");
  }
  return {
    output,
    listenHost: values.get("--listen-host"),
    listenPort: Number(values.get("--listen-port")),
    clientIPv4: values.get("--client-ipv4"),
    allowedHosts: [...allowedHosts].sort(),
  };
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const policy = {
    schemaVersion: 1,
    listen: { host: arguments_.listenHost, port: arguments_.listenPort },
    allowedClientIPv4: arguments_.clientIPv4,
    allowedHosts: arguments_.allowedHosts,
    upstream: null,
    limits: {
      connectTimeoutMs: 8000,
      dnsTimeoutMs: 5000,
      idleTimeoutMs: 90000,
      maxTunnelMs: 300000,
      maxConcurrentTunnels: 16,
    },
  };
  const audit = auditAgyProxyPolicy(policy, {
    expectedListenHost: arguments_.listenHost,
    expectedClientIPv4: arguments_.clientIPv4,
  });
  if (!audit.ready) fail("AGY_PROXY_POLICY_INVALID", "generated policy is invalid");

  let descriptor;
  try {
    descriptor = openSync(
      arguments_.output,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    );
    writeFileSync(descriptor, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_proxy_policy_ready",
    policyHash: audit.policyHash,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_proxy_policy_failed",
    reason: error?.code || "AGY_PROXY_POLICY_UNKNOWN_FAILURE",
  })}\n`);
  process.exitCode = error?.code === "AGY_PROXY_POLICY_USAGE" ? 64 : 70;
}
