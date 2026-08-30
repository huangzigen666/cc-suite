#!/usr/bin/env node

import http from "node:http";

import {
  createAgyConnectHandler,
  loadAgyProxyPolicyFile,
} from "./lib/agy-egress-proxy.mjs";
import { auditAgyProxyPolicy } from "./lib/agy-proxy-policy.mjs";

function parseArguments(argv) {
  if (
    argv.length !== 6 ||
    !["--policy", "--policy-env"].includes(argv[0]) ||
    argv[2] !== "--expected-listen-host" ||
    argv[4] !== "--expected-client-ipv4"
  ) {
    const error = new Error(
      "usage: agy-egress-proxy.mjs (--policy <absolute-path> | " +
      "--policy-env AGY_PROXY_POLICY) --expected-listen-host <IPv4> " +
      "--expected-client-ipv4 <IPv4>"
    );
    error.code = "AGY_PROXY_USAGE";
    throw error;
  }
  return {
    policySource: argv[0],
    policyValue: argv[1],
    expectedListenHost: argv[3],
    expectedClientIPv4: argv[5],
  };
}

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const expectedScope = {
    expectedListenHost: arguments_.expectedListenHost,
    expectedClientIPv4: arguments_.expectedClientIPv4,
  };
  let auditedPolicy;
  if (arguments_.policySource === "--policy") {
    auditedPolicy = await loadAgyProxyPolicyFile(arguments_.policyValue, expectedScope);
  } else {
    if (arguments_.policyValue !== "AGY_PROXY_POLICY") {
      const error = new Error("policy environment name is invalid");
      error.code = "AGY_PROXY_POLICY_ENV_NAME_INVALID";
      throw error;
    }
    const rawPolicy = process.env.AGY_PROXY_POLICY;
    if (typeof rawPolicy !== "string" || rawPolicy.length < 2 || rawPolicy.length > 64 * 1024) {
      const error = new Error("policy environment value is invalid");
      error.code = "AGY_PROXY_POLICY_ENV_INVALID";
      throw error;
    }
    let parsedPolicy;
    try {
      parsedPolicy = JSON.parse(rawPolicy);
    } catch {
      const error = new Error("policy environment JSON is invalid");
      error.code = "AGY_PROXY_POLICY_JSON_INVALID";
      throw error;
    }
    auditedPolicy = auditAgyProxyPolicy(parsedPolicy, expectedScope);
    if (!auditedPolicy.ready) {
      const error = new Error("policy audit failed");
      error.code = "AGY_PROXY_POLICY_INVALID";
      throw error;
    }
  }
  const handler = createAgyConnectHandler({ auditedPolicy, logger: writeEvent });
  const server = http.createServer((_request, response) => {
    response.writeHead(405, {
      Connection: "close",
      "Content-Length": "0",
    });
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
    server.close(() => {
      handler.destroyAll();
      writeEvent({ event: "agy_proxy_stopped", schemaVersion: 1 });
      process.exitCode = 0;
    });
    handler.destroyAll();
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
