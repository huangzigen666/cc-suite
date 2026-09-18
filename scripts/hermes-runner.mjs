#!/usr/bin/env node
// hermes-runner.mjs — Run Hermes Agent (local ACP-capable coding/agent CLI)
// tasks in foreground or background with job tracking. Mirrors the cache's
// codebuddy-runner.mjs (same ACP-client shape, same lib API) so
// /cc-suite:status, /result, /cancel, and /continue work identically across
// all backends.
//
// Usage:
//   node hermes-runner.mjs --kind <kind> --model <model> --effort <effort> \
//     --sandbox <sandbox> [--resume <sessionId>] [--timeout-ms <ms>] \
//     [--background] [--session-id <id>] [--summary <text>] -- <prompt>
//
// ─── How Hermes differs from the other lanes ──────────────────────────────
//
// Hermes ships an ACP server: the `hermes acp` subcommand ("Start Hermes Agent
// in ACP mode", a stdio server). The dedicated `hermes-acp` binary is the same
// server but does NOT accept `--accept-hooks`; the subcommand form does, so we
// spawn `hermes acp`. Like the CodeBuddy lane, this runner is the ACP *client*:
//
//   initialize → session/new (or session/load on resume) → session/prompt
//
// and accumulates `agent_message_chunk` text from the streamed `session/update`
// notifications as the answer. The session id ACP returns is stored as the
// job's threadId, so /cc-suite:continue resumes the same Hermes session.
//
// We always pass `--accept-hooks` so Hermes auto-approves its own unseen shell
// hooks instead of blocking on a TTY prompt in this non-interactive context.
// Model selection is left to Hermes' own configuration (the ACP `session/new`
// has no standard model parameter), so `--model` is accepted but not forwarded.
//
// Sandbox mapping (cc-suite vocabulary → client-side ACP enforcement):
//   read-only          → the client REJECTS fs write requests and denies
//                        permission requests. Hermes reads and reasons.
//   workspace-write    → the client serves fs read/write and approves
//                        permission requests, so Hermes can write.
//   danger-full-access → the client approves everything (same file-I/O
//                        posture as workspace-write).

import fs from "node:fs";
import path from "node:path";
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
// ACP defines protocolVersion as a number, not a string; strict agents reject
// a string "1" at initialize. Verified live against `codebuddy --acp`; the
// integer 1 is the ACP-spec value all compliant servers accept.
const ACP_PROTOCOL_VERSION = 1;
// After session/prompt resolves, agent_message_chunk notifications can still be
// in flight; drain until the answer is quiet before killing the child.
const ANSWER_QUIET_MS = 500;
const ANSWER_DRAIN_MAX_MS = 5000;

function parseArgs(argv) {
  const args = {
    kind: "hermes",
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

// Build the `hermes acp` argv. The `acp` subcommand IS the ACP stdio server;
// we add --accept-hooks to avoid TTY hook-prompt hangs. Model is left to
// Hermes' own config (no standard ACP model parameter), so --model is not
// forwarded.
function buildHermesArgs(args) {
  const a = ["acp", "--accept-hooks"];
  return a;
}

// Drive `hermes-acp` as an ACP client. Resolves with
// { status, rawOutput, sessionId, errorMessage }.
function executeHermes(cwd, args, logFile) {
  return new Promise((resolve) => {
    const alwaysApprove = args.sandbox !== "read-only";
    const hermesArgs = buildHermesArgs(args);

    appendLog(logFile, `Exec: hermes ${hermesArgs.join(" ")} (ACP client driving)`);
    appendLog(logFile, `Model: ${args.model || "(hermes default)"}, Effort: ${args.effort || "(default)"}, Sandbox: ${args.sandbox}${args.resume ? ` (resuming ${args.resume})` : ""}`);
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const child = spawn("hermes", hermesArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"], // stdin: JSON-RPC out, stdout: JSON-RPC in
      env: { ...process.env },
    });

    const startedAt = Date.now();
    const pending = new Map();
    let nextId = 1;
    let buf = "";
    let stderrTail = "";
    const answer = [];
    let toolCalls = 0;
    let settled = false;
    let timedOut = false;
    let acpSessionId = args.resume || null;
    let resumeFellBack = false; // resume requested, but session/load failed and a fresh session was started
    let lastChunkAt = 0;
    let childClosed = false;
    let phase = "spawn"; // spawn → session → prompt → done

    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* child gone */ } };
    const rpc = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ jsonrpc: "2.0", id, method, params });
    });
    const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
    const respondErr = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32601, message } });

    const heartbeat = setInterval(() => {
      appendLog(logFile, `…still running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed, ${toolCalls} tool call(s))`);
    }, HEARTBEAT_MS);

    const deadline = setTimeout(() => {
      timedOut = true;
      appendLog(logFile, `Deadline exceeded (${Math.round(args.timeoutMs / 1000)}s) — cancelling and terminating`);
      if (acpSessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: acpSessionId } });
      child.kill("SIGTERM");
      setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, SIGKILL_GRACE_MS);
    }, args.timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(deadline);
      try { child.kill(); } catch { /* already dead */ }
      // When a resume was requested, report explicitly whether it held; a
      // silent fresh-session fallback must not masquerade as continuation.
      resolve(args.resume ? { ...result, resumed: !resumeFellBack } : result);
    }

    // session/prompt resolving does not mean the streamed answer has fully
    // arrived — wait until no new chunk lands for ANSWER_QUIET_MS (bounded).
    async function drainAnswer() {
      const hardStop = Date.now() + ANSWER_DRAIN_MAX_MS;
      for (;;) {
        if (childClosed) return; // the stream is closed; no chunk can follow
        const reference = Math.max(lastChunkAt, startedAt);
        if (Date.now() - reference >= ANSWER_QUIET_MS) return;
        if (Date.now() >= hardStop) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // ── ACP message dispatch (newline-delimited JSON-RPC) ────────────────────
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; } // skip non-JSON banner lines
        if (process.env.HERMES_ACP_DEBUG) appendLog(logFile, `<< ${m.method ? `notif/req ${m.method}${m.id !== undefined ? ` id=${m.id}` : ""}` : `resp id=${m.id}`}`);
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id);
          m.error ? p.rej(m.error) : p.res(m.result);
        } else if (m.method && m.id !== undefined) {
          handleAgentRequest(m);
        } else if (m.method) {
          handleNotification(m);
        }
      }
    });

    function handleNotification(m) {
      if (m.method !== "session/update") return;
      const u = m.params?.update || {};
      if (u.sessionUpdate === "agent_message_chunk") {
        answer.push(u.content?.text ?? "");
        lastChunkAt = Date.now();
      } else if (u.sessionUpdate === "tool_call") { toolCalls++; appendLog(logFile, `tool_call: ${u.title || u.tool || u.toolCallId || "?"}`); }
    }

    // Resolve an ACP-supplied path against the session cwd, canonicalize it,
    // and — except under danger-full-access — refuse anything that escapes the
    // workspace. Returns the resolved path, or null when containment fails.
    let workspaceRoot = cwd;
    try { workspaceRoot = fs.realpathSync.native(cwd); } catch { /* keep cwd */ }
    function resolveClientPath(rawPath, forWrite) {
      const resolved = path.resolve(cwd, String(rawPath ?? ""));
      if (args.sandbox === "danger-full-access") return resolved;
      let canonical = resolved;
      try {
        canonical = forWrite
          ? path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved))
          : fs.realpathSync.native(resolved);
      } catch { /* target missing — containment-check the literal resolved path */ }
      const rel = path.relative(workspaceRoot, canonical);
      const inside = rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
      return inside ? resolved : null;
    }

    // Hermes advertises delegateToolsSupport, so it can call back to the
    // client for permissions and file I/O. Honor the sandbox here.
    function handleAgentRequest(m) {
      if (m.method === "session/request_permission") {
        const opts = m.params?.options || [];
        const want = alwaysApprove ? /allow|approve|yes/i : /reject|deny|no/i;
        const pick = opts.find((o) => want.test(o.optionId || o.kind || o.name || ""));
        if (!pick && !alwaysApprove) {
          // read-only: no reject-labelled option found — never select an
          // arbitrary fallback that could approve the operation.
          respond(m.id, { outcome: { outcome: "cancelled" } });
          return;
        }
        respond(m.id, { outcome: { outcome: "selected", optionId: (pick || opts[0])?.optionId } });
      } else if (m.method === "fs/read_text_file") {
        const target = resolveClientPath(m.params?.path, false);
        if (!target) { respondErr(m.id, `path outside workspace: ${m.params?.path}`); return; }
        try { respond(m.id, { content: fs.readFileSync(target, "utf8") }); }
        catch (e) { respondErr(m.id, String(e)); }
      } else if (m.method === "fs/write_text_file") {
        if (!alwaysApprove) { respondErr(m.id, "read-only: write denied"); return; }
        const target = resolveClientPath(m.params?.path, true);
        if (!target) { respondErr(m.id, `path outside workspace: ${m.params?.path}`); return; }
        try { fs.writeFileSync(target, m.params.content ?? ""); respond(m.id, {}); }
        catch (e) { respondErr(m.id, String(e)); }
      } else {
        respondErr(m.id, `unsupported client method: ${m.method}`);
      }
    }

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      fs.appendFileSync(logFile, text, "utf8");
    });

    child.on("error", (err) => {
      const hint = err.code === "ENOENT"
        ? "hermes not found on PATH — install Hermes Agent (the `hermes` CLI / `hermes acp` subcommand) and ensure it is on PATH"
        : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({ status: "failed", errorMessage: hint, sessionId: null, rawOutput: "" });
    });

    child.on("close", (code, signal) => {
      childClosed = true;
      if (settled) return;
      const rawOutput = answer.join("").trim();
      if (timedOut) {
        finish({ status: "stalled", errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`, sessionId: acpSessionId, rawOutput });
      } else if (phase === "done") {
        // The prompt already returned. Its stopReason is the authoritative
        // verdict and the awaiting flow is guaranteed to settle, so exiting
        // promptly after a turn is normal shutdown — not a completion.
        return;
      } else if (code !== 0) {
        const msg = code === null ? `signal ${signal}` : `exit ${code}`;
        finish({ status: "failed", errorMessage: stderrTail.trim() || msg, sessionId: acpSessionId, rawOutput });
      } else {
        // Exit 0 before the prompt returned is an incomplete protocol run, not
        // a success — the answer never arrived. Without this branch a clean exit
        // races the stopReason verdict and reports "completed" for cancelled and
        // refused turns too.
        finish({
          status: "failed",
          errorMessage: `hermes exited during ${phase} without returning a prompt result`,
          sessionId: acpSessionId,
          rawOutput,
        });
      }
    });

    // ── ACP conversation ─────────────────────────────────────────────────────
    (async () => {
      try {
        const init = await rpc("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });

        // ACP authentication is lazy: an agent that is already logged in serves
        // session/new directly. Only authenticate when a session is actually
        // refused for auth reasons.
        const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
        const authRequired = (error) => {
          const code = error?.code;
          if (code === -32000 || code === 401) return true;
          return /auth|unauthor|credential|login|api[_ -]?key/i.test(
            String(error?.message ?? "")
          );
        };
        const newSession = () => rpc("session/new", { cwd, mcpServers: [] });
        const newSessionWithAuth = async () => {
          try {
            return await newSession();
          } catch (error) {
            if (authMethods.length === 0 || !authRequired(error)) throw error;
            const ids = authMethods.map((method) => method?.id).filter(Boolean);
            // Only methods that complete without human interaction. Falling
            // back to an arbitrary advertised method can start a browser OAuth
            // flow that blocks headlessly until the deadline.
            const methodId =
              (ids.includes("cached_token") ? "cached_token" : null) ??
              ids.find((id) => /^(api[_-]?key|token|cached)/i.test(String(id))) ??
              null;
            if (!methodId) {
              throw new Error(
                `hermes requires authentication and advertised no non-interactive method (${ids.join(", ") || "none"}) — run 'hermes acp --setup' or 'hermes login'`
              );
            }
            await rpc("authenticate", { methodId });
            appendLog(logFile, `Authenticated via ${methodId}`);
            return newSession();
          }
        };

        // Resume with session/load when a prior session id is given; fall back to
        // a fresh session if this build doesn't support load.
        phase = "session";
        if (args.resume) {
          try {
            await rpc("session/load", { sessionId: args.resume, cwd, mcpServers: [] });
            acpSessionId = args.resume;
            appendLog(logFile, `Resumed session ${args.resume}`);
          } catch {
            resumeFellBack = true;
            appendLog(logFile, `session/load unsupported or failed — starting a fresh session`);
            const s = await newSessionWithAuth();
            acpSessionId = s?.sessionId || null;
          }
        } else {
          const s = await newSessionWithAuth();
          acpSessionId = s?.sessionId || null;
        }

        if (!acpSessionId) {
          finish({ status: "failed", errorMessage: "no sessionId returned by hermes", sessionId: null, rawOutput: "" });
          return;
        }
        appendLog(logFile, `Session: ${acpSessionId}`);

        // session/load replays the prior conversation as session/update
        // notifications; discard that history so rawOutput is only this turn's
        // answer.
        answer.length = 0;
        toolCalls = 0;
        lastChunkAt = 0;

        // Hermes reads AGENTS.md and the shared .agents/skills tree natively,
        // so it can see cc-suite's Claude-facing skills too. Refuse the hand-back
        // in the prompt. See lib/delegation-boundary.mjs.
        phase = "prompt";
        const result = await rpc("session/prompt", {
          sessionId: acpSessionId,
          prompt: [{ type: "text", text: withDelegationBoundary(args.prompt) }],
        });
        phase = "done";

        if (timedOut) return; // the deadline path (close handler) finishes as stalled
        // Streamed chunks can trail the prompt response — drain before killing.
        await drainAnswer();
        if (timedOut || settled) return;
        const rawOutput = answer.join("").trim();
        const stop = result?.stopReason;
        appendLog(logFile, `Prompt returned (stopReason=${stop || "?"}, ${toolCalls} tool call(s))`);
        // A cancelled/refused turn is not a successful completion. The client
        // (this runner) denying a permission request is a policy decision, not a
        // hang — reporting `stalled` would conflate it with the deadline.
        if (stop === "cancelled" || stop === "canceled") {
          finish({ status: "blocked", errorMessage: `hermes stopReason=${stop}`, sessionId: acpSessionId, rawOutput });
        } else if (stop === "refusal") {
          finish({ status: "failed", errorMessage: "hermes refused the request (stopReason=refusal)", sessionId: acpSessionId, rawOutput });
        } else if (stop === "max_tokens" || stop === "max_turn_requests") {
          finish({ status: "failed", errorMessage: `hermes stopped at a limit (stopReason=${stop}) — the answer may be truncated`, sessionId: acpSessionId, rawOutput });
        } else {
          finish({ status: "completed", sessionId: acpSessionId, rawOutput });
        }
      } catch (e) {
        if (timedOut || settled) return;
        finish({
          status: "failed",
          errorMessage: typeof e === "object" && e?.message ? e.message : JSON.stringify(e),
          sessionId: acpSessionId,
          rawOutput: answer.join("").trim(),
        });
      }
    })();
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
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=hermes/ACP)`);

  const result = await executeHermes(cwd, args, logFile);

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
  appendLog(logFile, `Queued ${args.kind} task (background, backend=hermes/ACP)`);

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
  appendLog(logFile, "Background worker started (backend=hermes/ACP)");

  const result = await executeHermes(cwd, args, logFile);

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
