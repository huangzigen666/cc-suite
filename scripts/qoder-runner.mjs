#!/usr/bin/env node
// qoder-runner.mjs — Run Qoder (agentic coding CLI, a Claude-Code-style
// binary) tasks in foreground or background with job tracking. Mirrors the
// cache's grok/codebuddy runners (same lib API) so /cc-suite:status, /result,
// /cancel, and /continue work identically across all backends.
//
// Usage:
//   node qoder-runner.mjs --kind <kind> --model <model> --effort <effort> \
//     --sandbox <sandbox> [--resume <sessionId>] [--timeout-ms <ms>] \
//     [--background] [--session-id <id>] [--summary <text>] -- <prompt>
//
// ─── How Qoder differs from the ACP lanes ──────────────────────────────────
//
// Qoder is a Claude-Code-style CLI (fork of the Code agent). It has NO ACP
// server mode, so we cannot drive it as an ACP client. Instead we shell out in
// non-interactive print mode, exactly like the codex/agy runners:
//
//   qoder -p --output-format stream-json --permission-mode <m> \
//         --cwd <project> -- <prompt>
//
// and scrape the streamed JSON lines (Claude-Code stream-json shape): assistant
// text deltas plus a final `result` message carrying the answer and
// `session_id`. The session id is stored as the job's threadId, so
// /cc-suite:continue can resume via `qoder --resume <id>`.
//
// Governance: the `qoder` launcher runs a fail-closed preflight that forbids
// running from the Home navigation root. We therefore ALWAYS pass `--cwd` to a
// resolved project directory, and we spawn `qoder` (not `qodercli`) so the
// user's governance check still applies.
//
// Sandbox mapping (cc-suite vocabulary → Qoder --permission-mode):
//   read-only          → "auto" (best-effort read; Qoder has no hard read-only)
//   workspace-write    → "accept_edits"
//   danger-full-access → "bypass_permissions"

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

function parseArgs(argv) {
  const args = {
    kind: "qoder",
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

// Map cc-suite sandbox levels onto Qoder's --permission-mode choices.
function qoderPermissionMode(sandbox) {
  if (sandbox === "danger-full-access") return "bypass_permissions";
  if (sandbox === "workspace-write") return "accept_edits";
  return "auto"; // read-only, best-effort (Qoder has no hard read-only tier)
}

// Build the `qoder` argv. We always pass --cwd to satisfy Qoder's fail-closed
// "no task execution from Home root" governance check, and we spawn `qoder`
// (the launcher) rather than `qodercli` so governance runs.
function buildQoderArgs(args, cwd) {
  const mode = qoderPermissionMode(args.sandbox);
  const a = ["-p", "--output-format", process.env.QODER_OUTPUT_FORMAT || "stream-json"];
  if (args.model) a.push("-m", args.model);
  if (args.effort) a.push("--reasoning-effort", args.effort);
  a.push("--permission-mode", mode);
  a.push("--cwd", cwd);
  if (args.resume) a.push("--resume", args.resume);
  a.push("--", withDelegationBoundary(args.prompt));
  return a;
}

// Drive `qoder -p` as a scraped subprocess. Resolves with
// { status, rawOutput, sessionId, errorMessage }.
function executeQoder(cwd, args, logFile) {
  return new Promise((resolve) => {
    const qoderArgs = buildQoderArgs(args, cwd);

    appendLog(logFile, `Exec: qoder ${qoderArgs.join(" ")} (print mode, scraping)`);
    appendLog(logFile, `Model: ${args.model || "(default)"}, Effort: ${args.effort || "(default)"}, Sandbox: ${args.sandbox}${args.resume ? ` (resuming ${args.resume})` : ""}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn("qoder", qoderArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"], // stdin unused, stdout: stream-json, stderr: diagnostics
      env: { ...process.env },
    });

    const startedAt = Date.now();
    let buf = "";
    let stderrTail = "";
    const answer = [];
    let rawStdout = "";
    let anyJsonParsed = false;
    let settled = false;
    let timedOut = false;
    let sessionId = args.resume || null;
    let resultReceived = false;
    let finalResult = null;
    let finalSessionId = null;
    let finalSubtype = null;

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

    // Parse one stream-json line. Claude-Code-style: assistant messages carry
    // `message.content` (array of {type:"text",text}); the final message has
    // type "result" with `result` text and `session_id`.
    function handleLine(line) {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      anyJsonParsed = true;
      const sid = m.session_id || m.sessionId;
      if (sid) sessionId = sid;
      if (m.type === "result") {
        resultReceived = true;
        if (typeof m.result === "string") finalResult = m.result;
        if (sid) finalSessionId = sid;
        finalSubtype = m.subtype || null;
      } else if (m.type === "assistant") {
        const content = m.message && m.message.content;
        if (Array.isArray(content)) {
          for (const p of content) {
            if (p && p.type === "text" && typeof p.text === "string") answer.push(p.text);
          }
        } else if (typeof content === "string") {
          answer.push(content);
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      rawStdout += chunk.toString("utf8");
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-3000);
      fs.appendFileSync(logFile, text, "utf8");
    });

    child.on("error", (err) => {
      const hint = err.code === "ENOENT"
        ? "qoder not found on PATH — install Qoder: https://qoder.com (ensure `qoder` is on PATH)"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      // Flush any trailing buffered line.
      if (buf.trim()) handleLine(buf.trim());
      const msg = code === null ? `signal ${signal}` : `exit ${code}`;

      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId, rawOutput: answer.join("").trim() });
        return;
      }
      if (resultReceived) {
        const out = (finalResult != null ? finalResult : answer.join("")).trim();
        const failed = finalSubtype === "error";
        if (!failed && code !== 0) {
          // A terminal success result plus a nonzero exit is a mismatch, not a
          // success — the process failed after reporting. Same rule the qwen
          // runner enforces as `exit_mismatch`; reporting `completed` here is the
          // false success this codebase treats as its worst failure mode.
          finish({
            status: "failed",
            sessionId: finalSessionId || sessionId,
            rawOutput: out,
            errorMessage: `qoder reported a success result but ${msg}`,
          });
          return;
        }
        finish({
          status: failed ? "failed" : "completed",
          sessionId: finalSessionId || sessionId,
          rawOutput: out,
          errorMessage: failed ? out : undefined,
        });
        return;
      }
      if (answer.length > 0 && anyJsonParsed) {
        // No terminal result event, but the stream produced an answer. Only a
        // clean exit makes that a success; the partial output is still reported
        // when the exit says otherwise.
        if (code !== 0) {
          finish({
            status: "failed",
            errorMessage: stderrTail.trim() || `qoder exited ${msg} after streaming an answer`,
            sessionId,
            rawOutput: answer.join("").trim(),
          });
          return;
        }
        finish({ status: "completed", sessionId, rawOutput: answer.join("").trim() });
        return;
      }
      if (rawStdout.trim().length > 0 && code === 0) {
        // Plain-text fallback: stream-json was not honored, stdout is the answer.
        // Gated on a clean exit — a nonzero exit with a line of error text on
        // stdout is a failure, not an answer.
        finish({ status: "completed", sessionId, rawOutput: rawStdout.trim() });
        return;
      }
      if (code === 0) {
        finish({ status: "completed", sessionId, rawOutput: "" });
      } else {
        finish({ status: "failed", errorMessage: stderrTail.trim() || msg, sessionId, rawOutput: "" });
      }
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
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=qoder/print)`);

  const result = await executeQoder(cwd, args, logFile);

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
  appendLog(logFile, `Queued ${args.kind} task (background, backend=qoder/print)`);

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
  appendLog(logFile, "Background worker started (backend=qoder/print)");

  const result = await executeQoder(cwd, args, logFile);

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
