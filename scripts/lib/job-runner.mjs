// job-runner.mjs — Job lifecycle for the print-mode and ACP runners (qoder,
// zcode, doubao, mimo, codebuddy, hermes). Each runner supplies only its
// execute(cwd, args, logFile) function; this module owns how that execution
// becomes a tracked job:
//
//   - the log file is created 0600 (createJobLogFile), not left to umask;
//   - running records carry pid + pidStartedAt, so /cancel and SessionEnd can
//     verify and signal the process instead of reporting it unverifiable;
//   - a background worker claims its queued job atomically, so a job cancelled
//     before the worker started stays cancelled;
//   - the terminal state and result file are committed together and never over
//     a cancellation that landed while the backend ran (finalizeJob);
//   - a crash in main() finalizes the job it had registered instead of leaving
//     it recorded as running.
//
// execute() resolves { status, rawOutput, sessionId, errorMessage, resumed? }.

import fs from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";

import {
  claimJob,
  createJobLogFile,
  finalizeJob,
  generateJobId,
  upsertJob,
} from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { finalizedOutcome, runnerIdentity } from "./runner-lifecycle.mjs";

// Job id this process registered but has not finalized or handed to a
// detached worker; the crash handler fails it.
let activeJobId = null;

export function appendLog(logFile, message) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function commitResult(cwd, jobId, result) {
  const resumed = typeof result.resumed === "boolean" ? { resumed: result.resumed } : {};
  const finalized = finalizeJob(
    cwd,
    jobId,
    {
      status: result.status,
      threadId: result.sessionId || null,
      completedAt: new Date().toISOString(),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    },
    {
      rawOutput: result.rawOutput || "",
      threadId: result.sessionId || null,
      ...resumed,
      ...(result.errorMessage ? { error: result.errorMessage } : {}),
    }
  );
  const outcome = finalizedOutcome(finalized, result);
  return {
    jobId,
    status: outcome.status,
    threadId: result.sessionId || null,
    rawOutput: outcome.rawOutput,
    ...resumed,
    ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
  };
}

async function runForeground(cwd, args, spec) {
  const jobId = generateJobId(args.kind);
  activeJobId = jobId;
  const logFile = createJobLogFile(cwd, jobId);
  const sessionId = args.sessionId || process.env.CODEX_TOOLKIT_SESSION_ID || null;

  upsertJob(cwd, {
    id: jobId, kind: args.kind, status: "running",
    summary: args.summary || `${args.kind} task`,
    sessionId, ...runnerIdentity(),
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
    logFile,
  });
  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=${spec.label})`);

  const result = await spec.execute(cwd, args, logFile);
  const output = commitResult(cwd, jobId, result);
  activeJobId = null;
  process.stdout.write(JSON.stringify(output) + "\n");
  if (output.status !== "completed") process.exitCode = 1;
}

function runBackground(cwd, args, spec) {
  const jobId = generateJobId(args.kind);
  activeJobId = jobId;
  const logFile = createJobLogFile(cwd, jobId);
  const sessionId = args.sessionId || process.env.CODEX_TOOLKIT_SESSION_ID || null;

  upsertJob(cwd, {
    id: jobId, kind: args.kind, status: "queued",
    summary: args.summary || `${args.kind} task`, sessionId, logFile,
  });
  appendLog(logFile, `Queued ${args.kind} task (background, backend=${spec.label})`);

  const childArgv = [
    spec.scriptPath,
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

  // The worker records the running transition itself (with its own pid), so a
  // fast worker completion can never be overwritten with `running` here.
  child.on("error", (err) => {
    appendLog(logFile, `Background spawn error: ${err.message}`);
    finalizeJob(cwd, jobId, {
      status: "failed",
      errorMessage: `Failed to start background worker: ${err.message}`,
      completedAt: new Date().toISOString(),
    });
  });
  child.unref();
  activeJobId = null; // the job now belongs to the detached worker

  process.stdout.write(JSON.stringify({ jobId, status: "queued", message: `Job ${jobId} started in background.` }) + "\n");
}

async function runBackgroundWorker(cwd, args, jobId, spec) {
  const logFile = createJobLogFile(cwd, jobId);
  const claimed = claimJob(cwd, jobId, {
    status: "running", ...runnerIdentity(),
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
  });
  if (!claimed) {
    appendLog(logFile, "Background worker exiting — job was cancelled before startup");
    return;
  }
  appendLog(logFile, `Background worker started (backend=${spec.label})`);

  const result = await spec.execute(cwd, args, logFile);
  commitResult(cwd, jobId, result);
}

// Entry point. spec: { args, execute, label, scriptPath }.
export function runJobMain(spec) {
  const main = async () => {
    const { args } = spec;
    if (!args.prompt) {
      process.stderr.write("Error: no prompt provided. Use -- <prompt>\n");
      process.exit(1);
    }
    const cwd = resolveWorkspaceRoot(process.cwd());
    const backgroundJobId = process.env.CODEX_TOOLKIT_BACKGROUND_JOB_ID;
    if (backgroundJobId) {
      await runBackgroundWorker(cwd, args, backgroundJobId, spec);
      return;
    }
    if (args.background) runBackground(cwd, args, spec);
    else await runForeground(cwd, args, spec);
  };

  main().catch((error) => {
    const message = error?.message || String(error);
    const jobId = process.env.CODEX_TOOLKIT_BACKGROUND_JOB_ID || activeJobId || null;
    let status = "failed";
    if (jobId) {
      try {
        const finalized = finalizeJob(resolveWorkspaceRoot(process.cwd()), jobId, {
          status: "failed",
          errorMessage: message,
          completedAt: new Date().toISOString(),
        });
        // A job cancelled before the crash stays cancelled; report that, not
        // a failure the state file does not hold.
        if (!finalized.committed && finalized.status) status = finalized.status;
      } catch {
        // State unreachable — the structured output below is the only signal.
      }
    }
    process.stdout.write(JSON.stringify({ jobId, status, error: message }) + "\n");
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
