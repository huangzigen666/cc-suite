#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";

import { createAgyBootstrapNonce, sendAgyBootstrap } from "./lib/agy-bootstrap.mjs";
import {
  buildAgyR15AuthPolicy,
  buildAgyR15ProxyRunArgs,
} from "./lib/agy-r15-auth.mjs";
import {
  auditAgyHostProxyContainerInventory,
  buildAgyHostProxyBridgeConfig,
  buildAgyHostProxyProbeArgs,
  buildAgyHostProxyRedirectUrl,
  createAgyHostProxyBridge,
  runAgyHostProxyProbe,
} from "./lib/agy-host-proxy-bridge.mjs";
import {
  AGY_R15_IMAGE_DIGESTS,
  auditAgyR15Images,
  parseAgyR15NetworkPrefix,
  parseAgyR15ProxyIPv4,
  parseAgyR15VerificationClientIPv4,
} from "./lib/agy-r15-session.mjs";
import {
  AGY_R15_VERIFY_MAX_OUTPUT_BYTES,
  AGY_R15_VERIFY_PROFILE_HASHES,
  auditAgyR15ExistingOAuthVolume,
  auditAgyR15ModelTranscript,
  auditAgyR15ModelsTranscript,
  buildAgyR15CaptureSpec,
  buildAgyR15VerificationClientCreateArgs,
  buildAgyR15VerificationResourceNames,
  parseAgyR15VerifyArguments,
  summarizeAgyR15Capture,
} from "./lib/agy-r15-verify.mjs";

const COMMAND_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;
const PROXY_PORT = 18443;
const PHASE_TIMEOUT_MS = Object.freeze({
  models: 30_000,
  request: 150_000,
});

let activeChild = null;
let interruptedSignal = null;
let runtimeStartedByVerifier = false;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeEnvironment() {
  return {
    HOME: os.homedir(),
    LANG: "C.UTF-8",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
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

function loadHostProxyBridgeConfig() {
  const inventory = requireContainerSuccess(
    ["list", "--all", "--format", "json"],
    "AGY_R15_HOST_PROXY_INVENTORY_FAILED"
  );
  const inventoryAudit = auditAgyHostProxyContainerInventory(inventory.stdout);
  if (!inventoryAudit.ready) {
    const error = sessionError(
      "AGY_R15_HOST_PROXY_RUNTIME_NOT_EMPTY",
      "Apple Container runtime must be empty before verification"
    );
    error.findings = inventoryAudit.findings;
    throw error;
  }
  const dnsList = requireContainerSuccess(
    ["system", "dns", "list"],
    "AGY_R15_HOST_PROXY_DOMAIN_INSPECT_FAILED"
  );
  const scutilProxy = spawnSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (scutilProxy.status !== 0) {
    throw sessionError(
      "AGY_R15_HOST_PROXY_SETTINGS_INSPECT_FAILED",
      "macOS proxy settings could not be inspected"
    );
  }
  return buildAgyHostProxyBridgeConfig({
    dnsList: dnsList.stdout,
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
    throw sessionError("AGY_R15_BOOTSTRAP_PORT_INVALID", "loopback port is invalid");
  }
  return port;
}

async function waitForExactIPv4({ name, networkName, parse, capture = null }) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (interruptedSignal) {
      throw sessionError("AGY_R15_VERIFY_INTERRUPTED", "verification was interrupted");
    }
    if (capture?.spawnFailed || capture?.closed) {
      throw sessionError("AGY_R15_VERIFY_CLIENT_EXITED_EARLY", "client exited early");
    }
    const inspected = runContainer(["inspect", name], 5000);
    if (inspected.status === 0) {
      try {
        return parse(inspected.stdout, name, networkName);
      } catch {
        // Apple Container briefly reports a running VM with no assigned address.
      }
    }
    await wait(100);
  }
  throw sessionError("AGY_R15_CONTAINER_START_TIMEOUT", "container startup timed out");
}

async function waitForProxyReady(proxyName, expectedPolicyHash) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = runContainer(["logs", proxyName], 5000);
    if (logs.status === 0) {
      for (const line of logs.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (
            event?.event === "agy_proxy_ready" &&
            event?.schemaVersion === 1 &&
            event?.policyHash === expectedPolicyHash
          ) {
            return;
          }
        } catch {
          // Unknown sidecar output cannot satisfy readiness.
        }
      }
    }
    await wait(100);
  }
  throw sessionError("AGY_R15_PROXY_READY_TIMEOUT", "proxy readiness timed out");
}

function startCapturedClient(clientName) {
  const spec = buildAgyR15CaptureSpec(clientName);
  const child = spawn(spec.command, spec.args, {
    ...spec.options,
    env: safeEnvironment(),
  });
  activeChild = child;
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
  let byteCount = 0;
  const append = (field, chunk) => {
    if (capture.tooLarge) return;
    byteCount += chunk.length;
    if (byteCount > AGY_R15_VERIFY_MAX_OUTPUT_BYTES) {
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
      if (activeChild === child) activeChild = null;
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
  const result = await Promise.race([
    capture.done.then(() => "closed"),
    timeout,
  ]);
  clearTimeout(timer);
  if (result === "timeout") {
    capture.child.kill("SIGTERM");
    throw sessionError("AGY_R15_VERIFY_PHASE_TIMEOUT", "verification phase timed out");
  }
  if (capture.spawnFailed) {
    throw sessionError("AGY_R15_VERIFY_START_FAILED", "verification client failed to start");
  }
  if (capture.tooLarge) {
    throw sessionError("AGY_R15_VERIFY_OUTPUT_TOO_LARGE", "verification output was too large");
  }
  return capture;
}

function stopAndDeleteExactContainer(name) {
  const inspected = runContainer(["inspect", name], 5000);
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

function summarizeProxyEvents(rawLogs) {
  const summary = {
    deniedCount: 0,
    failedCount: 0,
    openedCount: 0,
    readyCount: 0,
  };
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

function writePublicEvent(stream, event) {
  stream.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
}

async function runPhase(phase, oauthVolumeName, hostProxyConfig) {
  const suffix = randomBytes(6).toString("hex");
  const names = buildAgyR15VerificationResourceNames(suffix, phase);
  const state = {
    capture: null,
    clientCreated: false,
    hostProxyBridge: null,
    proxyCreated: false,
  };
  let audit = null;
  let diagnostics = null;
  let failureReason = null;
  let proxyEvents = {
    deniedCount: 0,
    failedCount: 0,
    openedCount: 0,
    readyCount: 0,
  };

  try {
    state.hostProxyBridge = await createAgyHostProxyBridge({
      hostProxyIPv4: hostProxyConfig.hostProxyIPv4,
      hostProxyPort: hostProxyConfig.hostProxyPort,
    });
    const networkInspect = requireContainerSuccess(
      ["network", "inspect", names.network],
      "AGY_R15_NETWORK_INSPECT_FAILED"
    );
    const networkPrefix = parseAgyR15NetworkPrefix(
      networkInspect.stdout,
      names.network
    );

    const bootstrapHostPort = await chooseLoopbackPort();
    const bootstrapNonce = createAgyBootstrapNonce();
    const runId = randomBytes(16).toString("hex");
    const profileHash = AGY_R15_VERIFY_PROFILE_HASHES[phase];
    requireContainerSuccess(buildAgyR15VerificationClientCreateArgs({
      bootstrapHostPort,
      bootstrapNonce,
      clientName: names.client,
      networkName: names.network,
      networkPrefix,
      oauthVolumeName,
      phase,
      profileHash,
      proxyPort: PROXY_PORT,
      runId,
    }), "AGY_R15_VERIFY_CLIENT_CREATE_FAILED");
    state.clientCreated = true;
    state.capture = startCapturedClient(names.client);

    const clientIPv4 = await waitForExactIPv4({
      capture: state.capture,
      name: names.client,
      networkName: names.network,
      parse: parseAgyR15VerificationClientIPv4,
    });
    const proxyPolicy = buildAgyR15AuthPolicy({
      clientIPv4,
      listenPort: PROXY_PORT,
      upstreamProxyUrl: buildAgyHostProxyRedirectUrl(
        state.hostProxyBridge.listenPort
      ),
    });
    requireContainerSuccess(buildAgyR15ProxyRunArgs({
      networkName: names.network,
      policy: proxyPolicy.policy,
      proxyName: names.proxy,
    }), "AGY_R15_PROXY_CREATE_FAILED");
    state.proxyCreated = true;
    const proxyIPv4 = await waitForExactIPv4({
      name: names.proxy,
      networkName: names.network,
      parse: parseAgyR15ProxyIPv4,
    });
    state.hostProxyBridge.authorizeClientIPv4(proxyIPv4);
    await waitForProxyReady(names.proxy, proxyPolicy.policyHash);
    const hostProxyProbe = await runAgyHostProxyProbe({
      args: buildAgyHostProxyProbeArgs({
        proxyName: names.proxy,
        redirectIPv4: hostProxyConfig.redirectIPv4,
        redirectPort: state.hostProxyBridge.listenPort,
      }),
      environment: safeEnvironment(),
    });
    if (!hostProxyProbe.ready) {
      throw sessionError(
        "AGY_R15_HOST_PROXY_PROBE_FAILED",
        "credential-free host proxy probe failed"
      );
    }
    await sendAgyBootstrap({
      ipv4: proxyIPv4,
      nonce: bootstrapNonce,
      port: bootstrapHostPort,
      timeoutMs: 5000,
    });

    const capture = await awaitCapturedClient(state.capture, PHASE_TIMEOUT_MS[phase]);
    const observedAt = new Date();
    diagnostics = summarizeAgyR15Capture({ ...capture, observedAt });
    const proxyLogs = runContainer(["logs", names.proxy], 5000);
    if (proxyLogs.status === 0) proxyEvents = summarizeProxyEvents(proxyLogs.stdout);
    const expected = {
      cliExitCode: capture.exitCode,
      expectedProfileHash: profileHash,
      expectedRunId: runId,
      now: observedAt,
    };
    audit = phase === "models"
      ? auditAgyR15ModelsTranscript(capture.stdout, expected)
      : auditAgyR15ModelTranscript(capture.stdout, expected);
    if (proxyEvents.readyCount !== 1 || proxyEvents.openedCount < 1 ||
        proxyEvents.failedCount !== 0) {
      failureReason = "AGY_R15_VERIFY_EGRESS_NOT_PROVEN";
    }
  } catch (error) {
    failureReason = error?.code || "AGY_R15_VERIFY_UNKNOWN_FAILURE";
  }

  if (state.capture?.child && !state.capture.closed) {
    state.capture.child.kill("SIGTERM");
  }
  if (state.proxyCreated) {
    const proxyLogs = runContainer(["logs", names.proxy], 5000);
    if (proxyLogs.status === 0) proxyEvents = summarizeProxyEvents(proxyLogs.stdout);
  }
  const cleanup = {
    bridge: true,
    client: !state.clientCreated || stopAndDeleteExactContainer(names.client),
    proxy: !state.proxyCreated || stopAndDeleteExactContainer(names.proxy),
  };
  if (state.hostProxyBridge) {
    try {
      await state.hostProxyBridge.close();
    } catch {
      cleanup.bridge = false;
    }
  }
  const runtimeResourcesCleaned = cleanup.bridge && cleanup.client &&
    cleanup.proxy;
  const ready = audit?.ready === true && !failureReason && runtimeResourcesCleaned;
  return {
    phase,
    ready,
    evidence: audit || null,
    diagnostics,
    egress: proxyEvents,
    failureReason: ready
      ? null
      : failureReason || (runtimeResourcesCleaned
        ? "AGY_R15_VERIFY_OUTPUT_NOT_PROVEN"
        : "AGY_R15_VERIFY_CLEANUP_FAILED"),
    runtimeResourcesCleaned,
  };
}

async function main() {
  const { oauthVolumeName } = parseAgyR15VerifyArguments(process.argv.slice(2));
  let runtime = runContainer(["system", "status"], 5000);
  if (runtime.status !== 0 || !/^status\s+running$/m.test(runtime.stdout)) {
    requireContainerSuccess(
      ["system", "start"],
      "AGY_R15_CONTAINER_RUNTIME_START_FAILED"
    );
    runtimeStartedByVerifier = true;
    runtime = requireContainerSuccess(
      ["system", "status"],
      "AGY_R15_CONTAINER_RUNTIME_UNAVAILABLE"
    );
  }
  if (!/^status\s+running$/m.test(runtime.stdout)) {
    throw sessionError(
      "AGY_R15_CONTAINER_RUNTIME_UNAVAILABLE",
      "container runtime is unavailable"
    );
  }

  const images = requireContainerSuccess(
    ["image", "inspect", ...Object.keys(AGY_R15_IMAGE_DIGESTS)],
    "AGY_R15_IMAGE_INSPECT_FAILED"
  );
  const imageAudit = auditAgyR15Images(images.stdout);
  if (!imageAudit.ready) {
    const error = sessionError("AGY_R15_IMAGE_AUDIT_FAILED", "image audit failed");
    error.findings = imageAudit.findings;
    throw error;
  }
  const hostProxyConfig = loadHostProxyBridgeConfig();

  const volumeInspect = requireContainerSuccess(
    ["volume", "inspect", oauthVolumeName],
    "AGY_R15_VERIFY_VOLUME_NOT_FOUND"
  );
  const volumeAudit = auditAgyR15ExistingOAuthVolume(volumeInspect.stdout, {
    expectedName: oauthVolumeName,
    homeDirectory: os.homedir(),
    now: new Date(),
  });
  if (!volumeAudit.ready) {
    const error = sessionError("AGY_R15_VERIFY_VOLUME_AUDIT_FAILED", "volume audit failed");
    error.findings = volumeAudit.findings;
    throw error;
  }

  const models = await runPhase("models", oauthVolumeName, hostProxyConfig);
  let request = null;
  if (models.ready) {
    request = await runPhase("request", oauthVolumeName, hostProxyConfig);
  }
  const completed = models.ready && request?.ready === true;
  const runtimeRestored = !runtimeStartedByVerifier ||
    runContainer(["system", "stop"], 15_000).status === 0;
  writePublicEvent(completed ? process.stdout : process.stderr, {
    authenticationPersistedAcrossFreshCapsule: models.ready,
    event: completed
      ? "agy_r15_verification_completed"
      : "agy_r15_verification_failed",
    models,
    oauthVolumeName,
    promotionReady: false,
    realModelCallProven: request?.ready === true,
    request,
    runtimeRestored,
    runtimeStartedByVerifier,
    tokenRefreshProven: false,
    volumePreserved: true,
  });
  if (!completed || !runtimeRestored) process.exitCode = 70;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => {
    interruptedSignal = signal;
    if (activeChild?.exitCode === null) activeChild.kill(signal);
  });
}

main().catch((error) => {
  const runtimeRestored = !runtimeStartedByVerifier ||
    runContainer(["system", "stop"], 15_000).status === 0;
  writePublicEvent(process.stderr, {
    event: "agy_r15_verification_refused",
    findings: Array.isArray(error?.findings) ? error.findings : [],
    promotionReady: false,
    reason: error?.code || "AGY_R15_VERIFY_UNKNOWN_FAILURE",
    runtimeRestored,
  });
  process.exitCode = error?.code === "AGY_R15_VERIFY_ARGUMENTS_INVALID" ? 64 : 70;
});
