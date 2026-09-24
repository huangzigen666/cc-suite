#!/usr/bin/env node
// mimo-runner.mjs — Run Xiaomi MiMo Code (`mimo`, an opencode-family coding
// agent) tasks in foreground or background with job tracking. Mirrors the
// zcode/qoder runners (same lib API) so /cc-suite:status, /result, /cancel,
// and /continue work identically across all backends.
//
// Usage:
//   node mimo-runner.mjs --kind <kind> --model <provider/model> --effort <variant> \
//     --sandbox <sandbox> [--resume <sessionId>] [--timeout-ms <ms>] \
//     [--background] [--session-id <id>] [--summary <text>] -- <prompt>
//
// ─── Transport ─────────────────────────────────────────────────────────────
//
// `mimo acp` exists, but ACP buys nothing here: opencode-family agents allow
// edits and bash by default, so an ACP client never sees a permission request
// it could deny. Enforcement has to come from the agent's own permission
// rules, which `mimo run` accepts through MIMOCODE_PERMISSION. So we shell out:
//
//   mimo run --format json -m <model> --dir <project> [--session <ses_…>] -- <prompt>
//
// and read the JSONL events: `text` events carry `part.text`, `error` events
// carry `error.data.message`, and every event carries `sessionID`, which is
// stored as the job's threadId for resume. `mimo run` exits 0 even after an
// `error` event, so the event — not the exit code — decides failure.
//
// Model: --model, else $MIMO_MODEL, else deepseek/deepseek-flash. The CLI's own
// default (mimo/mimo-auto) is rejected by the free endpoint, and the xiaomi/*
// models need an API key (`mimo providers login`). --effort is forwarded as
// --variant.
//
// Sandbox mapping (cc-suite vocabulary → MiMo permissions):
//   read-only          → MIMOCODE_PERMISSION denies "*" and re-allows only
//                        read/search tools; denied tools are removed from the
//                        agent's tool set (verified: no write, edit, or bash).
//   workspace-write    → MiMo defaults, plus external_directory denied. Bash
//                        stays allowed, so this is best-effort, not a jail.
//   danger-full-access → --dangerously-skip-permissions.

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
const DEFAULT_MODEL = "deepseek/deepseek-flash";
// The MiMo installer puts the binary here and only adds it to interactive
// shell PATHs, so a runner spawned from a non-login shell may not see `mimo`.
const INSTALLER_BIN = `${process.env.HOME || ""}/.mimocode/bin/mimo`;

// Later keys win, so "*" first denies everything the list does not re-allow.
const READ_ONLY_PERMISSION = JSON.stringify({
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
  todoread: "allow",
  todowrite: "allow",
  webfetch: "allow",
  websearch: "allow",
  codesearch: "allow",
});
const WORKSPACE_WRITE_PERMISSION = JSON.stringify({ external_directory: "deny" });

function parseArgs(argv) {
  const args = {
    kind: "mimo",
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

// Unknown sandbox levels fall to read-only.
function mimoSandbox(sandbox) {
  if (sandbox === "danger-full-access") return { flags: ["--dangerously-skip-permissions"], permission: null };
  if (sandbox === "workspace-write") return { flags: [], permission: WORKSPACE_WRITE_PERMISSION };
  return { flags: [], permission: READ_ONLY_PERMISSION };
}

function resolveModel(args) {
  return args.model || process.env.MIMO_MODEL || DEFAULT_MODEL;
}

function buildMimoArgs(args, cwd) {
  const a = ["run", "--format", "json", "-m", resolveModel(args), "--dir", cwd];
  if (args.effort) a.push("--variant", args.effort);
  if (args.resume) a.push("--session", args.resume);
  a.push(...mimoSandbox(args.sandbox).flags);
  a.push("--", withDelegationBoundary(args.prompt));
  return a;
}

// Drive `mimo run --format json` as a subprocess. Resolves with
// { status, rawOutput, sessionId, errorMessage }.
function executeMimo(cwd, args, logFile) {
  return new Promise((resolve) => {
    const bin = process.env.MIMO_BIN || (fs.existsSync(INSTALLER_BIN) ? INSTALLER_BIN : "mimo");
    const mArgs = buildMimoArgs(args, cwd);
    const { permission } = mimoSandbox(args.sandbox);
    const env = { ...process.env };
    // The runner owns the permission tier; a caller's MIMOCODE_PERMISSION must
    // not widen read-only.
    if (permission) env.MIMOCODE_PERMISSION = permission;
    else delete env.MIMOCODE_PERMISSION;

    appendLog(logFile, `Exec: ${bin} ${mArgs.slice(0, -1).join(" ")} <prompt>`);
    appendLog(logFile, `Sandbox: ${args.sandbox}${permission ? ` (MIMOCODE_PERMISSION=${permission})` : ""}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn(bin, mArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], env });

    const startedAt = Date.now();
    let buf = "";
    let stderrTail = "";
    const texts = [];
    const errors = [];
    let sessionId = args.resume || null;
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

    function handleLine(line) {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.sessionID) sessionId = m.sessionID;
      if (m.type === "text" && m.part && typeof m.part.text === "string") {
        texts.push(m.part.text);
      } else if (m.type === "error") {
        const e = m.error || {};
        errors.push((e.data && e.data.message) || e.message || e.name || "unknown error");
      }
    }

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-3000);
      fs.appendFileSync(logFile, text, "utf8");
    });

    child.on("error", (err) => {
      const hint = err.code === "ENOENT"
        ? "mimo not found on PATH — install MiMo Code (~/.mimocode/bin/mimo) or set MIMO_BIN"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (buf.trim()) handleLine(buf.trim());
      const msg = code === null ? `signal ${signal}` : `exit ${code}`;
      const answer = texts.join("\n\n").trim();

      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId, rawOutput: answer });
        return;
      }
      if (errors.length > 0) {
        // mimo exits 0 after an error event; the event is authoritative.
        finish({ status: "failed", errorMessage: `mimo: ${errors[errors.length - 1]}`, sessionId, rawOutput: answer });
        return;
      }
      if (code !== 0) {
        finish({ status: "failed", errorMessage: stderrTail.trim() || `mimo ${msg}`, sessionId, rawOutput: answer });
        return;
      }
      if (!answer) {
        finish({ status: "failed", errorMessage: "mimo exited cleanly but produced no answer", sessionId, rawOutput: "" });
        return;
      }
      finish({ status: "completed", sessionId, rawOutput: answer });
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
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=mimo/run)`);

  const result = await executeMimo(cwd, args, logFile);

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
  appendLog(logFile, `Queued ${args.kind} task (background, backend=mimo/run)`);

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
  appendLog(logFile, "Background worker started (backend=mimo/run)");

  const result = await executeMimo(cwd, args, logFile);

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
