#!/usr/bin/env node
// mimo-runner.mjs — Run Xiaomi MiMo Code (`mimo`, an opencode-family coding
// agent) tasks in foreground or background with job tracking. The job
// lifecycle lives in lib/job-runner.mjs and the process handling in
// lib/runner-lifecycle.mjs; this file owns only the MiMo transport.
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
//                        local read/search tools; denied tools are removed from
//                        the agent's tool set (verified: no write, edit, or
//                        bash). webfetch/websearch/codesearch are denied too, so
//                        a read-only review cannot send workspace content to an
//                        arbitrary URL. That narrows exfiltration; it does not
//                        stop it — the model request itself carries source.
//                        Research that needs the network: use workspace-write.
//   workspace-write    → MiMo defaults, plus external_directory denied. Bash
//                        stays allowed, so this is best-effort, not a jail.
//   danger-full-access → --dangerously-skip-permissions.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withDelegationBoundary } from "./lib/delegation-boundary.mjs";
import { appendLog, runJobMain } from "./lib/job-runner.mjs";
import {
  createLineReader,
  createTextDecoder,
  guard,
  spawnBackend,
  superviseBackend,
} from "./lib/runner-lifecycle.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — matches the other runners
const HEARTBEAT_MS = 30 * 1000;
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

    const { child, release } = spawnBackend(bin, mArgs, { cwd, env });

    const startedAt = Date.now();
    let stderrTail = "";
    const texts = [];
    const errors = [];
    let sessionId = args.resume || null;
    let settled = false;
    let timedOut = false;
    let heartbeat = null;

    const answer = () => texts.join("\n\n").trim();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      supervisor.dispose();
      resolve(result);
    }

    function fail(error) {
      finish({ status: "failed", errorMessage: `Runner callback failed: ${error?.message || error}`, sessionId, rawOutput: answer() });
    }

    const supervisor = superviseBackend(child, {
      timeoutMs: args.timeoutMs,
      release,
      onError: fail,
      onDeadline: () => {
        timedOut = true;
        appendLog(logFile, `Deadline exceeded (${Math.round(args.timeoutMs / 1000)}s) — terminating the process tree`);
      },
      onDrain: () => appendLog(logFile, "mimo exited but its output pipes stayed open — terminating leftover processes"),
    });

    heartbeat = setInterval(guard(() => {
      appendLog(logFile, `…still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`);
    }, fail), HEARTBEAT_MS);

    const lines = createLineReader((line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.sessionID) sessionId = m.sessionID;
      if (m.type === "text" && m.part && typeof m.part.text === "string") {
        texts.push(m.part.text);
      } else if (m.type === "error") {
        const e = m.error || {};
        errors.push((e.data && e.data.message) || e.message || e.name || "unknown error");
      }
    });
    const stderrText = createTextDecoder();

    child.stdout.on("data", guard((chunk) => lines.write(chunk), fail));

    child.stderr.on("data", guard((chunk) => {
      const text = stderrText.write(chunk);
      stderrTail = (stderrTail + text).slice(-3000);
      fs.appendFileSync(logFile, text, "utf8");
    }, fail));

    child.on("error", guard((err) => {
      const hint = err.code === "ENOENT"
        ? "mimo not found on PATH — install MiMo Code (~/.mimocode/bin/mimo) or set MIMO_BIN"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    }, fail));

    child.on("close", guard((code, signal) => {
      if (settled) return;
      lines.end();
      const msg = code === null ? `signal ${signal}` : `exit ${code}`;

      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId, rawOutput: answer() });
        return;
      }
      if (errors.length > 0) {
        // mimo exits 0 after an error event; the event is authoritative.
        finish({ status: "failed", errorMessage: `mimo: ${errors[errors.length - 1]}`, sessionId, rawOutput: answer() });
        return;
      }
      if (code !== 0) {
        finish({ status: "failed", errorMessage: stderrTail.trim() || `mimo ${msg}`, sessionId, rawOutput: answer() });
        return;
      }
      if (!answer()) {
        finish({ status: "failed", errorMessage: "mimo exited cleanly but produced no answer", sessionId, rawOutput: "" });
        return;
      }
      finish({ status: "completed", sessionId, rawOutput: answer() });
    }, fail));
  });
}

runJobMain({
  args: parseArgs(process.argv),
  execute: executeMimo,
  label: "mimo/run",
  scriptPath: fileURLToPath(import.meta.url),
});
