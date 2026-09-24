import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/mimo-runner.mjs", import.meta.url));

// A fake `mimo run --format json`. It records argv and MIMOCODE_PERMISSION to
// $FAKE_RECORD_FILE and emits the JSONL event shapes captured from mimo 0.1.7.
// Newlines use String.fromCharCode(10) so the template needs no escapes.
//
//   FAKE_MODE   ok | two-steps | error-event | silent | nonzero   (default ok)
const FAKE_MIMO = `#!/usr/bin/env node
const fs = require("fs");
const NL = String.fromCharCode(10);
fs.writeFileSync(process.env.FAKE_RECORD_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  permission: process.env.MIMOCODE_PERMISSION ?? null,
}));
const SID = "ses_fake";
const out = (o) => process.stdout.write(JSON.stringify({ timestamp: 1, sessionID: SID, ...o }) + NL);
const mode = process.env.FAKE_MODE || "ok";
if (mode === "error-event") {
  out({ type: "error", error: { name: "APIError", data: { message: "Unsupported model mimo-auto", statusCode: 400 } } });
  process.exit(0);
}
if (mode === "nonzero") { process.stderr.write("boom" + NL); process.exit(3); }
out({ type: "step_start", part: { type: "step-start" } });
if (mode !== "silent") out({ type: "text", part: { type: "text", text: "FIRST" } });
out({ type: "step_finish", part: { type: "step-finish" } });
if (mode === "two-steps") out({ type: "text", part: { type: "text", text: "SECOND" } });
process.exit(0);
`;

function runMimo({ env = {}, flags = [] } = {}) {
  const workspace = makeTempDir("mimo-runner-");
  const pluginData = makeTempDir("mimo-state-");
  const bin = path.join(workspace, "mimo");
  writeExecutable(bin, FAKE_MIMO);
  const recordFile = path.join(workspace, "record.json");

  const result = spawnSync(
    process.execPath,
    [RUNNER, "--kind", "mimo", "--timeout-ms", "60000", ...flags, "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        MIMO_BIN: bin,
        MIMO_MODEL: "",
        FAKE_RECORD_FILE: recordFile,
        CLAUDE_PLUGIN_DATA: pluginData,
        CODEX_TOOLKIT_SESSION_ID: "",
        ...env,
      },
    }
  );
  const line = (result.stdout || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop();
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* assertion reports raw output */ }
  let record = null;
  try { record = JSON.parse(fs.readFileSync(recordFile, "utf8")); } catch { /* not spawned */ }
  cleanupDir(workspace);
  cleanupDir(pluginData);
  return { result, parsed, record };
}

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("mimo: text events are the answer and sessionID is the threadId", () => {
  const { result, parsed } = runMimo();
  assert.ok(parsed, `expected JSON, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "FIRST");
  assert.equal(parsed.threadId, "ses_fake");
});

test("mimo: text from several steps is joined", () => {
  const { parsed } = runMimo({ env: { FAKE_MODE: "two-steps" } });
  assert.equal(parsed.rawOutput, "FIRST\n\nSECOND");
});

test("mimo: an error event fails the job even though mimo exits 0", () => {
  const { parsed } = runMimo({ env: { FAKE_MODE: "error-event" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.equal(parsed.error, "mimo: Unsupported model mimo-auto");
});

test("mimo: a clean exit with no text is a failure", () => {
  const { parsed } = runMimo({ env: { FAKE_MODE: "silent" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
});

test("mimo: a nonzero exit is a failure", () => {
  const { parsed } = runMimo({ env: { FAKE_MODE: "nonzero" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /boom/);
});

test("mimo: defaults to deepseek-flash, honors MIMO_MODEL, and --model wins", () => {
  assert.equal(flagValue(runMimo().record.argv, "-m"), "deepseek/deepseek-flash");
  assert.equal(flagValue(runMimo({ env: { MIMO_MODEL: "xiaomi/mimo-v2.6-flash" } }).record.argv, "-m"), "xiaomi/mimo-v2.6-flash");
  const { record } = runMimo({ env: { MIMO_MODEL: "xiaomi/x" }, flags: ["--model", "deepseek/deepseek-v4-pro", "--effort", "high"] });
  assert.equal(flagValue(record.argv, "-m"), "deepseek/deepseek-v4-pro");
  assert.equal(flagValue(record.argv, "--variant"), "high");
});

test("mimo: read-only denies by default and a caller's MIMOCODE_PERMISSION cannot widen it", () => {
  const { record } = runMimo({ env: { MIMOCODE_PERMISSION: '{"*":"allow"}' } });
  const perm = JSON.parse(record.permission);
  assert.equal(perm["*"], "deny");
  assert.equal(perm.read, "allow");
  assert.equal(perm.edit, undefined);
  assert.equal(perm.bash, undefined);
  assert.ok(!record.argv.includes("--dangerously-skip-permissions"));
  // Unknown sandbox levels fall to read-only.
  assert.equal(JSON.parse(runMimo({ flags: ["--sandbox", "bogus"] }).record.permission)["*"], "deny");
});

test("mimo: workspace-write denies external directories; danger-full-access skips permissions", () => {
  const ww = runMimo({ flags: ["--sandbox", "workspace-write"] }).record;
  assert.deepEqual(JSON.parse(ww.permission), { external_directory: "deny" });
  const full = runMimo({ env: { MIMOCODE_PERMISSION: '{"bash":"deny"}' }, flags: ["--sandbox", "danger-full-access"] }).record;
  assert.equal(full.permission, null);
  assert.ok(full.argv.includes("--dangerously-skip-permissions"));
});

test("mimo: prompt carries the delegation boundary after --, and --resume maps to --session", () => {
  const { record } = runMimo({ flags: ["--resume", "ses_prev"] });
  const { argv } = record;
  assert.equal(flagValue(argv, "--session"), "ses_prev");
  assert.equal(argv[argv.length - 2], "--");
  assert.match(argv[argv.length - 1], /delegation from Claude Code[\s\S]*hello$/);
  assert.deepEqual(argv.slice(0, 3), ["run", "--format", "json"]);
});
