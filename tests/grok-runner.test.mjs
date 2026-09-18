import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, cleanupDir, writeExecutable } from "./helpers.mjs";

const RUNNER = fileURLToPath(
  new URL("../scripts/grok-runner.mjs", import.meta.url)
);

// A fake ACP agent. Flags let one script cover several protocol shapes.
//
//   FAKE_GROK_AUTH_ERRORS=1   `authenticate` replies "method not found" while
//                             session/new works — an already-logged-in build
//                             that advertises methods it does not implement.
//   FAKE_GROK_EXIT_AFTER=<ms> exit 0 this long after answering the prompt.
//   FAKE_GROK_STOP=<reason>   stopReason to return (default end_turn).
//   FAKE_GROK_NO_ANSWER=1     return the stopReason without streaming a chunk.
//   FAKE_GROK_IGNORE_SIGTERM=1  survive the runner's deadline SIGTERM, so a
//                             delayed response can still arrive after it fired.
//   FAKE_GROK_RESPONSE_DELAY_MS=<ms> delay the prompt response by this long.
const FAKE_AGENT = `#!/usr/bin/env node
const fs = require("fs");
// Optional: record the argv this agent was spawned with, so tests can assert
// how the runner builds the grok command line.
if (process.env.FAKE_GROK_ARGV_FILE) {
  try { fs.writeFileSync(process.env.FAKE_GROK_ARGV_FILE, JSON.stringify(process.argv.slice(2))); } catch {}
}
if (process.env.FAKE_GROK_IGNORE_SIGTERM) process.on("SIGTERM", () => {});
let buf = "";
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: 1,
        authMethods: [{ id: "cached_token" }, { id: "xai.api_key" }],
        agentCapabilities: {},
      } });
    } else if (m.method === "authenticate") {
      if (process.env.FAKE_GROK_AUTH_ERRORS) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: authenticate" } });
      } else {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
    } else if (m.method === "session/new") {
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-1" } });
    } else if (m.method === "session/prompt") {
      const emit = () => {
        if (!process.env.FAKE_GROK_NO_ANSWER) {
          send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "s-1",
            update: { sessionUpdate: "agent_message_chunk", content: { text: "THE ANSWER" } },
          } });
        }
        send({ jsonrpc: "2.0", id: m.id, result: { stopReason: process.env.FAKE_GROK_STOP || "end_turn" } });
        const after = Number(process.env.FAKE_GROK_EXIT_AFTER || "10");
        setTimeout(() => process.exit(0), after);
      };
      // A response landing after the runner's deadline is what the watchdog
      // regression test needs; FAKE_GROK_IGNORE_SIGTERM keeps this process alive
      // long enough to deliver it.
      const delay = Number(process.env.FAKE_GROK_RESPONSE_DELAY_MS || "0");
      if (delay > 0) setTimeout(emit, delay); else emit();
    }
  }
});
`;

function runGrok(env = {}, sandbox = "read-only", timeoutMs = "20000") {
  const workspace = makeTempDir("grok-runner-");
  const pluginData = makeTempDir("grok-state-");
  const argvFile = path.join(workspace, "argv.json");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, "grok"), FAKE_AGENT);

  const result = spawnSync(
    process.execPath,
    [RUNNER, "--kind", "grok", "--sandbox", sandbox, "--timeout-ms", timeoutMs, "--", "hello"],
    {
      cwd: workspace,
      encoding: "utf8",
      // A regression that leaves the runner's promise unresolved must fail the
      // test rather than hang the whole suite.
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CLAUDE_PLUGIN_DATA: pluginData,
        CODEX_TOOLKIT_SESSION_ID: "",
        FAKE_GROK_ARGV_FILE: argvFile,
        ...env,
      },
    }
  );
  const line = (result.stdout || "").trim().split("\n").filter(Boolean).pop();
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    /* leave null so the assertion reports the raw output */
  }
  let argv = null;
  try {
    argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  } catch {
    /* the agent did not record its argv */
  }
  cleanupDir(workspace);
  cleanupDir(pluginData);
  return { result, parsed, argv };
}

test("a completed turn is reported completed even when grok exits immediately after", () => {
  // The agent answers, then exits 0 right away. The prompt response — not the
  // process exit — is what decides the verdict.
  const { result, parsed } = runGrok({ FAKE_GROK_EXIT_AFTER: "0" });
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
  assert.equal(parsed.threadId, "s-1");
  assert.equal(result.status, 0);
});

test("an agent that advertises authenticate but does not implement it still works", () => {
  // ACP auth is lazy: session/new succeeds, so `authenticate` is never called
  // and its absence must not fail the job.
  const { result, parsed } = runGrok({ FAKE_GROK_AUTH_ERRORS: "1" });
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "completed", JSON.stringify(parsed));
  assert.equal(parsed.rawOutput, "THE ANSWER");
});

test("a limit stopReason is not reported as success", () => {
  const { parsed } = runGrok({ FAKE_GROK_STOP: "max_tokens" });
  assert.ok(parsed);
  assert.equal(parsed.status, "failed");
  assert.match(parsed.error, /max_tokens/);
  // The partial answer is still returned rather than discarded.
  assert.equal(parsed.rawOutput, "THE ANSWER");
});

test("a refusal is not reported as success", () => {
  const { parsed } = runGrok({ FAKE_GROK_STOP: "refusal" });
  assert.ok(parsed);
  assert.equal(parsed.status, "failed");
  assert.match(parsed.error, /refus/i);
});

test("an invalid sandbox fails closed instead of escalating permissions", () => {
  const workspace = makeTempDir("grok-runner-");
  try {
    const result = spawnSync(
      process.execPath,
      [RUNNER, "--kind", "grok", "--sandbox", "read_only", "--timeout-ms", "5000", "--", "hi"],
      { cwd: workspace, encoding: "utf8", env: { ...process.env } }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid --sandbox/);
  } finally {
    cleanupDir(workspace);
  }
});

test("read-only passes a top-level --permission-mode default so the client can veto", () => {
  // Without this flag a global `permission_mode = "always-approve"` self-approves
  // tool calls, the client never sees `session/request_permission`, and read-only
  // has nothing to deny. It is a *top-level* flag, so it must precede `agent` —
  // grok rejects it after the subcommand.
  const { parsed, argv } = runGrok();
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "completed");
  assert.ok(Array.isArray(argv), `expected captured argv, got: ${JSON.stringify(argv)}`);
  const at = argv.indexOf("--permission-mode");
  assert.notEqual(at, -1, `expected --permission-mode in: ${argv.join(" ")}`);
  assert.equal(argv[at + 1], "default");
  assert.ok(
    at < argv.indexOf("agent"),
    `--permission-mode must precede 'agent': ${argv.join(" ")}`
  );
});

test("writes-enabled sandboxes keep --always-approve and add no permission mode", () => {
  const { parsed, argv } = runGrok({}, "workspace-write");
  assert.ok(parsed, JSON.stringify(parsed));
  assert.ok(Array.isArray(argv), `expected captured argv, got: ${JSON.stringify(argv)}`);
  assert.equal(argv.includes("--permission-mode"), false, argv.join(" "));
  assert.ok(argv.includes("--always-approve"), argv.join(" "));
});

test("a denied turn reports blocked, not stalled", () => {
  // The client denying a permission request (or a cancelled turn) is a policy
  // decision, not a hang. Reporting `stalled` would conflate it with the deadline.
  const { parsed } = runGrok({ FAKE_GROK_STOP: "cancelled" });
  assert.ok(parsed, JSON.stringify(parsed));
  assert.equal(parsed.status, "blocked", JSON.stringify(parsed));
  assert.match(parsed.error, /cancelled/);
});

test("a deadline that fires while the prompt response is in flight still settles", () => {
  // Regression: the close handler checked `phase === "done"` before `timedOut`.
  // When the deadline fires and the prompt response lands inside the drain
  // window, neither the close handler nor the awaiting flow settled the promise
  // — the runner hung with its heartbeat alive and the job stuck `running`.
  // The fake ignores SIGTERM and answers after the deadline so both conditions
  // hold at once. Before the fix this test fails (spawnSync hits its own guard)
  // rather than returning a status.
  const { result, parsed } = runGrok(
    { FAKE_GROK_IGNORE_SIGTERM: "1", FAKE_GROK_RESPONSE_DELAY_MS: "1200" },
    "read-only",
    "600"
  );
  assert.ok(parsed, `expected JSON result, got: ${result.stdout}\n${result.stderr}`);
  assert.equal(parsed.status, "stalled", JSON.stringify(parsed));
  assert.match(parsed.error, /Timed out/);
});
