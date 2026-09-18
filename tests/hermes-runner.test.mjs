import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const RUNNER = fileURLToPath(
  new URL("../scripts/hermes-runner.mjs", import.meta.url)
);

// A fake ACP agent standing in for `hermes acp`. Hermes uses lazy auth, so a
// build that serves session/new directly is never asked to authenticate —
// advertising no auth methods is therefore valid here.
//
// Newlines are built with String.fromCharCode(10) so this template needs no
// escape sequences at all.
//
//   FAKE_HERMES_STOP=<reason>       stopReason to return (default end_turn).
//   FAKE_HERMES_EXIT_AFTER=<ms>     exit this long after answering.
//   FAKE_HERMES_EXIT_CODE=<n>       exit with this code (default 0).
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
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "h-1" } });
    } else if (m.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "h-1",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "THE ANSWER" } },
      } });
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: process.env.FAKE_HERMES_STOP || "end_turn" } });
      setTimeout(() => process.exit(Number(process.env.FAKE_HERMES_EXIT_CODE || "0")), Number(process.env.FAKE_HERMES_EXIT_AFTER || "10"));
    }
  }
});
`;

function runHermes(env = {}) {
  const workspace = makeTempDir("hermes-runner-");
  const pluginData = makeTempDir("hermes-state-");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "hermes"), FAKE_AGENT);

  const result = spawnSync(
    process.execPath,
    [RUNNER, "--kind", "hermes", "--sandbox", "read-only", "--timeout-ms", "20000", "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
      // A regression that leaves the runner's promise unresolved must fail the
      // test rather than hang the whole suite.
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

test("a completed hermes turn is reported completed", () => {
  const { result, parsed } = runHermes({ FAKE_HERMES_EXIT_AFTER: "0" });
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
  assert.equal(parsed.threadId, "h-1");
});

test("a cancelled hermes turn reports blocked, not stalled", () => {
  // The client denying a permission request (or a cancelled turn) is a policy
  // decision, not a hang. Reporting `stalled` would conflate it with the deadline.
  const { parsed } = runHermes({ FAKE_HERMES_STOP: "cancelled" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "blocked", JSON.stringify(parsed));
  assert.match(parsed.error, /cancelled/);
});

test("a hermes refusal is not reported as success", () => {
  const { parsed } = runHermes({ FAKE_HERMES_STOP: "refusal" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "failed", JSON.stringify(parsed));
  assert.match(parsed.error, /refus/i);
});

test("a completed hermes turn survives a nonzero exit that follows it", () => {
  // Regression: `code !== 0` was checked before `phase === "done"`, so a turn
  // that completed normally but whose process then exited nonzero (cleanup
  // error, SIGPIPE) was reported `failed` — the stopReason verdict, which is the
  // authoritative one, was discarded.
  const { parsed } = runHermes({
    FAKE_HERMES_STOP: "end_turn",
    FAKE_HERMES_EXIT_AFTER: "0",
    FAKE_HERMES_EXIT_CODE: "3",
  });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
});
