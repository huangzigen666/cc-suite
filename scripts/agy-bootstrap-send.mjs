#!/usr/bin/env node

import { sendAgyBootstrap } from "./lib/agy-bootstrap.mjs";

function parseArguments(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== "--nonce" ||
    argv[2] !== "--ipv4" ||
    argv[4] !== "--port"
  ) {
    const error = new Error(
      "usage: agy-bootstrap-send.mjs --nonce <32-hex> --ipv4 <private-ipv4> " +
      "--port <loopback-published-port>"
    );
    error.code = "AGY_BOOTSTRAP_USAGE";
    throw error;
  }
  return { nonce: argv[1], ipv4: argv[3], port: Number(argv[5]) };
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  await sendAgyBootstrap(arguments_);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_bootstrap_delivered",
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_bootstrap_failed",
    reason: error?.code || "AGY_BOOTSTRAP_UNKNOWN_FAILURE",
  })}\n`);
  process.exitCode = error?.code === "AGY_BOOTSTRAP_USAGE" ? 64 : 70;
}
