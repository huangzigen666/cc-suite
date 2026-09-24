#!/usr/bin/env node
// zcode-runner.mjs — Run ZCode (Z.AI's GLM coding agent) tasks in foreground
// or background with job tracking. The job lifecycle lives in lib/job-runner.mjs
// and process handling in lib/runner-lifecycle.mjs, so
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
import { spawnSync } from "node:child_process";

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
    const { child, release } = spawnBackend(launch.command, zArgs, { cwd, env: launch.env });

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
      onDrain: () => appendLog(logFile, "zcode exited but its output pipes stayed open — terminating leftover processes"),
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
      const hint = err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    }, fail));

    child.on("close", guard((code, signal) => {
      if (settled) return;
      stdout += stdoutText.end();
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
    }, fail));
  });
}

runJobMain({
  args: parseArgs(process.argv),
  execute: executeZcode,
  label: "zcode/print",
  scriptPath: fileURLToPath(import.meta.url),
});
