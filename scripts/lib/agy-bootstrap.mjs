import { randomBytes } from "node:crypto";
import net from "node:net";

function bootstrapError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPrivateIPv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function createAgyBootstrapNonce() {
  return randomBytes(16).toString("hex");
}

export function buildAgyBootstrapPayload(nonce, ipv4) {
  if (!/^[a-f0-9]{32}$/.test(nonce || "") || !isPrivateIPv4(ipv4)) {
    throw bootstrapError("AGY_BOOTSTRAP_PAYLOAD_INVALID", "bootstrap payload is invalid");
  }
  return `${nonce} ${ipv4}\n`;
}

export function sendAgyBootstrap(options = {}) {
  const payload = buildAgyBootstrapPayload(options.nonce, options.ipv4);
  const port = options.port;
  const timeoutMs = options.timeoutMs ?? 5000;
  const createConnection = options.createConnection || net.createConnection;
  if (
    !Number.isInteger(port) || port < 1024 || port > 65535 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
  ) {
    return Promise.reject(
      bootstrapError("AGY_BOOTSTRAP_SCOPE_INVALID", "bootstrap scope is invalid")
    );
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => socket.end(payload));
    socket.once("error", () => {
      finish(bootstrapError("AGY_BOOTSTRAP_CONNECT_FAILED", "bootstrap failed"));
    });
    socket.once("close", (hadError) => {
      if (!hadError) finish();
    });
    timer = setTimeout(() => {
      finish(bootstrapError("AGY_BOOTSTRAP_TIMEOUT", "bootstrap timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
}
