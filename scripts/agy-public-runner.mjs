#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { inspectAgyR16ReleaseEnvironment } from "./agy-r16-preflight.mjs";

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ status: "failed", errorCode: code, error: message })}\n`);
  process.exitCode = 1;
}

function parse(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) return null;
  const options = { effort: null, model: null, project: null, timeoutMs: 900_000 };
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--project", "--model", "--effort", "--timeout-ms"].includes(flag)) {
      return null;
    }
    if (flag === "--project") options.project = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--effort") options.effort = value;
    else options.timeoutMs = Number(value);
  }
  const prompt = argv.slice(separator + 1).join(" ");
  if (
    options.project !== "default-cli-project" ||
    !/^[a-zA-Z0-9._-]+$/.test(options.model || "") ||
    (options.effort !== null && !["low", "medium", "high"].includes(options.effort)) ||
    !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 ||
    options.timeoutMs > 15 * 60 * 1000 || !prompt
  ) return null;
  return { ...options, prompt };
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args) {
    fail(
      "AGY_PUBLIC_ARGUMENTS_INVALID",
      "requires project default-cli-project, one model, bounded timeout, and one prompt"
    );
    return;
  }
  const preflight = inspectAgyR16ReleaseEnvironment();
  if (!preflight.promotion_ready || !preflight.oauth_volume) {
    fail("AGY_WORKSPACE_WRITE_PREFLIGHT_FAILED", preflight.reason);
    return;
  }
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "agy-runner.mjs");
  const childArgs = [
    runner,
    "--kind", "agy",
    "--project", args.project,
    "--model", args.model,
    "--sandbox", "workspace-write",
    "--external-workspace-write",
    "--oauth-volume", preflight.oauth_volume,
    "--timeout-ms", String(args.timeoutMs),
  ];
  if (args.effort) childArgs.push("--effort", args.effort);
  childArgs.push("--", args.prompt);
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    fail("AGY_PUBLIC_RUNNER_SPAWN_FAILED", error.message);
  });
  child.once("close", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}

main();

