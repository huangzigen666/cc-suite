#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";

import { createAgyBootstrapNonce, sendAgyBootstrap } from "./lib/agy-bootstrap.mjs";
import {
  AGY_R15_AUTH_HOSTS,
  AGY_R15_AUTH_PROFILE_HASH,
  AGY_R15_OAUTH_SCOPES,
  buildAgyR15AuthPolicy,
  buildAgyR15ClientCreateArgs,
  buildAgyR15ProxyRunArgs,
} from "./lib/agy-r15-auth.mjs";
import {
  AGY_HOST_PROXY_DOMAIN,
  AGY_HOST_PROXY_REDIRECT_IPV4,
  auditAgyHostProxyContainerInventory,
  buildAgyHostProxyBridgeConfig,
  buildAgyHostProxyProbeArgs,
  buildAgyHostProxyRedirectUrl,
  createAgyHostProxyBridge,
  runAgyHostProxyProbe,
} from "./lib/agy-host-proxy-bridge.mjs";
import {
  AGY_R15_IMAGE_DIGESTS,
  auditAgyR15Consent,
  auditAgyR15Images,
  buildAgyR15AttachSpec,
  buildAgyR15ResourceNames,
  parseAgyR15ContainerIPv4,
  parseAgyR15NetworkPrefix,
  parseAgyR15ProxyIPv4,
} from "./lib/agy-r15-session.mjs";
import {
  createAgyOAuthVolumeName,
  prepareAgyOAuthVolume,
} from "./lib/agy-oauth-volume.mjs";

const PROXY_PORT = 18443;
const COMMAND_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;

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
      "Apple Container runtime must be empty before enabling the host redirect"
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

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForExactIPv4({ name, networkName, parse, attachedChild = null }) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (attachedChild && attachedChild.exitCode !== null) {
      throw sessionError("AGY_R15_AUTH_CLIENT_EXITED_EARLY", "auth client exited early");
    }
    const inspected = runContainer(["inspect", name], 5000);
    if (inspected.status === 0) {
      try {
        return parse(inspected.stdout, name, networkName);
      } catch {
        // The runtime reports an empty network list briefly while the VM starts.
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
          // Reject unknown log lines by continuing until the bounded timeout.
        }
      }
    }
    await wait(100);
  }
  throw sessionError("AGY_R15_PROXY_READY_TIMEOUT", "proxy readiness timed out");
}

function createAttachedChild(clientName) {
  const spec = buildAgyR15AttachSpec(clientName);
  return spawn(spec.command, spec.args, {
    ...spec.options,
    env: safeEnvironment(),
  });
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ exitCode: null, signal: null, spawnFailed: true }));
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal, spawnFailed: false });
    });
  });
}

function forwardTerminalSignals(child) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    const handler = () => {
      if (child.exitCode === null) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
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

function deleteExactVolume(name) {
  return runContainer(["volume", "delete", name], 15_000).status === 0;
}

function writePublicEvent(stream, event) {
  stream.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
}

function writeConsentNotice() {
  process.stderr.write([
    "AGY R15 交互授权边界",
    "- Google 同意页由你本人判断；不要把授权码、URL 或令牌发给任何代理。",
    "- 本次观察到的 scope 包含 cloud-platform；它不是 AGY 专属的窄权限。",
    `- 完整 scope：${AGY_R15_OAUTH_SCOPES.join(", ")}`,
    `- 胶囊出口仅允许：${AGY_R15_AUTH_HOSTS.join(", ")}`,
    `- 宿主机桥仅使用 Apple localhost 映射：${AGY_HOST_PROXY_DOMAIN} -> ${AGY_HOST_PROXY_REDIRECT_IPV4}`,
    "- 会话期间 Apple Container 必须无其他容器；启动器不会自动执行 sudo 或保留代理地址。",
    "- 会话关闭不等于认证成功；必须在新胶囊中独立验证后才能下结论。",
    "",
  ].join("\n"));
}

async function main() {
  const consent = auditAgyR15Consent(process.argv.slice(2), {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
    stderr: process.stderr.isTTY === true,
  });
  if (!consent.ready) {
    const error = sessionError(consent.findings[0], "R15 consent gate failed");
    error.findings = consent.findings;
    throw error;
  }
  writeConsentNotice();

  const runtime = requireContainerSuccess(
    ["system", "status"],
    "AGY_R15_CONTAINER_RUNTIME_UNAVAILABLE"
  );
  if (!/^status\s+running$/m.test(runtime.stdout)) {
    throw sessionError(
      "AGY_R15_CONTAINER_RUNTIME_UNAVAILABLE",
      "container runtime is not running"
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

  const suffix = randomBytes(6).toString("hex");
  const names = buildAgyR15ResourceNames(suffix);
  const oauthVolumeName = createAgyOAuthVolumeName();
  const state = {
    attachedChild: null,
    clientCreated: false,
    handoffCompleted: false,
    hostProxyBridge: null,
    proxyCreated: false,
    removeSignalHandlers: null,
    volumeCreated: false,
  };
  let outcome;

  try {
    state.hostProxyBridge = await createAgyHostProxyBridge({
      hostProxyIPv4: hostProxyConfig.hostProxyIPv4,
      hostProxyPort: hostProxyConfig.hostProxyPort,
    });
    prepareAgyOAuthVolume({
      expectedName: oauthVolumeName,
      homeDirectory: os.homedir(),
      now: new Date(),
      runContainer,
    });
    state.volumeCreated = true;

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
    requireContainerSuccess(buildAgyR15ClientCreateArgs({
      bootstrapHostPort,
      bootstrapNonce,
      clientName: names.client,
      networkName: names.network,
      networkPrefix,
      oauthVolumeName,
      profileHash: AGY_R15_AUTH_PROFILE_HASH,
      proxyPort: PROXY_PORT,
      runId,
    }), "AGY_R15_AUTH_CLIENT_CREATE_FAILED");
    state.clientCreated = true;

    state.attachedChild = createAttachedChild(names.client);
    state.removeSignalHandlers = forwardTerminalSignals(state.attachedChild);
    const childDone = waitForChild(state.attachedChild);
    const clientIPv4 = await waitForExactIPv4({
      attachedChild: state.attachedChild,
      name: names.client,
      networkName: names.network,
      parse: parseAgyR15ContainerIPv4,
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
    state.handoffCompleted = true;

    const childResult = await childDone;
    outcome = {
      authenticationVerified: false,
      event: "agy_r15_auth_terminal_closed",
      exitCode: childResult.exitCode,
      oauthVolumeName,
      signal: childResult.signal,
      spawnFailed: childResult.spawnFailed,
      volumePreservedForVerification: true,
    };
  } catch (error) {
    if (state.attachedChild && state.attachedChild.exitCode === null) {
      state.attachedChild.kill("SIGTERM");
    }
    outcome = {
      event: "agy_r15_auth_session_failed",
      oauthVolumeName: state.handoffCompleted ? oauthVolumeName : null,
      reason: error?.code || "AGY_R15_AUTH_UNKNOWN_FAILURE",
      volumePreservedForVerification: state.handoffCompleted,
    };
  }

  state.removeSignalHandlers?.();

  const cleanup = {
    bridge: true,
    client: !state.clientCreated || stopAndDeleteExactContainer(names.client),
    proxy: !state.proxyCreated || stopAndDeleteExactContainer(names.proxy),
    volume: null,
  };
  if (state.hostProxyBridge) {
    try {
      await state.hostProxyBridge.close();
    } catch {
      cleanup.bridge = false;
    }
  }
  if (state.volumeCreated && !state.handoffCompleted) {
    cleanup.volume = deleteExactVolume(oauthVolumeName);
  }
  const runtimeResourcesCleaned = cleanup.bridge && cleanup.client && cleanup.proxy &&
    (cleanup.volume === null || cleanup.volume === true);
  writePublicEvent(
    outcome.event === "agy_r15_auth_session_failed" ? process.stderr : process.stdout,
    { ...outcome, runtimeResourcesCleaned }
  );
  if (outcome.event === "agy_r15_auth_session_failed" || !runtimeResourcesCleaned) {
    process.exitCode = 70;
  }
}

main().catch((error) => {
  writePublicEvent(process.stderr, {
    event: "agy_r15_auth_session_refused",
    findings: Array.isArray(error?.findings) ? error.findings : [],
    reason: error?.code || "AGY_R15_AUTH_UNKNOWN_FAILURE",
  });
  process.exitCode = error?.code === "AGY_R15_AUTH_ARGUMENTS_INVALID" ||
    error?.code === "AGY_R15_SCOPE_ACK_REQUIRED" ||
    error?.code === "AGY_R15_DIRECT_TTY_REQUIRED"
    ? 64
    : 70;
});
