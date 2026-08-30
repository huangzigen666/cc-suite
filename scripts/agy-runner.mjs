#!/usr/bin/env node
// agy-runner.mjs — Run Antigravity CLI (`agy`) tasks in foreground or background
// with job tracking. Mirrors codex-runner.mjs so /cc-suite:status, /result and
// /cancel work identically across both backends.
//
// Usage:
//   node agy-runner.mjs --kind <kind> --project <projectId> --model <model> \
//     --sandbox workspace-write [--effort <effort>] [--timeout-ms <ms>] \
//     [--candidate-workspace-write | --candidate-external-workspace-write \
//       --oauth-volume <exact-name>] \
//     [--background] [--session-id <id>] [--summary <text>] \
//     -- <prompt>
//
// ─── How this differs from codex-runner, and why ─────────────────────────────
//
// agy 1.1.11 emits an NDJSON stream with authoritative init and result events.
// Conversation identity comes only from that stream; filesystem/SQLite guessing
// is deliberately forbidden. AGY inherits global permissions and can add
// Project grants, but R4 proved that an exact Project write grant did not confine
// a direct write to the Project resource. This adapter therefore rejects
// Project auto-approvals. R5 instead prepares a private ephemeral AGY runtime,
// requires a clean detached linked worktree, and launches the entire AGY process
// under macOS Seatbelt. Modes that cannot be enforced fail closed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
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
import { withConstitutionReminder } from "./lib/constitution-reminder.mjs";
import {
  assertAgyCustomizationSurface,
  assertAgyRuntimeToolBoundary,
  auditIsolatedCustomizationBoundary,
  auditExecutionBoundary,
  buildAgyArgs,
  consumeAgyEventLine,
  createAgyEventState,
  finalizeAgyEventState,
  isSameExecutionPath,
  makeAgyContractError,
} from "./lib/agy-contract.mjs";
import {
  assertDisposableWorktree,
  cleanupSeatbeltScratch,
  createSeatbeltLaunch,
  listWorkspaceChanges,
} from "./lib/agy-seatbelt.mjs";
import {
  completeAgyRunManifest,
  createAgyRunManifest,
  recordAgyProcess,
  recordAgyRunStage,
  scavengeAgyRuns,
} from "./lib/agy-recovery.mjs";
import {
  completeAgyR16RunManifest,
  createAgyR16RunManifest,
  recordAgyR16SessionProcess,
  recoverAgyR16OwnedRun,
  scavengeAgyR16Runs,
} from "./lib/agy-r16-recovery.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — matches codex-runner
const HEARTBEAT_MS = 30 * 1000;
const BOUNDARY_RECHECK_MS = 500;
const SIGKILL_GRACE_MS = 5 * 1000;
const RECOVERY_GRACE_MS = 1000;
const R16_MAX_RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024;

function maybeInjectTestCrash(point) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.CC_SUITE_AGY_TEST_CRASH_AT === point
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function maybeInjectR16RunnerTestCrash(point) {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.CC_SUITE_AGY_R16_RUNNER_TEST_CRASH_AT === point
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function parseArgs(argv) {
  const args = {
    kind: "agy",
    project: null,
    model: null,
    effort: null,
    sandbox: "read-only",
    mode: null,        // agy --mode: accept-edits | plan
    addDirs: [],
    resume: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    background: false,
    sessionId: null,
    summary: null,
    prompt: null,
    candidateWorkspaceWrite: false,
    candidateExternalWorkspaceWrite: false,
    releasedExternalWorkspaceWrite: false,
    oauthVolume: null,
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--kind" && argv[i + 1]) { args.kind = argv[++i]; }
    else if (arg === "--project" && argv[i + 1]) { args.project = argv[++i]; }
    else if (arg === "--model" && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === "--effort" && argv[i + 1]) { args.effort = argv[++i]; }
    else if (arg === "--sandbox" && argv[i + 1]) { args.sandbox = argv[++i]; }
    else if (arg === "--mode" && argv[i + 1]) { args.mode = argv[++i]; }
    else if (arg === "--add-dir" && argv[i + 1]) { args.addDirs.push(argv[++i]); }
    else if (arg === "--resume" && argv[i + 1]) { args.resume = argv[++i]; }
    else if (arg === "--timeout-ms" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.timeoutMs = n;
    }
    else if (arg === "--background") { args.background = true; }
    else if (arg === "--candidate-workspace-write") { args.candidateWorkspaceWrite = true; }
    else if (arg === "--candidate-external-workspace-write") {
      args.candidateExternalWorkspaceWrite = true;
    }
    else if (arg === "--external-workspace-write") {
      args.candidateExternalWorkspaceWrite = true;
      args.releasedExternalWorkspaceWrite = true;
    }
    else if (arg === "--oauth-volume" && argv[i + 1]) { args.oauthVolume = argv[++i]; }
    else if (arg === "--session-id" && argv[i + 1]) { args.sessionId = argv[++i]; }
    else if (arg === "--summary" && argv[i + 1]) { args.summary = argv[++i]; }
    else if (arg === "--") {
      args.prompt = argv.slice(i + 1).join(" ");
      break;
    }
    i++;
  }

  return args;
}

function appendLog(logFile, message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, "utf8");
}

function signalAgyProcessTree(child, signal, fallbackToChild = true) {
  if (process.platform !== "win32" && Number.isFinite(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH" && !fallbackToChild) throw error;
    }
  }
  if (!fallbackToChild) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function readJson(file, missingCode) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw makeAgyContractError(
      missingCode,
      `Cannot read required AGY boundary file ${file}: ${error.message}`
    );
  }
}

function assertExecutionBoundary(cwd, args, boundaryFiles) {
  if (!/^[a-zA-Z0-9_-]+$/.test(args.project || "")) {
    throw makeAgyContractError(
      "AGY_PROJECT_INVALID",
      "AGY project IDs may contain only letters, numbers, underscores, and hyphens"
    );
  }
  if (!boundaryFiles) {
    throw makeAgyContractError(
      "AGY_ISOLATED_BOUNDARY_MISSING",
      "The isolated AGY runtime boundary was not prepared"
    );
  }
  const projectConfig = readJson(
    boundaryFiles.projectFile,
    "AGY_PROJECT_NOT_FOUND"
  );
  if (projectConfig.id !== args.project) {
    throw makeAgyContractError(
      "AGY_PROJECT_ID_MISMATCH",
      `AGY project file identity does not match requested project '${args.project}'`
    );
  }
  const settings = readJson(
    boundaryFiles.settingsFile,
    "AGY_SETTINGS_UNAVAILABLE"
  );
  const sharedConfig = readJson(
    boundaryFiles.sharedConfigFile,
    "AGY_SHARED_CONFIG_UNAVAILABLE"
  );
  const mcpConfig = readJson(
    boundaryFiles.mcpConfigFile,
    "AGY_ISOLATED_MCP_CONFIG_UNAVAILABLE"
  );
  const pluginsConfig = readJson(
    boundaryFiles.pluginsConfigFile,
    "AGY_ISOLATED_PLUGINS_CONFIG_UNAVAILABLE"
  );
  const hooksConfig = readJson(
    boundaryFiles.hooksConfigFile,
    "AGY_ISOLATED_HOOKS_CONFIG_UNAVAILABLE"
  );
  const findings = [
    ...auditExecutionBoundary({
    cwd,
    projectConfig,
    settings,
    sharedConfig,
    }),
    ...auditIsolatedCustomizationBoundary({
      mcpConfig,
      pluginsConfig,
      hooksConfig,
      hooksConfigFile: boundaryFiles.hooksConfigFile,
      hooksConfigSource: boundaryFiles.hooksConfigSource,
      toolPolicyFile: boundaryFiles.toolPolicyFile,
      toolPolicySource: boundaryFiles.toolPolicySource,
      nodeExecutable: boundaryFiles.nodeExecutable,
    }),
  ];
  if (findings.length) {
    throw makeAgyContractError(
      "AGY_PERMISSION_BOUNDARY_UNSAFE",
      `AGY execution boundary failed: ${findings.join(", ")}`
    );
  }
}

// Run agy asynchronously, parse its authoritative stream-json protocol,
// heartbeat into the job log, and enforce a hard deadline by killing the child.
function executeAgySeatbelt(cwd, args, logFile, jobId) {
  return new Promise((resolve) => {
    let agyArgs;
    let seatbeltLaunch = null;
    let recoveryManifestPath = null;
    try {
      const prompt = withDelegationBoundary(withConstitutionReminder(args.prompt));
      assertDisposableWorktree(cwd);
      assertAgyCustomizationSurface(cwd);
      agyArgs = buildAgyArgs({
        ...args,
        prompt,
        seatbeltWorktreeVerified: true,
      });
      seatbeltLaunch = createSeatbeltLaunch({
        workspacePath: cwd,
        executable: "agy",
        argv: agyArgs,
        onScratchPrepared: (scratchDir) => {
          const recovery = createAgyRunManifest({
            cwd,
            jobId,
            scratchDir,
            logFile,
          });
          recoveryManifestPath = recovery.manifestPath;
          maybeInjectTestCrash("scratch-prepared");
        },
        agyRuntime: {
          projectId: args.project,
          projectName: `cc-suite isolated ${args.project}`,
        },
      });
      assertExecutionBoundary(
        cwd,
        args,
        seatbeltLaunch.isolatedRuntime?.boundaryFiles
      );
    } catch (error) {
      if (seatbeltLaunch?.scratchDir) {
        try {
          cleanupSeatbeltScratch(seatbeltLaunch.scratchDir);
        } catch (cleanupError) {
          appendLog(
            logFile,
            `Pre-spawn scratch cleanup failed [${cleanupError.code || "AGY_SEATBELT_CLEANUP_FAILED"}]: ${cleanupError.message}`
          );
        }
      }
      if (recoveryManifestPath) {
        try {
          completeAgyRunManifest(recoveryManifestPath);
        } catch (cleanupError) {
          appendLog(
            logFile,
            `Pre-spawn recovery manifest cleanup failed [${cleanupError.code || "AGY_RECOVERY_FAILED"}]: ${cleanupError.message}`
          );
        }
      }
      const errorCode = error.code || "AGY_CONTRACT_INVALID";
      appendLog(logFile, `Blocked before spawn [${errorCode}]: ${error.message}`);
      resolve({
        status: "failed",
        errorCode,
        errorMessage: error.message,
        conversationId: null,
        rawOutput: "",
        runtime: null,
        usage: null,
      });
      return;
    }

    appendLog(logFile, `Exec: agy ${agyArgs.slice(0, -1).join(" ")} <prompt>`);
    appendLog(
      logFile,
      `OS boundary: macOS Seatbelt (workspace=${seatbeltLaunch.workspace}, scratch=${seatbeltLaunch.scratchDir})`
    );
    appendLog(
      logFile,
      `Project: ${args.project}, Model: ${args.model || "(default)"}, Access mode: ${args.sandbox}`
    );
    if (args.effort) {
      appendLog(logFile, `Requested effort: ${args.effort} (omitted when already encoded by the model slug)`);
    }
    appendLog(logFile, `Deadline: ${Math.round(args.timeoutMs / 1000)}s`);

    const startedAt = Date.now();
    let stdoutBuf = "";
    let stderrTail = "";
    const eventState = createAgyEventState();
    let protocolError = null;
    let boundaryError = null;
    let runtimeBoundaryChecked = false;
    let settled = false;
    let timedOut = false;
    let cancellationSignal = null;
    let forceKillTimer = null;
    let recoveryError = null;
    let streamStageRecorded = false;

    // stdio[0] = "ignore" attaches /dev/null to fd 0. agy's TUI layer
    // (bubbletea) opens /dev/tty and dies without one; `-p` avoids the TUI, but
    // an inherited stdin can still stall the child in hook/background contexts.
    // Do not change to "pipe" or "inherit" without preserving /dev/null on stdin.
    const child = spawn(seatbeltLaunch.command, seatbeltLaunch.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: seatbeltLaunch.env,
      // Give the execution its own process group so deadline/protocol cleanup
      // can terminate terminal descendants instead of only the top-level CLI.
      detached: process.platform !== "win32",
    });
    try {
      recordAgyProcess(recoveryManifestPath, {
        pid: child.pid,
        pgid: child.pid,
      });
      maybeInjectTestCrash("child-spawned");
    } catch (error) {
      recoveryError = error;
      signalAgyProcessTree(child, "SIGKILL");
    }

    function terminateAgyProcessTree() {
      signalAgyProcessTree(child, "SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!settled) signalAgyProcessTree(child, "SIGKILL");
        }, SIGKILL_GRACE_MS);
      }
    }

    function handleParentSignal(signal) {
      if (!cancellationSignal && !timedOut && !boundaryError && !protocolError) {
        cancellationSignal = signal;
        appendLog(logFile, `Cancellation requested (${signal}) — terminating`);
      }
      terminateAgyProcessTree();
    }

    const onSigterm = () => handleParentSignal("SIGTERM");
    const onSigint = () => handleParentSignal("SIGINT");
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    function recheckExecutionBoundary(stage) {
      if (settled || boundaryError) return;
      try {
        assertExecutionBoundary(
          cwd,
          args,
          seatbeltLaunch.isolatedRuntime?.boundaryFiles
        );
      } catch (error) {
        boundaryError = error;
        appendLog(
          logFile,
          `Execution boundary drift at ${stage} [${error.code || "AGY_PERMISSION_BOUNDARY_UNSAFE"}]: ${error.message}`
        );
        terminateAgyProcessTree();
      }
    }

    const boundaryMonitor = setInterval(() => {
      recheckExecutionBoundary("periodic recheck");
    }, BOUNDARY_RECHECK_MS);

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      appendLog(logFile, `…still running (${elapsed}s elapsed)`);
    }, HEARTBEAT_MS);

    const deadline = setTimeout(() => {
      timedOut = true;
      appendLog(logFile, `Deadline exceeded (${Math.round(args.timeoutMs / 1000)}s) — terminating`);
      terminateAgyProcessTree();
    }, args.timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearInterval(boundaryMonitor);
      clearTimeout(deadline);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      let workspaceChanges = null;
      let inventoryError = null;
      try {
        workspaceChanges = listWorkspaceChanges(cwd);
        appendLog(
          logFile,
          `Workspace inventory: ${workspaceChanges.length ? workspaceChanges.join(" | ") : "clean"}`
        );
      } catch (error) {
        inventoryError = error;
        appendLog(
          logFile,
          `Workspace inventory failed [${error.code || "AGY_WORKSPACE_INVENTORY_FAILED"}]: ${error.message}`
        );
      }
      let cleanupError = null;
      if (seatbeltLaunch?.scratchDir) {
        try {
          cleanupSeatbeltScratch(seatbeltLaunch.scratchDir);
          appendLog(logFile, "Seatbelt scratch removed");
        } catch (error) {
          cleanupError = error;
          appendLog(
            logFile,
            `Seatbelt scratch cleanup failed [${error.code || "AGY_SEATBELT_SCRATCH_INVALID"}]: ${error.message}`
          );
        }
        seatbeltLaunch.scratchDir = null;
      }
      if (recoveryManifestPath) {
        try {
          recordAgyRunStage(recoveryManifestPath, "cleanup-complete");
        } catch (error) {
          cleanupError ||= error;
          appendLog(
            logFile,
            `Recovery manifest update failed [${error.code || "AGY_RECOVERY_FAILED"}]: ${error.message}`
          );
        }
      }
      if (cleanupError) {
        resolve({
          ...result,
          workspaceChanges,
          status: "failed",
          errorCode: cleanupError.code || "AGY_SEATBELT_CLEANUP_FAILED",
          errorMessage: `AGY cleanup transaction failed: ${cleanupError.message}`,
          recoveryManifestPath,
        });
      } else if (inventoryError) {
        resolve({
          ...result,
          workspaceChanges: null,
          status: "failed",
          errorCode: "AGY_WORKSPACE_INVENTORY_FAILED",
          errorMessage: `Cannot inventory AGY workspace mutations: ${inventoryError.message}`,
        });
      } else {
        resolve({ ...result, workspaceChanges, recoveryManifestPath });
      }
    }

    function processLine(line) {
      if (!line.trim() || protocolError) return;
      fs.appendFileSync(logFile, line + "\n", "utf8");
      if (!streamStageRecorded && recoveryManifestPath) {
        streamStageRecorded = true;
        try {
          recordAgyRunStage(recoveryManifestPath, "stream-active");
          maybeInjectTestCrash("stream-active");
        } catch (error) {
          recoveryError = error;
          appendLog(
            logFile,
            `Recovery manifest update failed [${error.code || "AGY_RECOVERY_FAILED"}]: ${error.message}`
          );
          terminateAgyProcessTree();
          return;
        }
      }
      try {
        consumeAgyEventLine(eventState, line);
        if (
          eventState.initCount === 1 &&
          eventState.runtime &&
          !runtimeBoundaryChecked
        ) {
          if (!isSameExecutionPath(eventState.runtime.cwd, cwd)) {
            throw makeAgyContractError(
              "AGY_RUNTIME_CWD_MISMATCH",
              `AGY init cwd '${eventState.runtime.cwd}' does not match '${cwd}'`
            );
          }
          if (eventState.runtime.permissionMode !== "request-review") {
            throw makeAgyContractError(
              "AGY_PERMISSION_MODE_UNSAFE",
              `AGY runtime permission mode was '${eventState.runtime.permissionMode}'`
            );
          }
          if (eventState.runtime.model !== args.model) {
            throw makeAgyContractError(
              "AGY_RUNTIME_MODEL_MISMATCH",
              `AGY init model '${eventState.runtime.model}' does not match '${args.model}'`
            );
          }
          assertAgyRuntimeToolBoundary(eventState.runtime.tools);
          recheckExecutionBoundary("authoritative init");
          runtimeBoundaryChecked = true;
        }
      } catch (error) {
        protocolError = error;
        appendLog(
          logFile,
          `Protocol failure [${error.code || "AGY_STREAM_INVALID"}]: ${error.message}`
        );
        terminateAgyProcessTree();
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let newline;
      while ((newline = stdoutBuf.indexOf("\n")) !== -1) {
        processLine(stdoutBuf.slice(0, newline));
        stdoutBuf = stdoutBuf.slice(newline + 1);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      fs.appendFileSync(logFile, text, "utf8");
    });

    child.on("error", (err) => {
      const hint =
        err.code === "ENOENT"
          ? "agy not found on PATH — install Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash"
          : err.message;
      appendLog(logFile, `Spawn error: ${hint}`);
      finish({
        status: "failed",
        errorCode: err.code === "ENOENT" ? "AGY_NOT_FOUND" : "AGY_SPAWN_ERROR",
        errorMessage: hint,
        conversationId: null,
        rawOutput: "",
        runtime: null,
        usage: null,
      });
    });

    child.on("close", (code, signal) => {
      // The CLI has closed its own streams. Terminate any detached terminal
      // descendants still left in the execution process group.
      signalAgyProcessTree(child, "SIGTERM", false);
      if (recoveryManifestPath) {
        try {
          recordAgyRunStage(recoveryManifestPath, "child-closed");
          maybeInjectTestCrash("child-closed");
        } catch (error) {
          recoveryError ||= error;
        }
      }
      if (stdoutBuf.trim()) processLine(stdoutBuf);
      stdoutBuf = "";
      const conversationId = eventState.conversationId;

      if (recoveryError) {
        finish({
          status: "failed",
          errorCode: recoveryError.code || "AGY_RECOVERY_FAILED",
          errorMessage: recoveryError.message,
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      if (!boundaryError) {
        recheckExecutionBoundary("process exit");
      }

      if (boundaryError) {
        finish({
          status: "failed",
          errorCode: boundaryError.code || "AGY_PERMISSION_BOUNDARY_UNSAFE",
          errorMessage: boundaryError.message,
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      if (protocolError) {
        finish({
          status: "failed",
          errorCode: protocolError.code || "AGY_STREAM_INVALID",
          errorMessage: protocolError.message,
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      if (cancellationSignal) {
        finish({
          status: "cancelled",
          errorCode: "AGY_CANCELLED",
          errorMessage: `Cancelled by ${cancellationSignal}`,
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      if (timedOut) {
        finish({
          status: "stalled",
          errorCode: "AGY_DEADLINE_EXCEEDED",
          errorMessage: `Timed out after ${Math.round(args.timeoutMs / 1000)}s`,
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      let parsed;
      try {
        parsed = finalizeAgyEventState(eventState);
      } catch (error) {
        const stderrMsg = stderrTail.trim();
        finish({
          status: "failed",
          errorCode: error.code || "AGY_STREAM_INVALID",
          errorMessage:
            error.message ||
            (code === null ? `signal ${signal}` : stderrMsg || `exit ${code}`),
          conversationId,
          rawOutput: "",
          runtime: eventState.runtime,
          usage: eventState.result?.usage ?? null,
        });
        return;
      }

      if (code !== 0) {
        const stderrMsg = stderrTail.trim();
        finish({
          status: "failed",
          errorCode: "AGY_PROCESS_FAILED",
          errorMessage:
            code === null
              ? `signal ${signal}${stderrMsg ? `: ${stderrMsg}` : ""}`
              : stderrMsg || `exit ${code}`,
          conversationId: parsed.conversationId,
          rawOutput: parsed.rawOutput,
          runtime: parsed.runtime,
          usage: parsed.usage,
        });
        return;
      }
      appendLog(logFile, `Conversation: ${parsed.conversationId}`);
      appendLog(logFile, "Completed successfully");
      finish({
        status: "completed",
        conversationId: parsed.conversationId,
        rawOutput: parsed.rawOutput,
        runtime: parsed.runtime,
        usage: parsed.usage,
      });
    });
  });
}

function assertAgyR16RunnerArguments(args) {
  if (!args.candidateExternalWorkspaceWrite) return;
  if (args.candidateWorkspaceWrite) {
    throw makeAgyContractError(
      "AGY_R16_CANDIDATE_CONFLICT",
      "local Seatbelt and external capsule candidates are mutually exclusive"
    );
  }
  if (
    args.sandbox !== "workspace-write" ||
    args.project !== "default-cli-project" ||
    args.resume ||
    args.mode ||
    args.addDirs?.length ||
    !/^cc-suite-agy-oauth-[a-f0-9]{16}$/.test(args.oauthVolume || "")
  ) {
    throw makeAgyContractError(
      "AGY_R16_ARGUMENTS_INVALID",
      "the R16 candidate requires workspace-write, project default-cli-project, " +
        "one exact OAuth volume, and no resume/mode/add-dir override"
    );
  }
}

function executeAgyR16(cwd, args, logFile, jobId) {
  return new Promise((resolve) => {
    let recoveryManifestPath = null;
    let runId = null;
    let suffix = null;
    try {
      assertAgyR16RunnerArguments(args);
      assertDisposableWorktree(cwd);
      assertAgyCustomizationSurface(cwd);
      suffix = randomBytes(6).toString("hex");
      runId = randomBytes(16).toString("hex");
      const recovery = createAgyR16RunManifest({
        cwd,
        jobId,
        logFile,
        oauthVolumeName: args.oauthVolume,
        runId,
        suffix,
      });
      recoveryManifestPath = recovery.manifestPath;
    } catch (error) {
      resolve({
        status: "failed",
        errorCode: error.code || "AGY_R16_ARGUMENTS_INVALID",
        errorMessage: error.message,
        conversationId: null,
        rawOutput: "",
        runtime: null,
        usage: null,
        workspaceChanges: null,
      });
      return;
    }

    const prompt = withDelegationBoundary(withConstitutionReminder(args.prompt));
    const childArgs = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), "agy-r16-workspace-session.mjs"),
      "--workspace", cwd,
      "--oauth-volume", args.oauthVolume,
      "--model", args.model,
      "--timeout-ms", String(args.timeoutMs),
      "--resource-suffix", suffix,
      "--run-id", runId,
      "--", prompt,
    ];
    appendLog(
      logFile,
      `Exec: node agy-r16-workspace-session.mjs --workspace ${cwd} ` +
        `--oauth-volume ${args.oauthVolume} --model ${args.model} <prompt>`
    );
    appendLog(logFile, "OS boundary: Apple Container R16 external capsule");

    const child = spawn(process.execPath, childArgs, {
      cwd,
      detached: process.platform !== "win32",
      env: {
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "C.UTF-8",
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        ...(process.env.NODE_ENV === "test" &&
          process.env.CC_SUITE_AGY_R16_TEST_CRASH_AT
          ? {
              NODE_ENV: "test",
              CC_SUITE_AGY_R16_TEST_CRASH_AT:
                process.env.CC_SUITE_AGY_R16_TEST_CRASH_AT,
            }
          : {}),
        ...(process.env.NODE_ENV === "test" &&
          process.env.CC_SUITE_AGY_R16_TEST_WORKLOAD === "network-boundary"
          ? {
              NODE_ENV: "test",
              CC_SUITE_AGY_R16_TEST_WORKLOAD: "network-boundary",
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      recordAgyR16SessionProcess(recoveryManifestPath, {
        pid: child.pid,
        pgid: child.pid,
      });
      maybeInjectR16RunnerTestCrash("session-spawned");
    } catch (error) {
      signalAgyProcessTree(child, "SIGKILL");
      try { recoverAgyR16OwnedRun(recoveryManifestPath); } catch {}
      resolve({
        status: "failed",
        errorCode: error.code || "AGY_R16_RECOVERY_FAILED",
        errorMessage: error.message,
        conversationId: null,
        rawOutput: "",
        runtime: null,
        usage: null,
        workspaceChanges: null,
      });
      return;
    }
    let stdout = "";
    let stderrTail = "";
    let outputTooLarge = false;
    let timedOut = false;
    let cancelled = null;
    let settled = false;
    let killTimer = null;

    const terminate = () => {
      signalAgyProcessTree(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!settled) signalAgyProcessTree(child, "SIGKILL");
        }, SIGKILL_GRACE_MS);
      }
    };
    const onSigterm = () => {
      cancelled ||= "SIGTERM";
      terminate();
    };
    const onSigint = () => {
      cancelled ||= "SIGINT";
      terminate();
    };
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, args.timeoutMs + 60_000);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      if (outputTooLarge) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > R16_MAX_RUNNER_OUTPUT_BYTES) {
        outputTooLarge = true;
        stdout = "";
        terminate();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
    });
    child.once("error", (error) => {
      finish({
        status: "failed",
        errorCode: "AGY_R16_SPAWN_FAILED",
        errorMessage: error.message,
        conversationId: null,
        rawOutput: "",
        runtime: null,
        usage: null,
        workspaceChanges: null,
      });
    });
    child.once("close", (code, signal) => {
      const recoverIfNeeded = (parsed = null) => {
        if (parsed?.evidence?.runtimeResourcesCleaned === true) {
          completeAgyR16RunManifest(recoveryManifestPath);
          return { recovered: false, ready: true };
        }
        try {
          const recovery = recoverAgyR16OwnedRun(recoveryManifestPath);
          return { recovered: true, ready: recovery.ready === true };
        } catch (error) {
          return {
            recovered: false,
            ready: false,
            errorCode: error.code || "AGY_R16_RECOVERY_FAILED",
            error: error.message,
          };
        }
      };
      if (outputTooLarge) {
        const recovery = recoverIfNeeded();
        finish({
          status: "failed",
          errorCode: recovery.ready
            ? "AGY_R16_RUNNER_OUTPUT_TOO_LARGE"
            : recovery.errorCode,
          errorMessage: recovery.ready
            ? "R16 session output exceeded its fixed bound"
            : recovery.error,
          conversationId: null,
          rawOutput: "",
          runtime: null,
          usage: null,
          workspaceChanges: null,
        });
        return;
      }
      if (timedOut) {
        const recovery = recoverIfNeeded();
        finish({
          status: "stalled",
          errorCode: recovery.ready ? "AGY_R16_DEADLINE_EXCEEDED" : recovery.errorCode,
          errorMessage: recovery.ready ? "R16 session exceeded its deadline" : recovery.error,
          conversationId: null,
          rawOutput: "",
          runtime: null,
          usage: null,
          workspaceChanges: null,
        });
        return;
      }
      if (cancelled) {
        const recovery = recoverIfNeeded();
        finish({
          status: "cancelled",
          errorCode: recovery.ready ? "AGY_CANCELLED" : recovery.errorCode,
          errorMessage: recovery.ready ? `Cancelled by ${cancelled}` : recovery.error,
          conversationId: null,
          rawOutput: "",
          runtime: null,
          usage: null,
          workspaceChanges: null,
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        const recovery = recoverIfNeeded();
        finish({
          status: "failed",
          errorCode: recovery.ready
            ? "AGY_R16_SESSION_PROTOCOL_INVALID"
            : recovery.errorCode,
          errorMessage:
            !recovery.ready
              ? recovery.error
              : code === null
              ? `R16 session ended by signal ${signal}`
              : stderrTail.trim() || "R16 session did not return one JSON result",
          conversationId: null,
          rawOutput: "",
          runtime: null,
          usage: null,
          workspaceChanges: null,
        });
        return;
      }
      const recovery = recoverIfNeeded(parsed);
      if (!recovery.ready) {
        finish({
          status: "failed",
          errorCode: recovery.errorCode,
          errorMessage: recovery.error,
          conversationId: parsed.threadId || null,
          rawOutput: "",
          runtime: parsed.runtime || null,
          usage: null,
          workspaceChanges: Array.isArray(parsed.workspaceChanges)
            ? parsed.workspaceChanges
            : null,
          r16Evidence: parsed.evidence || null,
        });
        return;
      }
      appendLog(
        logFile,
        `R16 evidence: ${JSON.stringify(parsed.evidence || {})}`
      );
      finish({
        status: parsed.status === "completed" && code === 0 ? "completed" : "failed",
        errorCode: parsed.errorCode ||
          (code === 0 ? null : "AGY_R16_SESSION_FAILED"),
        errorMessage: parsed.status === "completed" && code === 0
          ? null
          : parsed.errorCode || stderrTail.trim() || "R16 session failed",
        conversationId: parsed.threadId || null,
        rawOutput: parsed.rawOutput || "",
        runtime: parsed.runtime || null,
        usage: Number.isInteger(parsed.evidence?.totalTokens)
          ? { total_tokens: parsed.evidence.totalTokens }
          : null,
        workspaceChanges: Array.isArray(parsed.workspaceChanges)
          ? parsed.workspaceChanges
          : null,
        r16Evidence: parsed.evidence || null,
      });
    });
  });
}

function executeAgy(cwd, args, logFile, jobId) {
  if (args.candidateExternalWorkspaceWrite) {
    return executeAgyR16(cwd, args, logFile, jobId);
  }
  return executeAgySeatbelt(cwd, args, logFile, jobId);
}

async function runForeground(cwd, args) {
  const jobId = generateJobId(args.kind);
  const logFile = resolveJobLogFile(cwd, jobId);
  const sessionId = args.sessionId || process.env.CODEX_TOOLKIT_SESSION_ID || null;
  const deadlineAt = new Date(Date.now() + args.timeoutMs).toISOString();

  upsertJob(cwd, {
    id: jobId,
    kind: args.kind,
    status: "running",
    summary: args.summary || `${args.kind} task`,
    sessionId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    deadlineAt,
    logFile,
  });

  appendLog(logFile, `Starting ${args.kind} task (foreground, backend=agy)`);

  const result = await executeAgy(cwd, args, logFile, jobId);

  // threadId is the shared job-record field name across backends; for agy it
  // records the authoritative conversation uuid for status/result inspection.
  // Resume remains blocked until its permission and identity contract is proven.
  upsertJob(cwd, {
    id: jobId,
    status: result.status,
    threadId: result.conversationId || null,
    completedAt: new Date().toISOString(),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
  writeJobFile(cwd, jobId, {
    rawOutput: result.rawOutput || "",
    threadId: result.conversationId || null,
    ...(result.runtime ? { runtime: result.runtime } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(Array.isArray(result.workspaceChanges)
      ? { workspaceChanges: result.workspaceChanges }
      : {}),
    ...(result.r16Evidence ? { r16Evidence: result.r16Evidence } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  });
  if (result.recoveryManifestPath) {
    completeAgyRunManifest(result.recoveryManifestPath);
  }

  const output = {
    jobId,
    status: result.status,
    threadId: result.conversationId || null,
    rawOutput: result.rawOutput || "",
    ...(result.runtime ? { runtime: result.runtime } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(Array.isArray(result.workspaceChanges)
      ? { workspaceChanges: result.workspaceChanges }
      : {}),
    ...(result.r16Evidence ? { r16Evidence: result.r16Evidence } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
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
    id: jobId,
    kind: args.kind,
    status: "queued",
    summary: args.summary || `${args.kind} task`,
    sessionId,
    logFile,
  });

  appendLog(logFile, `Queued ${args.kind} task (background, backend=agy)`);

  const childArgv = [
    fileURLToPath(import.meta.url),
    "--kind", args.kind,
    "--project", args.project || "",
    "--sandbox", args.sandbox,
    "--timeout-ms", String(args.timeoutMs),
    "--session-id", sessionId || "",
    "--summary", args.summary || "",
  ];
  if (args.model) childArgv.push("--model", args.model);
  if (args.effort) childArgv.push("--effort", args.effort);
  if (args.mode) childArgv.push("--mode", args.mode);
  for (const dir of args.addDirs) childArgv.push("--add-dir", dir);
  if (args.resume) childArgv.push("--resume", args.resume);
  if (args.candidateWorkspaceWrite) childArgv.push("--candidate-workspace-write");
  if (args.candidateExternalWorkspaceWrite) {
    childArgv.push(args.releasedExternalWorkspaceWrite
      ? "--external-workspace-write"
      : "--candidate-external-workspace-write");
  }
  if (args.oauthVolume) childArgv.push("--oauth-volume", args.oauthVolume);
  childArgv.push("--", args.prompt);

  const child = spawn(process.execPath, childArgv, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_TOOLKIT_BACKGROUND_JOB_ID: jobId,
    },
  });

  upsertJob(cwd, {
    id: jobId,
    status: "running",
    pid: child.pid,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + args.timeoutMs).toISOString(),
  });

  child.unref();

  const output = { jobId, status: "queued", message: `Job ${jobId} started in background.` };
  process.stdout.write(JSON.stringify(output) + "\n");
}

async function runBackgroundWorker(cwd, args, jobId) {
  const logFile = resolveJobLogFile(cwd, jobId);
  appendLog(logFile, "Background worker started (backend=agy)");

  const result = await executeAgy(cwd, args, logFile, jobId);

  upsertJob(cwd, {
    id: jobId,
    status: result.status,
    threadId: result.conversationId || null,
    completedAt: new Date().toISOString(),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
  writeJobFile(cwd, jobId, {
    rawOutput: result.rawOutput || "",
    threadId: result.conversationId || null,
    ...(result.runtime ? { runtime: result.runtime } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(Array.isArray(result.workspaceChanges)
      ? { workspaceChanges: result.workspaceChanges }
      : {}),
    ...(result.r16Evidence ? { r16Evidence: result.r16Evidence } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { error: result.errorMessage } : {}),
  });
  if (result.recoveryManifestPath) {
    completeAgyRunManifest(result.recoveryManifestPath);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.prompt) {
    process.stderr.write("Error: no prompt provided. Use -- <prompt>\n");
    process.exit(1);
  }

  const cwd = resolveWorkspaceRoot(process.cwd());
  const r16RecoveryResults = await scavengeAgyR16Runs(cwd, {
    graceMs: RECOVERY_GRACE_MS,
  });
  const blockedR16Recovery = r16RecoveryResults.find((result) =>
    result.status === "blocked" || result.status === "active"
  );
  if (blockedR16Recovery) {
    process.stdout.write(JSON.stringify({
      status: "failed",
      errorCode: blockedR16Recovery.status === "active"
        ? "AGY_R16_RUN_ACTIVE"
        : blockedR16Recovery.errorCode || "AGY_R16_RECOVERY_FAILED",
      error: blockedR16Recovery.error || "an R16 run is already active",
    }) + "\n");
    process.exitCode = 1;
    return;
  }
  const recoveryResults = await scavengeAgyRuns(cwd, { graceMs: RECOVERY_GRACE_MS });
  const blockedRecovery = recoveryResults.find((result) => result.status === "blocked");
  if (blockedRecovery) {
    process.stdout.write(JSON.stringify({
      status: "failed",
      errorCode: blockedRecovery.errorCode || "AGY_RECOVERY_FAILED",
      error: blockedRecovery.error,
    }) + "\n");
    process.exitCode = 1;
    return;
  }

  const backgroundJobId = process.env.CODEX_TOOLKIT_BACKGROUND_JOB_ID;
  if (backgroundJobId) {
    await runBackgroundWorker(cwd, args, backgroundJobId);
    return;
  }

  if (args.background) {
    runBackground(cwd, args);
  } else {
    await runForeground(cwd, args);
  }
}

main();
