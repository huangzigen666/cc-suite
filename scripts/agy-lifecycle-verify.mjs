#!/usr/bin/env node

import fs from "node:fs";

import { auditAgySupervisorCompletion } from "./lib/agy-lifecycle.mjs";

const [outputPath, cliExitCodeRaw, expectedRunId, expectedProfileHash] =
  process.argv.slice(2);

if (!outputPath || cliExitCodeRaw === undefined || !expectedRunId || !expectedProfileHash) {
  process.stderr.write(
    "usage: agy-lifecycle-verify.mjs <stdout-path> <cli-exit-code> <32-hex-run-nonce> <profile-sha256>\n"
  );
  process.exit(64);
}

const cliExitCode = Number(cliExitCodeRaw);
if (!Number.isInteger(cliExitCode) || cliExitCode < 0 || cliExitCode > 255) {
  process.stderr.write("AGY_SUPERVISOR_CLI_EXIT_INVALID\n");
  process.exit(64);
}

const stat = fs.statSync(outputPath);
if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
  process.stderr.write("AGY_SUPERVISOR_OUTPUT_FILE_INVALID\n");
  process.exit(70);
}

const result = auditAgySupervisorCompletion(fs.readFileSync(outputPath, "utf8"), {
  cliExitCode,
  expectedRunId,
  expectedProfileHash,
  now: new Date(),
});

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.attributed ? result.workloadExitCode : 70;
