import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const RUNNER = fileURLToPath(
  new URL("../scripts/codebuddy-runner.mjs", import.meta.url)
);

// A fake ACP agent standing in for `codebuddy --acp`. Lazy auth: a build that
// serves session/new directly is never asked to authenticate.
//
// Newlines are built with String.fromCharCode(10) so this template needs no
// escape sequences at all. `chars` carries the word directly into the emitted
// template without any inline escapes.
//
//   FAKE_CODEBUDDY_STOP=<reason>     stopReason to return (default end_turn).
//   FAKE_CODEBUDDY_EXIT_AFTER=<ms>   exit 0 this long after answering.
const FAKE_AGENT = `#!/usr/bin/env node
let buf = "";
function send(o) { process.stdout.write(JSON.stringify(o) + String.fromCharCode(10)); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {},
      } });
    } else if (m.method === "session/new") {
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "c-1" } });
    } else if (m.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "c-1",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "THE ANSWER" } },
      } });
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: process.env.FAKE_CODEBUDDY_STOP || "end_turn" } });
      setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEBUDDY_EXIT_AFTER || "10"));
    }
  }
});
`;

function runCodebuddy(env = {}) {
  const workspace = makeTempDir("codebuddy-runner-");
  const pluginData = makeTempDir("codebuddy-state-");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "codebuddy"), FAKE_AGENT);

  const result = spawnSync(
    process.execPath,
    [RUNNER, "--kind", "codebuddy", "--sandbox", "read-only", "--timeout-ms", "20000", "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
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

test("a completed codebuddy turn is reported completed", () => {
  const { result, parsed } = runCodebuddy({ FAKE_CODEBUDDY_EXIT_AFTER: "0" });
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
  assert.equal(parsed.threadId, "c-1");
});

test("a cancelled codebuddy turn reports blocked, not stalled", () => {
  // Regression guard: the close handler used to settle `completed` on a clean
  // exit, racing the stopReason verdict — so a cancelled turn was reported as a
  // success. Denial is a policy decision, not a deadline, hence `blocked`.
  const { parsed } = runCodebuddy({ FAKE_CODEBUDDY_STOP: "cancelled" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "blocked", JSON.stringify(parsed));
  assert.match(parsed.error, /cancelled/);
});

test("a codebuddy refusal is not reported as success", () => {
  const { parsed } = runCodebuddy({ FAKE_CODEBUDDY_STOP: "refusal" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /refus/i);
});
