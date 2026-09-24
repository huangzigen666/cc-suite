#!/usr/bin/env node
// doubao-runner.mjs — Send prompts to Doubao (ByteDance's 豆包 desktop app) in
// foreground or background with job tracking. Mirrors the zcode/qoder runners
// (same lib API) so /cc-suite:status, /result, /cancel, and /continue work
// identically across all backends.
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
import { spawn } from "node:child_process";

import {
  generateJobId,
  upsertJob,
  writeJobFile,
  resolveJobLogFile,
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { withDelegationBoundary } from "./lib/delegation-boundary.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — matches the other runners
const HEARTBEAT_MS = 30 * 1000;
const SIGKILL_GRACE_MS = 5 * 1000;
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

function appendLog(logFile, message) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
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
// { status, rawOutput, sessionId, errorMessage }.
function executeDoubao(cwd, args, logFile) {
  return new Promise((resolve) => {
    const bin = process.env.DOUBAO_BIN || "doubao";
    const dArgs = buildDoubaoArgs(args);

    appendLog(logFile, `Exec: ${bin} ${dArgs.slice(0, -1).join(" ")} <prompt>`);
    appendLog(logFile, `Sandbox: ${args.sandbox} (no effect: Doubao has no workspace access)`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn(bin, dArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const startedAt = Date.now();
    let stdout = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;

    const heartbeat = setInterval(() => {
      appendLog(logFile, `…still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
    }, HEARTBEAT_MS);

    const deadline = setTimeout(() => {
      timedOut = true;
      appendLog(logFile, `Deadline exceeded (${Math.round(args.timeoutMs / 1000)}s) — terminating`);
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, SIGKILL_GRACE_MS);
    }, args.timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      try { child.kill(); } catch { /* already dead */ }
      resolve(result);
    }

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-3000);
      fs.appendFileSync(logFile, text, "utf8");
    });

    child.on("error", (err) => {
      const hint = err.code === "ENOENT"
        ? "doubao not found on PATH — install doubao-cli (npm i -g doubao-cli) or set DOUBAO_BIN"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
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
    });
  });
}

async function runForeground(cwd, args) {
  const jobId = generateJobId(args.kind);
  const logFile = resolveJobLogFile(cwd, jobId);
  const sessionId = args.sessionId || process.env.CODEX_TOOLKIT_SESSION_ID || null;
  const deadlineAt = new Date(Date.now() + args.timeoutMs).toISOString();

  upsertJob(cwd, {
    id: jobId, kind: args.kind, status: "running",
    summary: args.summary || `${args.kind} task`,
    sessionId, pid: process.pid,
    startedAt: new Date().toISOString(), deadlineAt, logFile,
  });
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=doubao/cdp)`);

  const result = await executeDoubao(cwd, args, logFile);

  upsertJob(cwd, {
    id: jobId, status: result.status,
    threadId: result.sessionId || null,
    completedAt: new Date().toISOString(),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
  writeJobFile(cwd, jobId, {
    rawOutput: result.rawOutput || "",
    threadId: result.sessionId || null,
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  });

  const output = {
    jobId, status: result.status,
    threadId: result.sessionId || null,
    rawOutput: result.rawOutput || "",
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  if (result.status !== "completed") process.exitCode = 1;
}

function runBackground(cwd, args) {
  const jobId = generateJobId(args.kind);
  const logFile = resolveJobLogFile(cwd, jobId);
  const sessionId = args.sessionId || process.env.CODEX_TOOLKIT_SESSION_ID || null;

  upsertJob(cwd, {
    id: jobId, kind: args.kind, status: "queued",
    summary: args.summary || `${args.kind} task`, sessionId, logFile,
  });
  appendLog(logFile, `Queued ${args.kind} task (background, backend=doubao/cdp)`);

  const childArgv = [
    fileURLToPath(import.meta.url),
    "--kind", args.kind,
    "--model", args.model || "",
    "--effort", args.effort || "",
    "--sandbox", args.sandbox,
    "--timeout-ms", String(args.timeoutMs),
    "--session-id", sessionId || "",
    "--summary", args.summary || "",
  ];
  if (args.resume) childArgv.push("--resume", args.resume);
  childArgv.push("--", args.prompt);

  const child = spawn(process.execPath, childArgv, {
    cwd, detached: true, stdio: "ignore",
    env: { ...process.env, CODEX_TOOLKIT_BACKGROUND_JOB_ID: jobId },
  });

  child.on("error", (err) => {
    appendLog(logFile, `Background spawn error: ${err.message}`);
    upsertJob(cwd, {
      id: jobId, status: "failed",
      errorMessage: `Failed to start background worker: ${err.message}`,
      completedAt: new Date().toISOString(),
    });
  });
  child.unref();

  process.stdout.write(JSON.stringify({ jobId, status: "queued", message: `Job ${jobId} started in background.` }) + "\n");
}

async function runBackgroundWorker(cwd, args, jobId) {
  const logFile = resolveJobLogFile(cwd, jobId);
  upsertJob(cwd, {
    id: jobId, status: "running", pid: process.pid,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
  });
  appendLog(logFile, "Background worker started (backend=doubao/cdp)");

  const result = await executeDoubao(cwd, args, logFile);

  upsertJob(cwd, {
    id: jobId, status: result.status,
    threadId: result.sessionId || null,
    completedAt: new Date().toISOString(),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
  writeJobFile(cwd, jobId, {
    rawOutput: result.rawOutput || "",
    threadId: result.sessionId || null,
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.prompt) {
    process.stderr.write("Error: no prompt provided. Use -- <prompt>\n");
    process.exit(1);
  }
  const cwd = resolveWorkspaceRoot(process.cwd());

  const backgroundJobId = process.env.CODEX_TOOLKIT_BACKGROUND_JOB_ID;
  if (backgroundJobId) {
    await runBackgroundWorker(cwd, args, backgroundJobId);
    return;
  }
  if (args.background) runBackground(cwd, args);
  else await runForeground(cwd, args);
}

main().catch((error) => {
  const message = error?.message || String(error);
  process.stdout.write(JSON.stringify({ status: "failed", error: message }) + "\n");
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
