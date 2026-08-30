import { spawn as spawnChild } from "node:child_process";
import net from "node:net";

const MAX_TUNNELS = 16;
const CONNECT_TIMEOUT_MS = 8000;
const PROBE_MAX_OUTPUT_BYTES = 4096;
const PROBE_TIMEOUT_MS = 20_000;
const PROXY_NAME_PATTERN = /^cc-suite-agy-r16-proxy-[a-f0-9]{12}$/;

const HOST_GATEWAY_PROBE_SOURCE = [
  "const dns=require('node:dns').promises;",
  "const net=require('node:net');",
  "const host=process.argv[1];",
  "const port=Number(process.argv[2]);",
  "(async()=>{",
  "const ips=await dns.resolve4('oauth2.googleapis.com');",
  "if(ips.length!==1||net.isIP(ips[0])!==4)throw new Error('dns');",
  "await new Promise((resolve,reject)=>{",
  "const socket=net.connect({host,port,family:4});",
  "let response='';",
  "const timer=setTimeout(()=>{socket.destroy();reject(new Error('timeout'));},8000);",
  "socket.once('error',reject);",
  "socket.once('connect',()=>socket.write(`CONNECT ${ips[0]}:443 HTTP/1.1\\r\\nHost: ${ips[0]}:443\\r\\n\\r\\n`));",
  "socket.on('data',chunk=>{",
  "response+=chunk.toString('ascii');",
  "if(response.length>4096){socket.destroy();reject(new Error('large'));return;}",
  "if(response.includes('\\r\\n\\r\\n')){",
  "clearTimeout(timer);socket.destroy();",
  "if(/^HTTP\\/1\\.[01] 200 /.test(response))resolve();else reject(new Error('status'));",
  "}",
  "});",
  "});",
  "})().catch(()=>{process.exitCode=70;});",
].join("");

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedIPv4(value) {
  if (typeof value !== "string") return null;
  const candidate = value.startsWith("::ffff:") ? value.slice(7) : value;
  return net.isIP(candidate) === 4 ? candidate : null;
}

function privateIPv4(value) {
  const candidate = normalizedIPv4(value);
  if (!candidate) return false;
  const [first, second] = candidate.split(".").map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function parseScutilProxy(raw) {
  const values = new Map();
  const allowedKeys = new Set([
    "HTTPEnable",
    "HTTPPort",
    "HTTPProxy",
    "HTTPSEnable",
    "HTTPSPort",
    "HTTPSProxy",
  ]);
  for (const line of String(raw || "").split("\n")) {
    const match = /^\s*([A-Za-z]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (!match || !allowedKeys.has(match[1])) continue;
    if (values.has(match[1])) {
      throw gatewayError(
        "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
        "host proxy setting is duplicated"
      );
    }
    values.set(match[1], match[2]);
  }
  const httpPort = Number(values.get("HTTPPort"));
  const httpsPort = Number(values.get("HTTPSPort"));
  if (
    values.get("HTTPEnable") !== "1" ||
    values.get("HTTPSEnable") !== "1" ||
    values.get("HTTPProxy") !== "127.0.0.1" ||
    values.get("HTTPSProxy") !== "127.0.0.1" ||
    !Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535 ||
    httpsPort !== httpPort
  ) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
      "one exact credential-free loopback HTTP(S) proxy is required"
    );
  }
  return { hostProxyIPv4: "127.0.0.1", hostProxyPort: httpPort };
}

function parseEnvironmentProxy(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
      "proxy environment is invalid"
    );
  }
  const urls = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].map((key) => {
    const raw = environment[key];
    if (typeof raw !== "string" || raw.length < 1 || raw.length > 2048) {
      throw gatewayError(
        "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
        "one exact credential-free loopback proxy environment is required"
      );
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw gatewayError(
        "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
        "proxy environment URL is invalid"
      );
    }
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username !== "" || parsed.password !== "" ||
      parsed.port === "" || !Number.isInteger(Number(parsed.port)) ||
      Number(parsed.port) < 1 || Number(parsed.port) > 65535 ||
      parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    ) {
      throw gatewayError(
        "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
        "proxy environment must be one credential-free loopback HTTP endpoint"
      );
    }
    return parsed;
  });
  if (urls.some((value) => value.href !== urls[0].href)) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
      "proxy environment endpoints do not match"
    );
  }
  return { hostProxyIPv4: "127.0.0.1", hostProxyPort: Number(urls[0].port) };
}

export function buildAgyLoopbackProxyConfig({ environment, scutilProxy } = {}) {
  let systemConfig = null;
  let environmentConfig = null;
  try {
    systemConfig = parseScutilProxy(scutilProxy);
  } catch {
    systemConfig = null;
  }
  try {
    environmentConfig = parseEnvironmentProxy(environment);
  } catch {
    environmentConfig = null;
  }
  if (!systemConfig && !environmentConfig) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
      "one explicit credential-free loopback proxy contract is required"
    );
  }
  if (
    systemConfig && environmentConfig &&
    (systemConfig.hostProxyIPv4 !== environmentConfig.hostProxyIPv4 ||
      systemConfig.hostProxyPort !== environmentConfig.hostProxyPort)
  ) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_CONFLICT",
      "system and process proxy contracts conflict"
    );
  }
  const selected = systemConfig || environmentConfig;
  return {
    ...selected,
    contractSource: systemConfig ? "system-settings" : "process-environment",
  };
}

export function buildAgyHostGatewayProxyUrl(gatewayIPv4, listenPort) {
  if (
    !privateIPv4(gatewayIPv4) ||
    !Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535
  ) {
    throw gatewayError(
      "AGY_R16_HOST_GATEWAY_INVALID",
      "host gateway proxy endpoint is invalid"
    );
  }
  return `http://${gatewayIPv4}:${listenPort}`;
}

export function buildAgyHostGatewayProbeArgs({
  proxyName,
  redirectIPv4,
  redirectPort,
} = {}) {
  if (
    !PROXY_NAME_PATTERN.test(proxyName || "") ||
    !privateIPv4(redirectIPv4) ||
    !Number.isInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535
  ) {
    throw gatewayError(
      "AGY_R16_HOST_GATEWAY_PROBE_SCOPE_INVALID",
      "host gateway probe scope is invalid"
    );
  }
  return [
    "exec",
    proxyName,
    "/usr/local/bin/node",
    "-e",
    HOST_GATEWAY_PROBE_SOURCE,
    redirectIPv4,
    String(redirectPort),
  ];
}

export async function runAgyHostGatewayProbe(options = {}) {
  const {
    args,
    environment,
    spawnProcess = spawnChild,
    timeoutMs = PROBE_TIMEOUT_MS,
  } = options;
  const environmentKeys = environment && typeof environment === "object" &&
    !Array.isArray(environment)
    ? Object.keys(environment).sort()
    : [];
  let expectedArgs;
  try {
    expectedArgs = buildAgyHostGatewayProbeArgs({
      proxyName: args?.[1],
      redirectIPv4: args?.[5],
      redirectPort: Number(args?.[6]),
    });
  } catch {
    expectedArgs = null;
  }
  if (
    !Array.isArray(args) ||
    !expectedArgs ||
    JSON.stringify(args) !== JSON.stringify(expectedArgs) ||
    JSON.stringify(environmentKeys) !== JSON.stringify(["HOME", "LANG", "PATH"]) ||
    environmentKeys.some((key) => typeof environment[key] !== "string" || !environment[key]) ||
    typeof spawnProcess !== "function" ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PROBE_TIMEOUT_MS
  ) {
    throw gatewayError(
      "AGY_R16_HOST_GATEWAY_PROBE_SCOPE_INVALID",
      "host gateway probe execution scope is invalid"
    );
  }

  return new Promise((resolve) => {
    let child;
    let outputBytes = 0;
    let outputTooLarge = false;
    let spawnFailed = false;
    let status = null;
    let signal = null;
    let timedOut = false;
    let settled = false;
    let terminationTimer;
    let timeoutTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      resolve({
        outputTooLarge,
        ready: !outputTooLarge && !spawnFailed && !timedOut && status === 0,
        signal,
        spawnFailed,
        status,
        timedOut,
      });
    };
    const terminate = () => {
      child?.kill("SIGKILL");
      terminationTimer = setTimeout(finish, 1000);
    };
    const countOutput = (chunk) => {
      if (outputTooLarge) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > PROBE_MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        terminate();
      }
    };

    try {
      child = spawnProcess("container", args, {
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", countOutput);
      child.stderr.on("data", countOutput);
      child.once("error", () => {
        spawnFailed = true;
        finish();
      });
      child.once("close", (exitCode, exitSignal) => {
        status = exitCode;
        signal = exitSignal;
        finish();
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    } catch {
      spawnFailed = true;
      finish();
    }
  });
}

export async function createAgyHostGatewayBridge(options = {}) {
  const {
    connect = net.connect,
    getRemoteAddress = (socket) => socket.remoteAddress,
    hostProxyIPv4,
    hostProxyPort,
    logger = () => {},
  } = options;
  if (
    hostProxyIPv4 !== "127.0.0.1" ||
    !Number.isInteger(hostProxyPort) || hostProxyPort < 1 || hostProxyPort > 65535 ||
    typeof getRemoteAddress !== "function" ||
    typeof logger !== "function" ||
    typeof connect !== "function"
  ) {
    throw gatewayError(
      "AGY_R16_HOST_PROXY_SETTINGS_INVALID",
      "host gateway bridge settings are invalid"
    );
  }

  let expectedClientIPv4 = null;
  let activeTunnels = 0;
  let closed = false;
  const sockets = new Set();
  const server = net.createServer((clientSocket) => {
    clientSocket.on("error", () => {});
    const remoteAddress = normalizedIPv4(getRemoteAddress(clientSocket));
    if (remoteAddress === null || remoteAddress !== expectedClientIPv4) {
      logger({ event: "agy_host_gateway_denied", reason: "client_ipv4_mismatch" });
      clientSocket.destroy();
      return;
    }
    if (activeTunnels >= MAX_TUNNELS) {
      logger({ event: "agy_host_gateway_denied", reason: "concurrency_limit" });
      clientSocket.destroy();
      return;
    }

    activeTunnels += 1;
    sockets.add(clientSocket);
    let upstreamSocket;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeTunnels -= 1;
      sockets.delete(clientSocket);
      if (upstreamSocket) sockets.delete(upstreamSocket);
      clientSocket.destroy();
      upstreamSocket?.destroy();
    };
    const timer = setTimeout(() => {
      logger({ event: "agy_host_gateway_failed", reason: "connect_timeout" });
      finish();
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    try {
      upstreamSocket = connect({ host: hostProxyIPv4, port: hostProxyPort, family: 4 });
      sockets.add(upstreamSocket);
      upstreamSocket.once("connect", () => {
        clearTimeout(timer);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        logger({ event: "agy_host_gateway_tunnel_opened" });
      });
      upstreamSocket.once("error", () => {
        clearTimeout(timer);
        logger({ event: "agy_host_gateway_failed", reason: "upstream_connect_failed" });
        finish();
      });
      clientSocket.once("close", finish);
      upstreamSocket.once("close", finish);
    } catch {
      clearTimeout(timer);
      logger({ event: "agy_host_gateway_failed", reason: "upstream_connect_failed" });
      finish();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const listenPort = typeof address === "object" && address ? address.port : null;
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    server.close();
    throw gatewayError(
      "AGY_R16_HOST_GATEWAY_LISTEN_INVALID",
      "host gateway bridge failed to bind an ephemeral port"
    );
  }
  logger({ event: "agy_host_gateway_ready" });

  return {
    listenIPv4: "0.0.0.0",
    listenPort,
    authorizeClientIPv4(value) {
      if (!privateIPv4(value)) {
        throw gatewayError(
          "AGY_R16_HOST_GATEWAY_CLIENT_INVALID",
          "host gateway bridge client IPv4 is invalid"
        );
      }
      if (expectedClientIPv4 !== null && expectedClientIPv4 !== value) {
        throw gatewayError(
          "AGY_R16_HOST_GATEWAY_CLIENT_LOCKED",
          "host gateway bridge client IPv4 is already locked"
        );
      }
      expectedClientIPv4 = value;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
      logger({ event: "agy_host_gateway_stopped" });
    },
  };
}
