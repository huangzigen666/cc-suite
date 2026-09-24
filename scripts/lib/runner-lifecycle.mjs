// runner-lifecycle.mjs — Process and stream plumbing shared by the backend
// runners. Each runner keeps its own protocol parsing and result rules; this
// module owns the parts that were copied per runner and drifted:
//
//   - spawnBackend: the backend leads its own process group, so a deadline or
//     cancel can reach tool subprocesses too, and signals sent to the runner
//     are forwarded to that group.
//   - killBackendTree: synchronous SIGTERM → wait for every live group member →
//     SIGKILL. Synchronous on purpose: an escalation timer would be cleared by
//     the runner's finish() and leave a SIGTERM-resistant descendant running.
//   - superviseBackend: the deadline, plus a drain window after the direct
//     child exits. A descendant that inherited stdout/stderr keeps the pipes
//     open, so `close` may never fire; after the window the group is killed and
//     the pipes destroyed, which lets `close` fire and the runner settle.
//   - guard: timer and stream callbacks run outside any Promise chain, so a
//     throw there (a log write hitting ENOSPC) would kill the runner and leave
//     the job recorded as running. Guarded callbacks report the error instead.
//   - createLineReader / createTextDecoder: stdout arrives in chunks that can
//     split a multi-byte UTF-8 character; decoding chunk by chunk turns it into
//     U+FFFD. StringDecoder carries the partial bytes across chunks.

import { spawn } from "node:child_process";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

import {
  readProcessStartTime,
  runCommand,
  sleepSync,
} from "./process.mjs";

export const KILL_GRACE_MS = 1000;
export const EXIT_DRAIN_MS = 2000;
const POLL_MS = 50;

// Identity fields for a job's running record. Without pidStartedAt,
// job-control treats the pid as unverifiable and /cancel will not signal it.
export function runnerIdentity() {
  return { pid: process.pid, pidStartedAt: readProcessStartTime(process.pid) };
}

// `killTree` is the kill the signal-forwarding handler uses; tests inject a
// recorder to prove the handler stops killing once dispose() retired it (a
// reused pgid cannot be produced on demand, so the call itself is observed).
export function spawnBackend(command, args, { cwd, env, stdin = "ignore", killTree = killBackendTree } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: [stdin, "pipe", "pipe"],
    detached: true,
  });
  const { release, retire } = forwardSignalsToTree(child, killTree);
  retirers.set(child, retire);
  return { child, release };
}

// child → retire(): called by dispose() once the tree is dead, so a later
// signal only re-raises instead of signalling a pgid the OS may have reused.
const retirers = new WeakMap();

// Like process.mjs's installChildSignalForwarding, but the forwarded kill
// escalates to SIGKILL: /cancel sends the runner SIGTERM, and a backend that
// ignores SIGTERM must not outlive it. killBackendTree takes KILL_GRACE_MS plus
// its `ps` polls, well inside job-control's 3000ms TERM_CONFIRM_MS, so the
// runner has cleaned up before cancel would escalate on the runner itself.
function forwardSignalsToTree(child, killTree, signals = ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handlers = new Map();
  let retired = false;
  const release = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of signals) {
    const handler = () => {
      if (!retired) {
        try { killTree(child.pid); } catch { /* nothing left to kill */ }
      }
      release();
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return { release, retire: () => { retired = true; } };
}

// Pids in process group `pgid` that have not exited. Zombies are excluded: they
// are already dead, and an unreaped one would otherwise look alive until the
// event loop runs again. Returns null when `ps` is unavailable.
export function livingGroupMembers(pgid) {
  const result = runCommand("ps", ["-A", "-o", "pid=,pgid=,stat="], {
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0 || result.signal || result.error) return null;
  const members = [];
  for (const line of result.stdout.split("\n")) {
    const [pid, group, stat] = line.trim().split(/\s+/);
    if (Number(group) === pgid && stat && !stat.startsWith("Z")) members.push(Number(pid));
  }
  return members;
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    try { process.kill(pgid, signal); } catch { /* gone */ }
  }
}

// Terminate the backend's whole process group. Returns the pids still alive
// afterwards: [] when the group is verified gone, null when `ps` could not be
// run to verify it (a sandbox that also blocks signals leaves the tree alive,
// and reporting [] there would claim a kill that never happened).
export function killBackendTree(pid, { graceMs = KILL_GRACE_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return [];
  let members = livingGroupMembers(pid);
  if (members && members.length === 0) return [];
  signalGroup(pid, "SIGTERM");
  const stopAt = Date.now() + graceMs;
  while (Date.now() < stopAt) {
    sleepSync(POLL_MS);
    members = livingGroupMembers(pid);
    if (members && members.length === 0) return [];
  }
  signalGroup(pid, "SIGKILL");
  sleepSync(POLL_MS);
  return livingGroupMembers(pid);
}

export function guard(fn, onError) {
  return (...callbackArgs) => {
    try {
      return fn(...callbackArgs);
    } catch (error) {
      onError(error);
      return undefined;
    }
  };
}

// Arm the deadline and the post-exit drain for `child`. `onDeadline` runs first
// (mark the run timed out, send a protocol-level cancel), then the tree is
// killed and the pipes destroyed. `onError` receives a throw from any of these
// callbacks. Call dispose() exactly when the runner settles: it clears the
// timers, releases signal forwarding, and kills whatever is left of the group.
export function superviseBackend(child, {
  timeoutMs,
  release,
  onDeadline = () => {},
  onDrain = () => {},
  onError,
  drainMs = EXIT_DRAIN_MS,
}) {
  let disposed = false;
  let drainTimer = null;

  const forceClose = () => {
    killBackendTree(child.pid);
    for (const stream of [child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch { /* already closed */ }
    }
  };

  const deadlineTimer = setTimeout(guard(() => {
    if (disposed) return;
    onDeadline();
    forceClose();
  }, onError), timeoutMs);

  child.on("exit", () => {
    if (disposed) return;
    // The backend finished; only the pipes remain. The drain window bounds
    // that wait, and a deadline landing inside it would mislabel a completed
    // run as stalled.
    clearTimeout(deadlineTimer);
    drainTimer = setTimeout(guard(() => {
      if (disposed) return;
      onDrain();
      forceClose();
    }, onError), drainMs);
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadlineTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // The forwarding listeners stay installed. A SIGTERM that arrives during
      // the synchronous kill below is queued for the event loop; removing the
      // listeners before it is dispatched either let the default action end
      // the runner mid-kill (backend left alive) or dropped the signal (runner
      // never exits). Leaving them is safe: each handler removes itself and
      // re-raises, so it never suppresses termination, and signal listeners do
      // not keep the process alive. Retiring them afterwards stops a late
      // signal from killing a pgid the OS has since reused.
      //
      // forceClose, not just the kill: a descendant that left the group
      // (setsid) can still hold stdout, and on the error path nothing else
      // destroys the pipes, so the open handle would keep the runner alive.
      forceClose();
      retirers.get(child)?.();
    },
  };
}

// Split a byte stream into lines, decoding UTF-8 across chunk boundaries.
// Blank lines are skipped and a trailing \r is stripped.
export function createLineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  const drain = () => {
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
  return {
    write(chunk) {
      buf += decoder.write(chunk);
      drain();
    },
    end() {
      buf += decoder.end();
      drain();
      const rest = buf.trim();
      buf = "";
      if (rest) onLine(rest);
    },
  };
}

export function createTextDecoder() {
  const decoder = new StringDecoder("utf8");
  return {
    write: (chunk) => decoder.write(chunk),
    end: () => decoder.end(),
  };
}

// What a runner reports after finalizeJob. A refused commit means the job was
// cancelled (or its record removed) while the backend ran; the runner then
// reports that status and discards the result, so its output, the state file,
// and the result file agree.
export function finalizedOutcome(finalized, result) {
  if (finalized.committed && finalized.resultFileError) {
    return {
      status: "failed",
      errorMessage: `result file could not be written: ${finalized.resultFileError}`,
      rawOutput: "",
    };
  }
  if (finalized.committed) {
    return { status: result.status, errorMessage: result.errorMessage, rawOutput: result.rawOutput || "" };
  }
  if (finalized.status) {
    return {
      status: finalized.status,
      errorMessage: `job was ${finalized.status} while the backend ran; its result was discarded`,
      rawOutput: "",
    };
  }
  return {
    status: "failed",
    errorMessage: "job record disappeared before the result could be recorded; its result was discarded",
    rawOutput: "",
  };
}
