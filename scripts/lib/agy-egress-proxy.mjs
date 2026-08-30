import { promises as dns } from "node:dns";
import { constants as fsConstants, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  auditAgyProxyPolicy,
  isPublicIPv4,
  parseAgyConnectAuthority,
} from "./agy-proxy-policy.mjs";

function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function compareIPv4(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export async function resolveAgyPublicIPv4(hostname, options = {}) {
  const timeoutMs = options.timeoutMs;
  const resolve4 = options.resolve4 || dns.resolve4;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw proxyError("AGY_PROXY_DNS_SCOPE_INVALID", "DNS timeout is invalid");
  }

  let timer;
  let answers;
  try {
    answers = await Promise.race([
      Promise.resolve().then(() => resolve4(hostname, { ttl: true })),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(proxyError("AGY_PROXY_DNS_TIMEOUT", "DNS lookup timed out")),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error?.code === "AGY_PROXY_DNS_TIMEOUT") throw error;
    throw proxyError("AGY_PROXY_DNS_FAILED", "DNS lookup failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (!Array.isArray(answers) || answers.length === 0) {
    throw proxyError("AGY_PROXY_DNS_DENIED", "DNS answer is empty");
  }
  const addresses = answers.map((answer) =>
    typeof answer === "string" ? answer : answer?.address
  );
  if (addresses.some((address) => !isPublicIPv4(address))) {
    throw proxyError("AGY_PROXY_DNS_DENIED", "DNS answer contains a denied address");
  }
  const unique = [...new Set(addresses)].sort(compareIPv4);
  return { address: unique[0], addresses: unique };
}

export function buildAgyUpstreamConnectRequest(address, port = 443) {
  if (!isPublicIPv4(address) || port !== 443) {
    throw proxyError(
      "AGY_PROXY_UPSTREAM_TARGET_INVALID",
      "upstream CONNECT target is invalid"
    );
  }
  const authority = `${address}:${port}`;
  return `CONNECT ${authority} HTTP/1.1\r\n` +
    `Host: ${authority}\r\n` +
    "Proxy-Connection: Keep-Alive\r\n\r\n";
}

export function parseAgyUpstreamConnectResponse(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw proxyError(
      "AGY_PROXY_UPSTREAM_RESPONSE_DENIED",
      "upstream response is invalid"
    );
  }
  if (buffer.length > 16 * 1024) {
    throw proxyError(
      "AGY_PROXY_UPSTREAM_RESPONSE_TOO_LARGE",
      "upstream response is too large"
    );
  }
  const boundary = buffer.indexOf("\r\n\r\n");
  if (boundary === -1) return { complete: false, remainder: null };

  const header = buffer.subarray(0, boundary).toString("latin1");
  const lines = header.split("\r\n");
  if (!/^HTTP\/1\.1 200(?: |$)/.test(lines[0])) {
    throw proxyError(
      "AGY_PROXY_UPSTREAM_RESPONSE_DENIED",
      "upstream CONNECT was denied"
    );
  }
  if (lines.slice(1).some((line) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t -~]*$/.test(line))) {
    throw proxyError(
      "AGY_PROXY_UPSTREAM_RESPONSE_DENIED",
      "upstream response header is invalid"
    );
  }
  return {
    complete: true,
    remainder: buffer.subarray(boundary + 4),
  };
}

export async function loadAgyProxyPolicyFile(policyPath, expectedScope) {
  if (typeof policyPath !== "string" || !path.isAbsolute(policyPath)) {
    throw proxyError("AGY_PROXY_POLICY_PATH_INVALID", "policy path must be absolute");
  }

  let handle;
  try {
    handle = await fs.open(
      policyPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
    );
  } catch {
    throw proxyError("AGY_PROXY_POLICY_FILE_INVALID", "cannot open policy file");
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw proxyError("AGY_PROXY_POLICY_FILE_INVALID", "policy is not a regular file");
    }
    if (stat.nlink !== 1) {
      throw proxyError(
        "AGY_PROXY_POLICY_FILE_LINK_INVALID",
        "policy must have exactly one link"
      );
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw proxyError("AGY_PROXY_POLICY_FILE_OWNER_INVALID", "policy owner is invalid");
    }
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o400 && permissions !== 0o600) {
      throw proxyError("AGY_PROXY_POLICY_FILE_MODE_INVALID", "policy mode is invalid");
    }
    if (stat.size < 2 || stat.size > 64 * 1024) {
      throw proxyError("AGY_PROXY_POLICY_FILE_SIZE_INVALID", "policy size is invalid");
    }

    let policy;
    try {
      policy = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw proxyError("AGY_PROXY_POLICY_JSON_INVALID", "policy JSON is invalid");
    }
    const audited = auditAgyProxyPolicy(policy, expectedScope);
    if (!audited.ready) {
      const error = proxyError("AGY_PROXY_POLICY_INVALID", "policy audit failed");
      error.findings = audited.findings;
      throw error;
    }
    return audited;
  } finally {
    await handle.close();
  }
}

function waitForConnection(options, connect, timeoutMs) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = connect(options);
    } catch {
      reject(proxyError("AGY_PROXY_CONNECT_FAILED", "connection failed"));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const fail = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(proxyError(code, "connection failed"));
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = () => fail("AGY_PROXY_CONNECT_FAILED");
    const timer = setTimeout(() => fail("AGY_PROXY_CONNECT_TIMEOUT"), timeoutMs);
    timer.unref?.();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function waitForUpstreamAcceptance(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const fail = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(proxyError(code, "upstream CONNECT failed"));
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed;
      try {
        parsed = parseAgyUpstreamConnectResponse(buffer);
      } catch (error) {
        fail(error.code || "AGY_PROXY_UPSTREAM_RESPONSE_DENIED");
        return;
      }
      if (!parsed.complete) return;
      settled = true;
      cleanup();
      resolve(parsed.remainder);
    };
    const onError = () => fail("AGY_PROXY_UPSTREAM_CONNECT_FAILED");
    const onEnd = () => fail("AGY_PROXY_UPSTREAM_EOF");
    const timer = setTimeout(
      () => fail("AGY_PROXY_UPSTREAM_RESPONSE_TIMEOUT"),
      timeoutMs
    );
    timer.unref?.();
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function deniedResponse(socket, status) {
  if (socket.destroyed) return;
  const reason = status === 403 ? "Forbidden" :
    status === 503 ? "Service Unavailable" : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n\r\n"
  );
}

export function createAgyConnectHandler(options = {}) {
  const auditedPolicy = options.auditedPolicy;
  if (
    auditedPolicy?.ready !== true ||
    typeof auditedPolicy.policyHash !== "string" ||
    auditedPolicy.policy === null
  ) {
    throw proxyError("AGY_PROXY_AUDITED_POLICY_REQUIRED", "audited policy required");
  }
  const policy = auditedPolicy.policy;
  const allowedHosts = new Set(policy.allowedHosts);
  const connect = options.connect || net.connect;
  const resolvePublicIPv4 = options.resolvePublicIPv4 || resolveAgyPublicIPv4;
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const getRemoteAddress = typeof options.getRemoteAddress === "function"
    ? options.getRemoteAddress
    : (socket) => socket.remoteAddress;
  const sockets = new Set();
  let activeTunnels = 0;

  async function dialTarget(address) {
    if (policy.upstream === null) {
      const socket = await waitForConnection(
        { host: address, port: 443, family: 4 },
        connect,
        policy.limits.connectTimeoutMs
      );
      return { socket, remainder: Buffer.alloc(0) };
    }

    const upstream = new URL(policy.upstream.url);
    const socket = await waitForConnection(
      { host: upstream.hostname, port: Number(upstream.port), family: 4 },
      connect,
      policy.limits.connectTimeoutMs
    );
    socket.write(buildAgyUpstreamConnectRequest(address, 443));
    const remainder = await waitForUpstreamAcceptance(
      socket,
      policy.limits.connectTimeoutMs
    );
    return { socket, remainder };
  }

  async function handleConnect(request, clientSocket, head) {
    clientSocket.on("error", () => {});
    const remoteAddress = getRemoteAddress(clientSocket);
    const normalizedRemoteAddress = typeof remoteAddress === "string" &&
      remoteAddress.startsWith("::ffff:")
      ? remoteAddress.slice(7)
      : remoteAddress;
    if (normalizedRemoteAddress !== policy.allowedClientIPv4) {
      logger({ event: "agy_proxy_denied", reason: "client_ipv4_mismatch" });
      deniedResponse(clientSocket, 403);
      return;
    }
    if (activeTunnels >= policy.limits.maxConcurrentTunnels) {
      logger({ event: "agy_proxy_denied", reason: "concurrency_limit" });
      deniedResponse(clientSocket, 503);
      return;
    }

    let destination;
    try {
      if (request.headers["proxy-authorization"] !== undefined) {
        throw proxyError("AGY_PROXY_CREDENTIAL_HEADER_DENIED", "credentials denied");
      }
      if (!Buffer.isBuffer(head) || head.length > 64 * 1024) {
        throw proxyError("AGY_PROXY_HEAD_INVALID", "CONNECT head is invalid");
      }
      destination = parseAgyConnectAuthority(
        request.url,
        request.headers.host,
        allowedHosts
      );
    } catch (error) {
      logger({ event: "agy_proxy_denied", reason: error.code || "request_invalid" });
      deniedResponse(clientSocket, 403);
      return;
    }

    activeTunnels += 1;
    sockets.add(clientSocket);
    let remoteSocket;
    let finished = false;
    let maxTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(maxTimer);
      activeTunnels -= 1;
      sockets.delete(clientSocket);
      if (remoteSocket) sockets.delete(remoteSocket);
      clientSocket.destroy();
      remoteSocket?.destroy();
    };

    try {
      const resolved = await resolvePublicIPv4(destination.host, {
        timeoutMs: policy.limits.dnsTimeoutMs,
      });
      if (clientSocket.destroyed) {
        throw proxyError("AGY_PROXY_CLIENT_GONE", "client disconnected");
      }
      const connected = await dialTarget(resolved.address);
      remoteSocket = connected.socket;
      sockets.add(remoteSocket);
      remoteSocket.on("error", finish);
      clientSocket.setNoDelay(true);
      remoteSocket.setNoDelay(true);
      clientSocket.setTimeout(policy.limits.idleTimeoutMs, finish);
      remoteSocket.setTimeout(policy.limits.idleTimeoutMs, finish);
      clientSocket.once("close", finish);
      remoteSocket.once("close", finish);
      maxTimer = setTimeout(finish, policy.limits.maxTunnelMs);
      maxTimer.unref?.();

      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (connected.remainder.length > 0) clientSocket.write(connected.remainder);
      if (head.length > 0) remoteSocket.write(head);
      clientSocket.pipe(remoteSocket);
      remoteSocket.pipe(clientSocket);
      logger({ event: "agy_proxy_tunnel_opened" });
    } catch (error) {
      logger({ event: "agy_proxy_failed", reason: error.code || "connect_failed" });
      remoteSocket?.destroy();
      if (!finished) {
        finished = true;
        clearTimeout(maxTimer);
        activeTunnels -= 1;
        sockets.delete(clientSocket);
        if (remoteSocket) sockets.delete(remoteSocket);
      }
      deniedResponse(clientSocket, 502);
    }
  }

  return {
    handleConnect,
    destroyAll() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    get activeTunnels() {
      return activeTunnels;
    },
  };
}
