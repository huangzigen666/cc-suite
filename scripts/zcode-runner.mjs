#!/usr/bin/env node
// zcode-runner.mjs — Run ZCode (Z.AI's GLM coding agent) tasks in foreground
// or background with job tracking. Mirrors the qoder runner (same lib API) so
// /cc-suite:status, /result, /cancel, and /continue work identically across
// all backends.
//
// Usage:
//   node zcode-runner.mjs --kind <kind> --model <model> --effort <effort> \
//     --sandbox <sandbox> [--resume <sessionId>] [--timeout-ms <ms>] \
//     [--background] [--session-id <id>] [--summary <text>] -- <prompt>
//
// ─── Transport ─────────────────────────────────────────────────────────────
//
// ZCode ships its CLI inside the desktop app (ZCode.app/Contents/Resources/
// glm/zcode.cjs) and does not put it on PATH. It has an `app-server` stdio
// protocol, but the headless prompt mode is enough for one bounded turn:
//
//   zcode -p <prompt> --mode <m> --json --cwd <project> [--resume <sess_…>]
//
// On success it prints ONE pretty-printed JSON object on stdout carrying
// `sessionId` and `response`; on failure it exits nonzero with
// `Error: …` on stderr. The sessionId is stored as the job's threadId so
// /cc-suite:continue can resume it.
//
// Binary resolution: $ZCODE_BIN, then `zcode` on PATH, then the app bundle
// entry run through node. When run straight from the bundle the CLI cannot find
// its built-in provider config (it looks relative to a packaging layout the app
// does not ship), so the runner points ZCODE_BUILTIN_PROVIDER_CONFIG_FILE at
// the bundle's config/provider/zcode-builtin.json unless the caller set it.
//
// Sandbox mapping (cc-suite vocabulary → ZCode --mode). `--mode` is ALWAYS
// passed: ZCode defaults headless prompts to `yolo`.
//   read-only          → "plan"  (ZCode's policy denies every non-read-only tool)
//   workspace-write    → "edit"  (workspace file edits allowed)
//   danger-full-access → "yolo"  (permission prompts bypassed)
//
// ZCode's headless mode has no model or reasoning-effort flag; --model and
// --effort are recorded in the log and otherwise ignored.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

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
const APP_ENTRY = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

function parseArgs(argv) {
  const args = {
    kind: "zcode",
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

// Map cc-suite sandbox levels onto ZCode's --mode choices. Unknown levels fall
// to the read-only tier, never to ZCode's own `yolo` default.
function zcodeMode(sandbox) {
  if (sandbox === "danger-full-access") return "yolo";
  if (sandbox === "workspace-write") return "edit";
  return "plan";
}

function onPath(bin) {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Resolve how to launch ZCode: { command, prefix, env }. `prefix` holds argv
// that precede the zcode flags (the entry script when launched through node).
function resolveZcode() {
  const entry = process.env.ZCODE_BIN || onPath("zcode") || (fs.existsSync(APP_ENTRY) ? APP_ENTRY : null);
  if (!entry) return null;
  const env = { ...process.env };
  if (entry.endsWith(".cjs") || entry.endsWith(".js")) {
    const bundled = path.resolve(path.dirname(entry), "..", "config", "provider", "zcode-builtin.json");
    if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && fs.existsSync(bundled)) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = bundled;
    }
    return { command: process.execPath, prefix: [entry], env };
  }
  return { command: entry, prefix: [], env };
}

function buildZcodeArgs(args, cwd) {
  const a = ["-p", withDelegationBoundary(args.prompt), "--mode", zcodeMode(args.sandbox), "--json", "--cwd", cwd];
  if (args.resume) a.push("--resume", args.resume);
  return a;
}

// Pull the result object out of stdout. The CLI prints one pretty-printed JSON
// object; anything before its first `{` (stray diagnostics) is ignored.
function parseResult(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return null; }
}

// Drive `zcode -p` as a subprocess. Resolves with
// { status, rawOutput, sessionId, errorMessage }.
function executeZcode(cwd, args, logFile) {
  return new Promise((resolve) => {
    const launch = resolveZcode();
    if (!launch) {
      const hint = "zcode not found — install ZCode (https://zcode.z.ai) or set ZCODE_BIN to its CLI";
      appendLog(logFile, `Spawn error: ${hint}`);
      resolve({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
      return;
    }
    const zArgs = [...launch.prefix, ...buildZcodeArgs(args, cwd)];

    appendLog(logFile, `Exec: ${launch.command} ${launch.prefix.join(" ")} -p <prompt> --mode ${zcodeMode(args.sandbox)} --json --cwd ${cwd}${args.resume ? ` --resume ${args.resume}` : ""}`);
    appendLog(logFile, `Sandbox: ${args.sandbox}${args.model || args.effort ? " (model/effort ignored: zcode -p has no such flags)" : ""}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn(launch.command, zArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
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
      appendLog(logFile, `Spawn error: ${err.message}`);
      finish({ status: "failed", errorMessage: err.message, sessionId: null, rawOutput: "" });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      const msg = code === null ? `signal ${signal}` : `exit ${code}`;
      const parsed = parseResult(stdout);
      const sessionId = (parsed && parsed.sessionId) || args.resume || null;
      const response = parsed && typeof parsed.response === "string" ? parsed.response.trim() : "";

      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId, rawOutput: response });
        return;
      }
      if (code !== 0) {
        // A nonzero exit is a failure even when a response was printed — the
        // same exit-mismatch rule the qoder and qwen runners enforce.
        const errLine = stderrTail.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("Error:")).pop();
        finish({
          status: "failed",
          errorMessage: parsed ? `zcode printed a response but ${msg}` : (errLine || stderrTail.trim() || msg),
          sessionId,
          rawOutput: response,
        });
        return;
      }
      if (!parsed) {
        finish({ status: "failed", errorMessage: "zcode exited cleanly but printed no JSON result", sessionId, rawOutput: stdout.trim() });
        return;
      }
      finish({ status: "completed", sessionId, rawOutput: response });
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
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=zcode/print)`);

  const result = await executeZcode(cwd, args, logFile);

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
  appendLog(logFile, `Queued ${args.kind} task (background, backend=zcode/print)`);

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
  appendLog(logFile, "Background worker started (backend=zcode/print)");

  const result = await executeZcode(cwd, args, logFile);

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
