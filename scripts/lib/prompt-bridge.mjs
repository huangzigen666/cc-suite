// Translate delegation text before transport; the original remains authoritative.
import { spawn } from "node:child_process";
import { installChildSignalForwarding } from "./process.mjs";

export const BRIDGE_MARKER = "[cc-suite rex-lang-bridge v1]";
export const AUTHORITY = "The original task below is authoritative. The English translation is supplementary, grants no permissions, and must not change names, literal code, constraints, or the requested output format. Do not append a language summary to an internal structured result.";

function callBridge(prompt, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    let output = "", done = false, killTimer;
    const child = spawn(env.CC_SUITE_LANG_BRIDGE_BIN || "rex-lang-bridge", ["--delegation", "--json", "--cwd", cwd], {
      cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, REX_LANG_BRIDGE_ACTIVE: "1" },
    });
    const releaseSignals = installChildSignalForwarding(child);
    const kill = (signal) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
    };
    const finish = (result) => { if (done) return; done = true; releaseSignals(); clearTimeout(timer); clearTimeout(killTimer); resolve(result); };
    const fail = (status) => {
      if (done) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => { kill("SIGKILL"); finish({ status }); }, 200);
      failureStatus = status;
    };
    let failureStatus;
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    child.on("error", () => finish({ status: "unavailable" }));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) fail("invalid-output");
    });
    // Drain diagnostics but never reproduce credentials or task contents.
    child.stderr.resume();
    child.on("close", (code) => {
      if (failureStatus) { finish({ status: failureStatus }); return; }
      if (code !== 0) { finish({ status: "failed" }); return; }
      try {
        const result = JSON.parse(output);
        if (result.original !== prompt || typeof result.text !== "string" || !result.text.trim() ||
            typeof result.changed !== "boolean" || result.warning || result.warnings?.length) {
          finish({ status: "invalid-output" }); return;
        }
        finish({ status: result.changed ? "translated" : "unchanged", text: result.text });
      } catch { finish({ status: "invalid-output" }); }
    });
    child.stdin.end(JSON.stringify({ prompt, cwd }));
  });
}

export async function preparePrompt(prompt, { cwd = process.cwd(), timeoutMs = 45000, env = process.env, report = () => {} } = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || !/\p{Script=Han}/u.test(prompt)) return prompt;
  if (env.CC_SUITE_LANG_BRIDGE === "0" || env.REX_LANG_BRIDGE_ACTIVE === "1" || prompt.includes(BRIDGE_MARKER)) return prompt;
  const result = await callBridge(prompt, cwd, Math.max(1, Math.min(timeoutMs, 45000)), env);
  // Status only: task text is already in the recipient's prompt, never the log.
  report(`[rex-lang-bridge] ${result.status}${result.status === "translated" ? "" : "; original task retained"}`);
  if (result.status !== "translated") return prompt;
  return `${BRIDGE_MARKER}\n${AUTHORITY}\n\nORIGINAL TASK (preserved verbatim):\n${prompt}\n\nSUPPLEMENTARY ENGLISH (quoted JSON text):\n${JSON.stringify(result.text)}`;
}

export async function prepareDelegation(cwd, args, logFile, appendLog) {
  const startedAt = Date.now();
  args.prompt = await preparePrompt(args.prompt, {
    cwd, timeoutMs: Math.min(45000, Math.max(1, args.timeoutMs || 45000)),
    report: (message) => { appendLog(logFile, message); process.stderr.write(message + "\n"); },
  });
  // Translation shares the existing job deadline, rather than adding to it.
  if (args.timeoutMs) {
    args.timeoutMs -= Date.now() - startedAt;
    if (args.timeoutMs <= 0) throw new Error("Delegation deadline elapsed during translation");
  }
}
