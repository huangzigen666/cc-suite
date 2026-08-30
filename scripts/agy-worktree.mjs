#!/usr/bin/env node

import process from "node:process";

import { createDetachedProbeWorktree } from "./lib/agy-seatbelt.mjs";

function parseArgs(argv) {
  const args = { sourcePath: process.cwd(), revision: "HEAD" };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source" && argv[index + 1]) args.sourcePath = argv[++index];
    else if (arg === "--revision" && argv[index + 1]) args.revision = argv[++index];
    else {
      const error = new Error(`Unknown or incomplete argument: ${arg}`);
      error.code = "AGY_WORKTREE_ARGUMENT_INVALID";
      throw error;
    }
  }
  return args;
}

try {
  const result = createDetachedProbeWorktree(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ status: "ready", ...result })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      status: "blocked",
      errorCode: error.code || "AGY_WORKTREE_PREPARE_FAILED",
      error: error.message,
    })}\n`
  );
  process.exitCode = 1;
}
