import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url));

// Fake `zcode` / `doubao` CLIs. Each records its argv to $FAKE_ARGV_FILE and
// prints the result shape the real CLI prints (captured from zcode 0.16.9 and
// doubao-cli 0.6.4). Newlines use String.fromCharCode(10) so the template needs
// no escape sequences.
//
//   FAKE_MODE       ok | nonzero-with-json | error | empty   (default ok)
const FAKE_ZCODE = `#!/usr/bin/env node
const fs = require("fs");
const NL = String.fromCharCode(10);
fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE || "ok";
const body = { sessionId: "sess_fake", turnId: "turn_1", response: "  ZCODE ANSWER  " };
if (mode === "error") { process.stderr.write("Error: Session not found: sess_x" + NL); process.exit(1); }
if (mode === "empty") process.exit(0);
process.stderr.write("ZCode Built-in skipped (not-due)" + NL);
process.stdout.write(JSON.stringify(body, null, 2) + NL);
process.exit(mode === "nonzero-with-json" ? 2 : 0);
`;

const FAKE_DOUBAO = `#!/usr/bin/env node
const fs = require("fs");
const NL = String.fromCharCode(10);
fs.writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_MODE || "ok";
if (mode === "error") { process.stderr.write("doubao: Doubao reply did not complete within 5000 ms" + NL); process.exit(1); }
const reply = mode === "empty" ? null : { role: "assistant", text: "DOUBAO ANSWER" };
process.stdout.write(JSON.stringify({ conversationId: "conv-9", created: true, sent: { role: "user", text: "x" }, reply }, null, 2) + NL);
process.exit(mode === "nonzero-with-json" ? 2 : 0);
`;

function runBackend(backend, { env = {}, flags = [] } = {}) {
  const workspace = makeTempDir(`${backend}-runner-`);
  const pluginData = makeTempDir(`${backend}-state-`);
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, backend);
  writeExecutable(bin, backend === "zcode" ? FAKE_ZCODE : FAKE_DOUBAO);
  const argvFile = path.join(workspace, "argv.json");

  const result = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, `${backend}-runner.mjs`), "--kind", backend, "--timeout-ms", "60000", ...flags, "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        PATH: binDir + path.delimiter + process.env.PATH,
        ZCODE_BIN: backend === "zcode" ? bin : "",
        DOUBAO_BIN: backend === "doubao" ? bin : "",
        FAKE_ARGV_FILE: argvFile,
        CLAUDE_PLUGIN_DATA: pluginData,
        CODEX_TOOLKIT_SESSION_ID: "",
        ...env,
      },
    }
  );
  const line = (result.stdout || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop();
  let parsed = null;
  try { parsed = JSON.parse(line); } catch { /* assertion reports raw output */ }
  let argv = null;
  try { argv = JSON.parse(fs.readFileSync(argvFile, "utf8")); } catch { /* not spawned */ }
  cleanupDir(workspace);
  cleanupDir(pluginData);
  return { result, parsed, argv };
}

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("zcode: clean exit with a JSON result is completed, with sessionId as threadId", () => {
  const { result, parsed } = runBackend("zcode");
  assert.ok(parsed, `expected JSON, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "ZCODE ANSWER");
  assert.equal(parsed.threadId, "sess_fake");
});

test("zcode: sandbox levels map to --mode, and read-only never falls to zcode's yolo default", () => {
  assert.equal(flagValue(runBackend("zcode").argv, "--mode"), "plan");
  assert.equal(flagValue(runBackend("zcode", { flags: ["--sandbox", "bogus"] }).argv, "--mode"), "plan");
  assert.equal(flagValue(runBackend("zcode", { flags: ["--sandbox", "workspace-write"] }).argv, "--mode"), "edit");
  assert.equal(flagValue(runBackend("zcode", { flags: ["--sandbox", "danger-full-access"] }).argv, "--mode"), "yolo");
});

test("zcode: the prompt carries the delegation boundary and --resume is forwarded", () => {
  const { argv } = runBackend("zcode", { flags: ["--resume", "sess_prev"] });
  assert.match(flagValue(argv, "-p"), /delegation from Claude Code[\s\S]*hello$/);
  assert.equal(flagValue(argv, "--resume"), "sess_prev");
  assert.ok(argv.includes("--json"));
});

test("zcode: a printed result with a nonzero exit is a failure", () => {
  const { parsed } = runBackend("zcode", { env: { FAKE_MODE: "nonzero-with-json" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /exit 2/);
});

test("zcode: an Error: line on stderr is surfaced on failure", () => {
  const { parsed } = runBackend("zcode", { env: { FAKE_MODE: "error" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.equal(parsed.error, "Error: Session not found: sess_x");
});

test("zcode: a clean exit with no JSON result is a failure, not an empty success", () => {
  const { parsed } = runBackend("zcode", { env: { FAKE_MODE: "empty" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
});

test("doubao: a reply is completed, with conversationId as threadId", () => {
  const { result, parsed, argv } = runBackend("doubao");
  assert.ok(parsed, `expected JSON, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "DOUBAO ANSWER");
  assert.equal(parsed.threadId, "conv-9");
  assert.deepEqual(argv.slice(0, 2), ["sessions", "create"]);
  assert.ok(argv.includes("--wait") && argv.includes("--json"));
  // Inner deadline sits inside the runner's so doubao reports before being killed.
  assert.equal(flagValue(argv, "--timeout"), "50");
  assert.match(argv[argv.length - 1], /delegation from Claude Code[\s\S]*hello$/);
  assert.equal(argv[argv.length - 2], "--");
});

test("doubao: --resume sends into the existing conversation; --model/--effort are forwarded", () => {
  const { argv } = runBackend("doubao", { flags: ["--resume", "conv-1", "--model", "pro", "--effort", "deep"] });
  assert.deepEqual(argv.slice(0, 3), ["sessions", "send", "conv-1"]);
  assert.equal(flagValue(argv, "--model"), "pro");
  assert.equal(flagValue(argv, "--reasoning"), "deep");
});

test("doubao: a missing reply is a failure", () => {
  const { parsed } = runBackend("doubao", { env: { FAKE_MODE: "empty" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /no reply/);
});

test("doubao: a doubao: error line is surfaced on failure", () => {
  const { parsed } = runBackend("doubao", { env: { FAKE_MODE: "error" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /^doubao: Doubao reply did not complete/);
});

test("doubao: a printed reply with a nonzero exit is a failure", () => {
  const { parsed } = runBackend("doubao", { env: { FAKE_MODE: "nonzero-with-json" } });
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
});
