import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const RUNNER = fileURLToPath(
  new URL("../scripts/qoder-runner.mjs", import.meta.url)
);

// A fake `qoder` in print mode. The runner scrapes Claude-Code-style
// stream-json, so this emits `type:"assistant"` (message.content text) and,
// depending on the mode, a terminal `type:"result"`.
//
// Newlines are built with String.fromCharCode(10) so this template needs no
// escape sequences at all.
//
//   FAKE_QODER_MODE        result | answer-only | result-error | echo-prompt
//                          (default result; echo-prompt returns the prompt argv)
//   FAKE_QODER_EXIT_CODE   exit with this code                   (default 0)
//   FAKE_QODER_EXIT_AFTER  exit this long after emitting         (default 10ms)
const FAKE_AGENT = `#!/usr/bin/env node
const NL = String.fromCharCode(10);
function out(o) { process.stdout.write(JSON.stringify(o) + NL); }
const SID = "q-1";
const mode = process.env.FAKE_QODER_MODE || "result";
out({ type: "assistant", session_id: SID, message: { content: [{ type: "text", text: "THE ANSWER" }] } });
if (mode === "result") {
  out({ type: "result", subtype: "success", session_id: SID, result: "FINAL RESULT" });
} else if (mode === "result-error") {
  out({ type: "result", subtype: "error", session_id: SID, result: "SOMETHING FAILED" });
} else if (mode === "echo-prompt") {
  out({ type: "result", subtype: "success", session_id: SID, result: process.argv[process.argv.length - 1] });
}
setTimeout(
  () => process.exit(Number(process.env.FAKE_QODER_EXIT_CODE || "0")),
  Number(process.env.FAKE_QODER_EXIT_AFTER || "10")
);
`;

function runQoder(env = {}) {
  const workspace = makeTempDir("qoder-runner-");
  const pluginData = makeTempDir("qoder-state-");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "qoder"), FAKE_AGENT);

  const result = spawnSync(
    process.execPath,
    [RUNNER, "--kind", "qoder", "--sandbox", "read-only", "--timeout-ms", "20000", "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
      // A regression that leaves the runner unsettled must fail the test rather
      // than hang the whole suite.
      timeout: 15000,
      env: {
        ...process.env,
        PATH: binDir + path.delimiter + process.env.PATH,
        CLAUDE_PLUGIN_DATA: pluginData,
        CODEX_TOOLKIT_SESSION_ID: "",
        ...env,
      },
    }
  );
  const line = (result.stdout || "")
    .trim()
    .split(String.fromCharCode(10))
    .filter(Boolean)
    .pop();
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    /* leave null so the assertion reports the raw output */
  }
  cleanupDir(workspace);
  cleanupDir(pluginData);
  return { result, parsed };
}

// The runner reports a failure message under `error` (the other runners do the
// same); accept `errorMessage` too so this suite tests behaviour, not the key name.
function failureText(parsed) {
  return String(parsed.error ?? parsed.errorMessage ?? "");
}

test("a qoder turn with a terminal success result and a clean exit is completed", () => {
  const { result, parsed } = runQoder({ FAKE_QODER_MODE: "result" });
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "FINAL RESULT");
});

test("a terminal success result with a nonzero exit is a mismatch, not a success", () => {
  // Regression: this branch reported `completed` without consulting the exit
  // code, so a run that failed after reporting success was recorded as a
  // success. The qwen runner treats the same shape as `exit_mismatch`.
  const { parsed } = runQoder({ FAKE_QODER_MODE: "result", FAKE_QODER_EXIT_CODE: "3" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(failureText(parsed), /reported a success result/i);
});

test("an answer with no terminal result event completes only on a clean exit", () => {
  const { parsed } = runQoder({ FAKE_QODER_MODE: "answer-only" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
});

test("an answer with no terminal result event fails on a nonzero exit", () => {
  // Regression: same branch, no exit-code check — streamed text plus a failing
  // process was reported as a success.
  const { parsed } = runQoder({ FAKE_QODER_MODE: "answer-only", FAKE_QODER_EXIT_CODE: "3" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
});

test("a terminal error subtype is a failure even with a clean exit", () => {
  const { parsed } = runQoder({ FAKE_QODER_MODE: "result-error" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(failureText(parsed), /SOMETHING FAILED/);
});

test("the prompt handed to qoder carries the delegation boundary", () => {
  // Regression: the runner imported withDelegationBoundary but passed the raw
  // prompt, so Qoder — which reads the shared skills tree — got no boundary.
  const { parsed } = runQoder({ FAKE_QODER_MODE: "echo-prompt" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.match(parsed.rawOutput, /^This request already reached you by delegation from Claude Code\.[\s\S]*hello$/);
});
