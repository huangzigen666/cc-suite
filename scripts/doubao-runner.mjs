#!/usr/bin/env node
// doubao-runner.mjs — Send prompts to Doubao (ByteDance's 豆包 desktop app) in
// foreground or background with job tracking. The job lifecycle lives in
// lib/job-runner.mjs and process handling in lib/runner-lifecycle.mjs, so
// /cc-suite:status, /result, /cancel, and /continue work identically across
// all backends.
//
// Usage:
//   node doubao-runner.mjs --kind <kind> --model <model> --effort <effort> \
//     --sandbox <sandbox> [--resume <conversationId>] [--timeout-ms <ms>] \
//     [--background] [--session-id <id>] [--summary <text>] -- <prompt>
//
// ─── Transport ─────────────────────────────────────────────────────────────
//
// Doubao is a chat assistant, not a coding agent: it has no workspace, file,
// or shell access. The `doubao` CLI (npm: doubao-cli) drives the signed-in
// Doubao.app renderer over local CDP:
//
//   doubao sessions create        --wait --json --timeout <s> -- <prompt>
//   doubao sessions send <convId> --wait --json --timeout <s> -- <prompt>
//
// On success it prints one JSON object carrying `conversationId` and
// `reply.text`; on failure it exits nonzero with `doubao: …` on stderr. The
// conversationId is stored as the job's threadId so --resume continues the
// same conversation. Doubao.app must be running with CDP enabled
// (`doubao cdp launch`); doubao-preflight.sh checks that.
//
// Sandbox: every level is equivalent — Doubao cannot touch the workspace, so
// the only thing that leaves the machine is the prompt text itself.
// --model and --effort are forwarded as `--model` / `--reasoning`.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withDelegationBoundary } from "./lib/delegation-boundary.mjs";
import { appendLog, runJobMain } from "./lib/job-runner.mjs";
import {
  createTextDecoder,
  guard,
  spawnBackend,
  superviseBackend,
} from "./lib/runner-lifecycle.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — matches the other runners
const HEARTBEAT_MS = 30 * 1000;
// Give doubao's own reply deadline room to report before ours kills it.
const INNER_DEADLINE_MARGIN_S = 10;

function parseArgs(argv) {
  const args = {
    kind: "doubao",
    model: null,
    effort: null,
    sandbox: "read-only",
    resume: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    background: false,
    sessionId: null,
    summary: null,
    prompt: null,
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--kind" && argv[i + 1]) { args.kind = argv[++i]; }
    else if (arg === "--model" && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === "--effort" && argv[i + 1]) { args.effort = argv[++i]; }
    else if (arg === "--sandbox" && argv[i + 1]) { args.sandbox = argv[++i]; }
    else if (arg === "--resume" && argv[i + 1]) { args.resume = argv[++i]; }
    else if (arg === "--timeout-ms" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.timeoutMs = n;
    }
    else if (arg === "--background") { args.background = true; }
    else if (arg === "--session-id" && argv[i + 1]) { args.sessionId = argv[++i]; }
    else if (arg === "--summary" && argv[i + 1]) { args.summary = argv[++i]; }
    else if (arg === "--") { args.prompt = argv.slice(i + 1).join(" "); break; }
    i++;
  }

  return args;
}

function buildDoubaoArgs(args) {
  const innerSeconds = Math.max(1, Math.floor(args.timeoutMs / 1000) - INNER_DEADLINE_MARGIN_S);
  const a = args.resume ? ["sessions", "send", args.resume] : ["sessions", "create"];
  a.push("--wait", "--json", "--timeout", String(innerSeconds));
  if (args.model) a.push("--model", args.model);
  if (args.effort) a.push("--reasoning", args.effort);
  a.push("--", withDelegationBoundary(args.prompt));
  return a;
}

function parseResult(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
}

// Drive `doubao sessions create|send --wait` as a subprocess. Resolves with
// { status, rawOutput, sessionId, errorMessage }. Killing the CLI stops the
// local wait only: the reply may keep generating inside Doubao.app, which the
// runner deliberately does not touch.
function executeDoubao(cwd, args, logFile) {
  return new Promise((resolve) => {
    const bin = process.env.DOUBAO_BIN || "doubao";
    const dArgs = buildDoubaoArgs(args);

    appendLog(logFile, `Exec: ${bin} ${dArgs.slice(0, -1).join(" ")} <prompt>`);
    appendLog(logFile, `Sandbox: ${args.sandbox} (no effect: Doubao has no workspace access)`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);
    const { child, release } = spawnBackend(bin, dArgs, { cwd, env: { ...process.env } });

    const startedAt = Date.now();
    const stdoutText = createTextDecoder();
    const stderrText = createTextDecoder();
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let heartbeat = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      supervisor.dispose();
      resolve(result);
    }

    function fail(error) {
      finish({ status: "failed", errorMessage: `Runner callback failed: ${error?.message || error}`, sessionId: args.resume || null, rawOutput: "" });
    }

    const supervisor = superviseBackend(child, {
      timeoutMs: args.timeoutMs,
      release,
      onError: fail,
      onDeadline: () => {
        timedOut = true;
        appendLog(logFile, `Deadline exceeded (${Math.round(args.timeoutMs / 1000)}s) — terminating the process tree`);
      },
      onDrain: () => appendLog(logFile, "doubao exited but its output pipes stayed open — terminating leftover processes"),
    });

    heartbeat = setInterval(guard(() => {
      appendLog(logFile, `…still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
    }, fail), HEARTBEAT_MS);

    child.stdout.on("data", guard((chunk) => { stdout += stdoutText.write(chunk); }, fail));

    child.stderr.on("data", guard((chunk) => {
      const text = stderrText.write(chunk);
      stderrTail = (stderrTail + text).slice(-3000);
      fs.appendFileSync(logFile, text, "utf8");
    }, fail));

    child.on("error", guard((err) => {
      const hint = err.code === "ENOENT"
        ? "doubao not found on PATH — install doubao-cli (npm i -g doubao-cli) or set DOUBAO_BIN"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    }, fail));

    child.on("close", guard((code, signal) => {
      if (settled) return;
      stdout += stdoutText.end();
      const msg = code === null ? `signal ${signal}` : `exit ${code}`;
      const parsed = parseResult(stdout);
      const sessionId = (parsed && parsed.conversationId) || args.resume || null;
      const reply = parsed && parsed.reply && typeof parsed.reply.text === "string" ? parsed.reply.text.trim() : "";

      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId, rawOutput: reply });
        return;
      }
      if (code !== 0) {
        const errLine = stderrTail.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("doubao:")).pop();
        finish({
          status: "failed",
          errorMessage: parsed ? `doubao printed a reply but ${msg}` : (errLine || stderrTail.trim() || msg),
          sessionId,
          rawOutput: reply,
        });
        return;
      }
      if (!reply) {
        // --wait promises a reply; a clean exit without one is not an answer.
        finish({ status: "failed", errorMessage: "doubao exited cleanly but returned no reply", sessionId, rawOutput: "" });
        return;
      }
      finish({ status: "completed", sessionId, rawOutput: reply });
    }, fail));
  });
}

runJobMain({
  args: parseArgs(process.argv),
  execute: executeDoubao,
  label: "doubao/cdp",
  scriptPath: fileURLToPath(import.meta.url),
});
