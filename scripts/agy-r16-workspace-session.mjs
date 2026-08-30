#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { createAgyBootstrapNonce, sendAgyBootstrap } from "./lib/agy-bootstrap.mjs";
import {
  auditAgyHostProxyContainerInventory,
} from "./lib/agy-host-proxy-bridge.mjs";
import {
  buildAgyHostGatewayProbeArgs,
  buildAgyHostGatewayProxyUrl,
  buildAgyLoopbackProxyConfig,
  createAgyHostGatewayBridge,
  runAgyHostGatewayProbe,
} from "./lib/agy-host-gateway-bridge.mjs";
import {
  parseAgyR15NetworkPrefix,
} from "./lib/agy-r15-session.mjs";
import {
  auditAgyR16HomeVolume,
  buildAgyR16HomeMergeArgs,
  buildAgyR16HomeSeedArgs,
  buildAgyR16HomeToolAuditArgs,
  buildAgyR16HomeVolumeCreateArgs,
  parseAgyR16HomeHelperResult,
} from "./lib/agy-r16-home.mjs";
import {
  AGY_R16_PROXY_IMAGE,
  AGY_R16_CAPSULE_IMAGE,
  AGY_R16_IMAGE_DIGESTS,
  AGY_R16_MAX_OUTPUT_BYTES,
  auditAgyR16Images,
  auditAgyR16OAuthVolume,
  auditAgyR16WorkspaceTranscript,
  auditAgyR16WorkspaceMutationBinding,
  buildAgyR16AuthPolicy,
  buildAgyR16CaptureSpec,
  buildAgyR16ClientCreateArgs,
  buildAgyR16Profile,
  buildAgyR16ProxyRunArgs,
  buildAgyR16ResourceNames,
  parseAgyR16ContainerIPv4,
  parseAgyR16ProxyIPv4,
} from "./lib/agy-r16-workspace.mjs";
import { assertAgyCustomizationSurface } from "./lib/agy-contract.mjs";
import {
  assertDisposableWorktree,
  listWorkspaceChanges,
} from "./lib/agy-seatbelt.mjs";

const COMMAND_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;
const PROXY_PORT = 18443;
const SIGKILL_GRACE_MS = 5_000;
const NETWORK_BOUNDARY_PROBE = [
  "set -u",
  "deny(){ if /usr/bin/curl --connect-timeout 1 --max-time 3 --silent --output /dev/null \"$@\"; then printf 'ALLOW'; else printf 'DENY'; fi; }",
  "uid=$(/usr/bin/id -u)",
  "gid=$(/usr/bin/id -g)",
  "caps=$(/sbin/getpcaps $$ | /bin/sed 's/.*: //')",
  "nnp=$(/bin/awk '/^NoNewPrivs:/{print $2}' /proc/self/status)",
  "direct=$(deny --noproxy '*' http://1.1.1.1/)",
  "metadata=$(deny --noproxy '*' http://169.254.169.254/)",
  "unlisted=$(deny https://example.com/)",
  "allowed=$(/usr/bin/curl --connect-timeout 8 --max-time 20 --silent --output /dev/null --write-out '%{http_code}' https://oauth2.googleapis.com/ || printf 'FAILED')",
  "printf '{\"uid\":%s,\"gid\":%s,\"capabilities\":\"%s\",\"noNewPrivs\":%s,\"directRaw\":\"%s\",\"metadata\":\"%s\",\"unlistedViaProxy\":\"%s\",\"allowedOauthHttpCode\":\"%s\"}\\n' \"$uid\" \"$gid\" \"$caps\" \"$nnp\" \"$direct\" \"$metadata\" \"$unlisted\" \"$allowed\" > /workspace/agy-r16-network-boundary-proof.json",
  "/bin/sleep 10",
].join("; ");

let activeCapture = null;
let interruptedSignal = null;
let runtimeStartedBySession = false;

function maybeInjectR16TestCrash(point) {
  const allowed = new Set([
    "home-created",
    "client-created",
    "proxy-created",
    "workspace-mutated",
    "token-merged",
  ]);
  if (
    process.env.NODE_ENV === "test" && allowed.has(point) &&
    process.env.CC_SUITE_AGY_R16_TEST_CRASH_AT === point
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function sessionError(code, message, findings = null) {
  const error = new Error(message);
  error.code = code;
  if (Array.isArray(findings)) error.findings = findings;
  return error;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeEnvironment() {
  return {
    HOME: os.homedir(),
    LANG: "C.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
}

function applyFixedR16TestWorkload(clientArgs) {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CC_SUITE_AGY_R16_TEST_WORKLOAD !== "network-boundary"
  ) return clientArgs;
  const imageIndex = clientArgs.indexOf(AGY_R16_CAPSULE_IMAGE);
  if (imageIndex < 0) {
    throw sessionError("AGY_R16_TEST_WORKLOAD_SCOPE_INVALID", "capsule image is missing");
  }
  return [
    ...clientArgs.slice(0, imageIndex + 1),
    "/bin/sh", "-c", NETWORK_BOUNDARY_PROBE,
  ];
}

export function parseAgyR16SessionArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || argv.length !== separator + 2) {
    throw sessionError(
      "AGY_R16_ARGUMENTS_INVALID",
      "usage: --workspace <path> --oauth-volume <name> --model <slug> " +
        "--timeout-ms <milliseconds> --resource-suffix <hex> --run-id <hex> -- <prompt>"
    );
  }
  const values = new Map();
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--workspace", "--oauth-volume", "--model", "--timeout-ms",
        "--resource-suffix", "--run-id",
      ].includes(flag) ||
      typeof value !== "string" || !value || values.has(flag)
    ) {
      throw sessionError("AGY_R16_ARGUMENTS_INVALID", "workspace arguments are invalid");
    }
    values.set(flag, value);
  }
  if (values.size !== 6) {
    throw sessionError("AGY_R16_ARGUMENTS_INVALID", "workspace arguments are incomplete");
  }
  const timeoutMs = Number(values.get("--timeout-ms"));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60 * 1000) {
    throw sessionError("AGY_R16_ARGUMENTS_INVALID", "timeout is invalid");
  }
  return {
    workspacePath: values.get("--workspace"),
    oauthVolumeName: values.get("--oauth-volume"),
    model: values.get("--model"),
    timeoutMs,
    resourceSuffix: values.get("--resource-suffix"),
    runId: values.get("--run-id"),
    prompt: argv[separator + 1],
  };
}

function runContainer(args, timeout = COMMAND_TIMEOUT_MS) {
  const result = spawnSync("container", args, {
    encoding: "utf8",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function requireContainerSuccess(args, code) {
  const result = runContainer(args);
  if (result.status !== 0) throw sessionError(code, "container operation failed");
  return result;
}

function requireEmptyRuntime() {
  const inventory = requireContainerSuccess(
    ["list", "--all", "--format", "json"],
    "AGY_R16_CONTAINER_INVENTORY_FAILED"
  );
  const audit = auditAgyHostProxyContainerInventory(inventory.stdout);
  if (!audit.ready) {
    throw sessionError(
      "AGY_R16_CONTAINER_RUNTIME_NOT_EMPTY",
      "Apple Container runtime must be empty",
      audit.findings
    );
  }
}

function loadHostProxyBridgeConfig() {
  requireEmptyRuntime();
  const scutilProxy = spawnSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (scutilProxy.status !== 0) {
    throw sessionError(
      "AGY_R16_HOST_PROXY_SETTINGS_INSPECT_FAILED",
      "macOS proxy settings could not be inspected"
    );
  }
  return buildAgyLoopbackProxyConfig({
    environment: process.env,
    scutilProxy: scutilProxy.stdout,
  });
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function chooseLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw sessionError("AGY_R16_BOOTSTRAP_PORT_INVALID", "loopback port is invalid");
  }
  return port;
}

async function waitForExactIPv4({ name, networkName, parse, capture = null }) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (interruptedSignal) {
      throw sessionError("AGY_R16_INTERRUPTED", "workspace session was interrupted");
    }
    if (capture?.spawnFailed || capture?.closed) {
      throw sessionError("AGY_R16_CLIENT_EXITED_EARLY", "workspace client exited early");
    }
    const inspected = runContainer(["inspect", name], 5_000);
    if (inspected.status === 0) {
      try {
        return parse(inspected.stdout, name, networkName);
      } catch {
        // The VM can report running briefly before its address is assigned.
      }
    }
    await wait(100);
  }
  throw sessionError("AGY_R16_CONTAINER_START_TIMEOUT", "container startup timed out");
}

async function waitForProxyReady(proxyName, expectedPolicyHash) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = runContainer(["logs", proxyName], 5_000);
    if (logs.status === 0) {
      for (const line of logs.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (
            event?.event === "agy_proxy_ready" &&
            event?.schemaVersion === 1 &&
            event?.policyHash === expectedPolicyHash
          ) return;
        } catch {
          // Unknown output cannot satisfy readiness.
        }
      }
    }
    await wait(100);
  }
  throw sessionError("AGY_R16_PROXY_READY_TIMEOUT", "proxy readiness timed out");
}

function startCapturedClient(clientName) {
  const spec = buildAgyR16CaptureSpec(clientName);
  const child = spawn(spec.command, spec.args, {
    ...spec.options,
    env: safeEnvironment(),
  });
  const capture = {
    child,
    closed: false,
    exitCode: null,
    signal: null,
    spawnFailed: false,
    stderr: "",
    stdout: "",
    tooLarge: false,
  };
  activeCapture = capture;
  let byteCount = 0;
  const append = (field, chunk) => {
    if (capture.tooLarge) return;
    byteCount += chunk.length;
    if (byteCount > AGY_R16_MAX_OUTPUT_BYTES) {
      capture.tooLarge = true;
      capture.stdout = "";
      capture.stderr = "";
      child.kill("SIGTERM");
      return;
    }
    capture[field] += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  capture.done = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      capture.closed = true;
      if (activeCapture === capture) activeCapture = null;
      resolve(capture);
    };
    child.once("error", () => {
      capture.spawnFailed = true;
      finish();
    });
    child.once("close", (exitCode, signal) => {
      capture.exitCode = exitCode;
      capture.signal = signal;
      finish();
    });
  });
  return capture;
}

async function awaitCapturedClient(capture, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([capture.done.then(() => "closed"), timeout]);
  clearTimeout(timer);
  if (result === "timeout") {
    capture.child.kill("SIGTERM");
    await wait(SIGKILL_GRACE_MS);
    if (!capture.closed) capture.child.kill("SIGKILL");
    throw sessionError("AGY_R16_PHASE_TIMEOUT", "workspace session timed out");
  }
  if (capture.spawnFailed) {
    throw sessionError("AGY_R16_START_FAILED", "workspace client failed to start");
  }
  if (capture.tooLarge) {
    throw sessionError("AGY_R16_OUTPUT_TOO_LARGE", "workspace output was too large");
  }
  return capture;
}

function stopAndDeleteExactContainer(name) {
  const inspected = runContainer(["inspect", name], 5_000);
  if (inspected.status === 0) {
    let running = false;
    try {
      const parsed = JSON.parse(inspected.stdout);
      running = Array.isArray(parsed) && parsed.length === 1 &&
        parsed[0]?.id === name && parsed[0]?.status?.state === "running";
    } catch {
      return false;
    }
    if (running && runContainer(["stop", name], 15_000).status !== 0) return false;
  }
  return runContainer(["delete", name], 15_000).status === 0;
}

function deleteExactHomeVolume(name) {
  const inspected = runContainer(["volume", "inspect", name], 5_000);
  if (inspected.status !== 0 || !auditAgyR16HomeVolume(inspected.stdout, name).ready) {
    return false;
  }
  return runContainer(["volume", "delete", name], 15_000).status === 0;
}

function summarizeProxyEvents(rawLogs) {
  const summary = { deniedCount: 0, failedCount: 0, openedCount: 0, readyCount: 0 };
  for (const line of String(rawLogs || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === "agy_proxy_ready") summary.readyCount += 1;
      else if (event?.event === "agy_proxy_tunnel_opened") summary.openedCount += 1;
      else if (event?.event === "agy_proxy_denied") summary.deniedCount += 1;
      else if (event?.event === "agy_proxy_failed") summary.failedCount += 1;
    } catch {
      summary.failedCount += 1;
    }
  }
  return summary;
}

function summarizeHostGatewayEvents(events) {
  const summary = {
    deniedCount: 0,
    failedCount: 0,
    openedCount: 0,
    readyCount: 0,
    stoppedCount: 0,
  };
  for (const event of events) {
    if (event?.event === "agy_host_gateway_ready") summary.readyCount += 1;
    else if (event?.event === "agy_host_gateway_tunnel_opened") summary.openedCount += 1;
    else if (event?.event === "agy_host_gateway_denied") summary.deniedCount += 1;
    else if (event?.event === "agy_host_gateway_failed") summary.failedCount += 1;
    else if (event?.event === "agy_host_gateway_stopped") summary.stoppedCount += 1;
    else summary.failedCount += 1;
  }
  return summary;
}

function workspaceFingerprint(workspacePath) {
  const git = spawnSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (git.status !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(git.stdout || "")) {
    throw sessionError("AGY_R16_WORKSPACE_FINGERPRINT_FAILED", "cannot fingerprint baseline commit");
  }
  const gitLink = fs.readFileSync(`${workspacePath}/.git`);
  return sha256(JSON.stringify({
    baseline: git.stdout.trim(),
    gitLinkSha256: sha256(gitLink),
    workspaceSha256: sha256(workspacePath),
  }));
}

async function runWorkspaceSession(args, hostProxyConfig) {
  const workspace = assertDisposableWorktree(args.workspacePath);
  assertAgyCustomizationSurface(workspace);
  const baselineChanges = listWorkspaceChanges(workspace);
  if (baselineChanges.length !== 0) {
    throw sessionError(
      "AGY_R16_WORKSPACE_NOT_CLEAN",
      "R16 requires a clean disposable worktree"
    );
  }
  const fingerprint = workspaceFingerprint(workspace);
  const hostProxyContract = sha256(JSON.stringify({
    contractSource: hostProxyConfig.contractSource,
    hostProxyIPv4: hostProxyConfig.hostProxyIPv4,
    hostProxyPort: hostProxyConfig.hostProxyPort,
  }));
  const profile = buildAgyR16Profile({
    hostProxyContract,
    model: args.model,
    prompt: args.prompt,
    workspaceFingerprint: fingerprint,
  });
  const names = buildAgyR16ResourceNames(args.resourceSuffix);
  const runId = args.runId;
  const state = {
    bridge: null,
    capture: null,
    clientCreated: false,
    gatewayEvents: [],
    homeVolumeCreated: false,
    proxyCreated: false,
  };
  let audit = null;
  let failureReason = null;
  let proxyEvents = { deniedCount: 0, failedCount: 0, openedCount: 0, readyCount: 0 };
  let gatewayIPv4 = null;
  let homeSeed = null;
  let tokenMerge = null;
  let toolAudit = null;
  let mutationBinding = null;
  let workspaceChanges = null;

  try {
    const networkInspect = requireContainerSuccess(
      ["network", "inspect", names.network],
      "AGY_R16_NETWORK_INSPECT_FAILED"
    );
    const networkPrefix = parseAgyR15NetworkPrefix(
      networkInspect.stdout,
      names.network
    );
    gatewayIPv4 = `${networkPrefix}.1`;
    requireContainerSuccess(
      buildAgyR16HomeVolumeCreateArgs(names.home),
      "AGY_R16_HOME_VOLUME_CREATE_FAILED"
    );
    state.homeVolumeCreated = true;
    maybeInjectR16TestCrash("home-created");
    const homeInspect = requireContainerSuccess(
      ["volume", "inspect", names.home],
      "AGY_R16_HOME_VOLUME_INSPECT_FAILED"
    );
    if (!auditAgyR16HomeVolume(homeInspect.stdout, names.home).ready) {
      throw sessionError("AGY_R16_HOME_VOLUME_AUDIT_FAILED", "home volume audit failed");
    }
    const seed = requireContainerSuccess(buildAgyR16HomeSeedArgs({
      helperImage: AGY_R16_PROXY_IMAGE,
      helperName: names.homeHelper,
      homeVolumeName: names.home,
      oauthVolumeName: args.oauthVolumeName,
    }), "AGY_R16_HOME_SEED_FAILED");
    homeSeed = parseAgyR16HomeHelperResult(seed.stdout, "seed");
    state.bridge = await createAgyHostGatewayBridge({
      hostProxyIPv4: hostProxyConfig.hostProxyIPv4,
      hostProxyPort: hostProxyConfig.hostProxyPort,
      logger: (event) => state.gatewayEvents.push(event),
    });
    const bootstrapHostPort = await chooseLoopbackPort();
    const bootstrapNonce = createAgyBootstrapNonce();
    requireContainerSuccess(applyFixedR16TestWorkload(buildAgyR16ClientCreateArgs({
      ...args,
      bootstrapHostPort,
      bootstrapNonce,
      clientName: names.client,
      homeVolumeName: names.home,
      networkName: names.network,
      networkPrefix,
      profileHash: profile.profileHash,
      proxyPort: PROXY_PORT,
      runId,
      workspacePath: workspace,
    })), "AGY_R16_CLIENT_CREATE_FAILED");
    state.clientCreated = true;
    maybeInjectR16TestCrash("client-created");
    state.capture = startCapturedClient(names.client);
    const clientIPv4 = await waitForExactIPv4({
      capture: state.capture,
      name: names.client,
      networkName: names.network,
      parse: parseAgyR16ContainerIPv4,
    });
    const proxyPolicy = buildAgyR16AuthPolicy({
      clientIPv4,
      gatewayIPv4,
      listenPort: PROXY_PORT,
      upstreamProxyUrl: buildAgyHostGatewayProxyUrl(
        gatewayIPv4,
        state.bridge.listenPort
      ),
    });
    requireContainerSuccess(buildAgyR16ProxyRunArgs({
      gatewayIPv4,
      networkName: names.network,
      policy: proxyPolicy.policy,
      proxyName: names.proxy,
    }), "AGY_R16_PROXY_CREATE_FAILED");
    state.proxyCreated = true;
    maybeInjectR16TestCrash("proxy-created");
    const proxyIPv4 = await waitForExactIPv4({
      name: names.proxy,
      networkName: names.network,
      parse: parseAgyR16ProxyIPv4,
    });
    state.bridge.authorizeClientIPv4(proxyIPv4);
    await waitForProxyReady(names.proxy, proxyPolicy.policyHash);
    const hostProxyProbe = await runAgyHostGatewayProbe({
      args: buildAgyHostGatewayProbeArgs({
        proxyName: names.proxy,
        redirectIPv4: gatewayIPv4,
        redirectPort: state.bridge.listenPort,
      }),
      environment: safeEnvironment(),
    });
    if (!hostProxyProbe.ready) {
      throw sessionError("AGY_R16_HOST_PROXY_PROBE_FAILED", "host proxy probe failed");
    }
    await sendAgyBootstrap({
      ipv4: proxyIPv4,
      nonce: bootstrapNonce,
      port: bootstrapHostPort,
      timeoutMs: 5_000,
    });
    const capture = await awaitCapturedClient(state.capture, args.timeoutMs);
    const observedAt = new Date();
    audit = auditAgyR16WorkspaceTranscript(capture.stdout, {
      cliExitCode: capture.exitCode,
      expectedModel: args.model,
      expectedProfileHash: profile.profileHash,
      expectedRunId: runId,
      now: observedAt,
    });
    if (audit.ready) {
      const toolAuditResult = requireContainerSuccess(buildAgyR16HomeToolAuditArgs({
        conversationId: audit.conversationId,
        helperImage: AGY_R16_PROXY_IMAGE,
        helperName: names.homeHelper,
        homeVolumeName: names.home,
      }), "AGY_R16_TOOL_AUDIT_FAILED");
      toolAudit = parseAgyR16HomeHelperResult(toolAuditResult.stdout, "audit-tools");
    }
    const proxyLogs = runContainer(["logs", names.proxy], 5_000);
    if (proxyLogs.status === 0) proxyEvents = summarizeProxyEvents(proxyLogs.stdout);
    if (
      proxyEvents.readyCount !== 1 ||
      proxyEvents.openedCount < 1 ||
      proxyEvents.failedCount !== 0
    ) {
      failureReason = "AGY_R16_EGRESS_NOT_PROVEN";
    }
    workspaceChanges = listWorkspaceChanges(workspace);
    if (workspaceChanges.length > 0) {
      maybeInjectR16TestCrash("workspace-mutated");
    }
    if (audit.ready && toolAudit) {
      mutationBinding = auditAgyR16WorkspaceMutationBinding({
        runId,
        toolTargets: toolAudit.targets,
        workspacePath: workspace,
      });
      if (!mutationBinding.ready) {
        failureReason ||= mutationBinding.findings[0];
      }
    }
    if (!audit.ready || !toolAudit || failureReason || workspaceChanges.length < 1) {
      failureReason ||= "AGY_R16_WORKSPACE_MUTATION_NOT_PROVEN";
    } else {
      const merge = requireContainerSuccess(buildAgyR16HomeMergeArgs({
        expectedDurableHash: homeSeed.sourceHash,
        helperImage: AGY_R16_PROXY_IMAGE,
        helperName: names.homeHelper,
        homeVolumeName: names.home,
        oauthVolumeName: args.oauthVolumeName,
        runId,
      }), "AGY_R16_TOKEN_MERGE_FAILED");
      tokenMerge = parseAgyR16HomeHelperResult(merge.stdout, "merge");
      maybeInjectR16TestCrash("token-merged");
    }
  } catch (error) {
    failureReason = error?.code || "AGY_R16_UNKNOWN_FAILURE";
  }

  if (state.capture?.child && !state.capture.closed) state.capture.child.kill("SIGTERM");
  if (state.proxyCreated) {
    const proxyLogs = runContainer(["logs", names.proxy], 5_000);
    if (proxyLogs.status === 0) proxyEvents = summarizeProxyEvents(proxyLogs.stdout);
  }
  const cleanup = {
    bridge: true,
    client: !state.clientCreated || stopAndDeleteExactContainer(names.client),
    homeVolume: true,
    proxy: !state.proxyCreated || stopAndDeleteExactContainer(names.proxy),
  };
  if (state.bridge) {
    try {
      await state.bridge.close();
    } catch {
      cleanup.bridge = false;
    }
  }
  if (state.homeVolumeCreated) cleanup.homeVolume = deleteExactHomeVolume(names.home);
  const hostGatewayEvents = summarizeHostGatewayEvents(state.gatewayEvents);
  if (
    hostGatewayEvents.readyCount !== 1 ||
    hostGatewayEvents.openedCount < 1 ||
    hostGatewayEvents.failedCount !== 0 ||
    hostGatewayEvents.stoppedCount !== 1
  ) {
    failureReason ||= "AGY_R16_HOST_GATEWAY_NOT_PROVEN";
  }
  let runtimeEmpty = false;
  try {
    requireEmptyRuntime();
    runtimeEmpty = true;
  } catch {
    runtimeEmpty = false;
  }
  if (workspaceChanges === null) {
    try {
      workspaceChanges = listWorkspaceChanges(workspace);
    } catch {
      failureReason ||= "AGY_R16_WORKSPACE_INVENTORY_FAILED";
    }
  }
  const runtimeResourcesCleaned = cleanup.bridge && cleanup.client && cleanup.proxy &&
    cleanup.homeVolume && runtimeEmpty;
  const ready = audit?.ready === true && !failureReason &&
    runtimeResourcesCleaned && Array.isArray(workspaceChanges);
  return {
    status: ready ? "completed" : "failed",
    threadId: ready ? audit.conversationId : null,
    rawOutput: ready ? audit.rawOutput : "",
    runtime: ready ? audit.runtime : null,
    workspaceChanges,
    errorCode: ready
      ? null
      : failureReason || audit?.findings?.[0] ||
        (runtimeResourcesCleaned ? "AGY_R16_RESULT_NOT_PROVEN" : "AGY_R16_CLEANUP_FAILED"),
    evidence: {
      capsuleImageDigest: AGY_R16_IMAGE_DIGESTS[
        AGY_R16_CAPSULE_IMAGE
      ],
      egress: proxyEvents,
      diagnostic: audit?.diagnostic || null,
      findings: audit?.findings || [],
      hostGateway: hostGatewayEvents,
      hostGatewayIPv4: gatewayIPv4,
      hostProxyContract,
      hostProxyContractSource: hostProxyConfig.contractSource,
      homeSeedHash: homeSeed?.sourceHash || null,
      lifecycleTiming: audit?.lifecycleTiming || null,
      profileHash: profile.profileHash,
      promptSha256: profile.promptSha256,
      runId,
      runtimeResourcesCleaned,
      mutationBinding,
      tokenMerge,
      toolAudit,
      toolCounts: audit?.toolCounts || {},
      totalTokens: audit?.totalTokens || null,
      workloadSha256: audit?.workloadSha256 || null,
      workspaceFingerprint: fingerprint,
    },
  };
}

async function ensureRuntime() {
  let runtime = runContainer(["system", "status"], 5_000);
  if (runtime.status !== 0 || !/^status\s+running$/m.test(runtime.stdout)) {
    requireContainerSuccess(["system", "start"], "AGY_R16_RUNTIME_START_FAILED");
    runtimeStartedBySession = true;
    runtime = requireContainerSuccess(
      ["system", "status"],
      "AGY_R16_RUNTIME_UNAVAILABLE"
    );
  }
  if (!/^status\s+running$/m.test(runtime.stdout)) {
    throw sessionError("AGY_R16_RUNTIME_UNAVAILABLE", "container runtime is unavailable");
  }
}

async function main() {
  const args = parseAgyR16SessionArguments(process.argv.slice(2));
  await ensureRuntime();
  const images = requireContainerSuccess(
    ["image", "inspect", ...Object.keys(AGY_R16_IMAGE_DIGESTS)],
    "AGY_R16_IMAGE_INSPECT_FAILED"
  );
  const imageAudit = auditAgyR16Images(images.stdout);
  if (!imageAudit.ready) {
    throw sessionError("AGY_R16_IMAGE_AUDIT_FAILED", "image audit failed", imageAudit.findings);
  }
  const volumeInspect = requireContainerSuccess(
    ["volume", "inspect", args.oauthVolumeName],
    "AGY_R16_OAUTH_VOLUME_NOT_FOUND"
  );
  const volumeAudit = auditAgyR16OAuthVolume(volumeInspect.stdout, {
    expectedName: args.oauthVolumeName,
    homeDirectory: os.homedir(),
    now: new Date(),
  });
  if (!volumeAudit.ready) {
    throw sessionError(
      "AGY_R16_OAUTH_VOLUME_AUDIT_FAILED",
      "OAuth volume audit failed",
      volumeAudit.findings
    );
  }
  const hostProxyConfig = loadHostProxyBridgeConfig();
  const result = await runWorkspaceSession(args, hostProxyConfig);
  const runtimeRestored = !runtimeStartedBySession ||
    runContainer(["system", "stop"], 15_000).status === 0;
  result.evidence.oauthVolumeAgeMs = volumeAudit.ageMs;
  result.evidence.refreshAgeProven = volumeAudit.refreshAgeProven;
  result.evidence.runtimeRestored = runtimeRestored;
  if (!runtimeRestored) {
    result.status = "failed";
    result.errorCode = "AGY_R16_RUNTIME_RESTORE_FAILED";
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "completed") process.exitCode = 70;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.on(signal, () => {
      interruptedSignal = signal;
      if (activeCapture?.child && !activeCapture.closed) activeCapture.child.kill(signal);
    });
  }

  main().catch((error) => {
    const runtimeRestored = !runtimeStartedBySession ||
      runContainer(["system", "stop"], 15_000).status === 0;
    process.stdout.write(`${JSON.stringify({
      status: "failed",
      threadId: null,
      rawOutput: "",
      runtime: null,
      workspaceChanges: null,
      errorCode: error?.code || "AGY_R16_UNKNOWN_FAILURE",
      evidence: {
        findings: Array.isArray(error?.findings) ? error.findings : [],
        runtimeRestored,
      },
    })}\n`);
    process.exitCode = error?.code === "AGY_R16_ARGUMENTS_INVALID" ? 64 : 70;
  });
}
