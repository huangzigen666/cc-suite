#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";

import {
  createAgyOAuthVolumeName,
  prepareAgyOAuthVolume,
} from "./lib/agy-oauth-volume.mjs";

function runContainer(args) {
  const result = spawnSync("container", args, {
    encoding: "utf8",
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
  };
}

function main() {
  if (process.argv.length !== 2) {
    const error = new Error("usage: agy-oauth-volume.mjs");
    error.code = "AGY_OAUTH_VOLUME_USAGE";
    throw error;
  }
  const result = prepareAgyOAuthVolume({
    expectedName: createAgyOAuthVolumeName(),
    homeDirectory: os.homedir(),
    now: new Date(),
    runContainer,
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_oauth_volume_ready",
    ...result,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    event: "agy_oauth_volume_failed",
    reason: error?.code || "AGY_OAUTH_VOLUME_UNKNOWN_FAILURE",
    cleanupSucceeded: error?.cleanupSucceeded ?? null,
  })}\n`);
  process.exitCode = error?.code === "AGY_OAUTH_VOLUME_USAGE" ? 64 : 70;
}
