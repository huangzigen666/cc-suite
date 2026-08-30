#!/usr/bin/env node

import http from "node:http";

import { createAgyConnectHandler } from "./lib/agy-egress-proxy.mjs";
import { auditAgyR15ProxyPolicy } from "./lib/agy-r15-proxy-policy.mjs";

function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== "--policy-env" ||
    argv[1] !== "AGY_PROXY_POLICY" ||
    argv[2] !== "--expected-listen-host" ||
    argv[4] !== "--expected-client-ipv4"
  ) {
    throw proxyError("AGY_PROXY_USAGE", "R15 proxy arguments are invalid");
  }
  return {
    expectedListenHost: argv[3],
    expectedClientIPv4: argv[5],
  };
}

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const rawPolicy = process.env.AGY_PROXY_POLICY;
  if (typeof rawPolicy !== "string" || rawPolicy.length < 2 || rawPolicy.length > 64 * 1024) {
    throw proxyError("AGY_PROXY_POLICY_ENV_INVALID", "R15 proxy policy is invalid");
  }
  let parsedPolicy;
  try {
    parsedPolicy = JSON.parse(rawPolicy);
  } catch {
    throw proxyError("AGY_PROXY_POLICY_JSON_INVALID", "R15 proxy policy JSON is invalid");
  }
  const auditedPolicy = auditAgyR15ProxyPolicy(parsedPolicy, {
    expectedListenHost: arguments_.expectedListenHost,
    expectedClientIPv4: arguments_.expectedClientIPv4,
    expectedUpstreamUrl: parsedPolicy?.upstream?.url,
  });
  if (!auditedPolicy.ready) {
    throw proxyError("AGY_PROXY_POLICY_INVALID", "R15 proxy policy audit failed");
  }

  const handler = createAgyConnectHandler({ auditedPolicy, logger: writeEvent });
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Connection: "close", "Content-Length": "0" });
    response.end();
  });
  server.maxHeadersCount = 32;
  server.on("connect", handler.handleConnect);
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      auditedPolicy.policy.listen.port,
      auditedPolicy.policy.listen.host,
      resolve
    );
  });
  writeEvent({
    event: "agy_proxy_ready",
    schemaVersion: 1,
    policyHash: auditedPolicy.policyHash,
    listenHost: auditedPolicy.policy.listen.host,
    listenPort: auditedPolicy.policy.listen.port,
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    handler.destroyAll();
    server.close(() => {
      writeEvent({ event: "agy_proxy_stopped", schemaVersion: 1 });
      process.exitCode = 0;
    });
    const timer = setTimeout(() => {
      writeEvent({ event: "agy_proxy_forced_stop", schemaVersion: 1 });
      process.exit(70);
    }, 5000);
    timer.unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    event: "agy_proxy_start_failed",
    schemaVersion: 1,
    reason: error?.code || "AGY_PROXY_UNKNOWN_FAILURE",
  })}\n`);
  process.exitCode = error?.code === "AGY_PROXY_USAGE" ? 64 : 70;
});
