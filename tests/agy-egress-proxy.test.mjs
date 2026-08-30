import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgyUpstreamConnectRequest,
  createAgyConnectHandler,
  loadAgyProxyPolicyFile,
  parseAgyUpstreamConnectResponse,
  resolveAgyPublicIPv4,
} from "../scripts/lib/agy-egress-proxy.mjs";
import { auditAgyProxyPolicy } from "../scripts/lib/agy-proxy-policy.mjs";

function validPolicy() {
  return {
    schemaVersion: 1,
    listen: { host: "0.0.0.0", port: 18081 },
    allowedClientIPv4: "172.30.250.3",
    allowedHosts: ["example.com"],
    upstream: null,
    limits: {
      connectTimeoutMs: 8000,
      dnsTimeoutMs: 5000,
      idleTimeoutMs: 90000,
      maxTunnelMs: 300000,
      maxConcurrentTunnels: 16,
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(marker)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

test("R14 DNS resolution pins one stable public IPv4 address", async () => {
  const calls = [];
  const result = await resolveAgyPublicIPv4("example.com", {
    timeoutMs: 100,
    resolve4: async (hostname, options) => {
      calls.push([hostname, options]);
      return [
        { address: "93.184.216.35", ttl: 60 },
        { address: "93.184.216.34", ttl: 60 },
      ];
    },
  });

  assert.equal(result.address, "93.184.216.34");
  assert.deepEqual(result.addresses, ["93.184.216.34", "93.184.216.35"]);
  assert.deepEqual(calls, [["example.com", { ttl: true }]]);
});

test("R14 rejects empty, malformed, IPv6, private, and mixed DNS answers", async () => {
  for (const answers of [
    [],
    [{ address: "not-an-ip", ttl: 60 }],
    [{ address: "2001:4860:4860::8888", ttl: 60 }],
    [{ address: "127.0.0.1", ttl: 60 }],
    [
      { address: "93.184.216.34", ttl: 60 },
      { address: "169.254.169.254", ttl: 60 },
    ],
  ]) {
    await assert.rejects(
      resolveAgyPublicIPv4("example.com", {
        timeoutMs: 100,
        resolve4: async () => answers,
      }),
      (error) => error.code === "AGY_PROXY_DNS_DENIED"
    );
  }
});

test("R14 bounds DNS lookup time", async () => {
  await assert.rejects(
    resolveAgyPublicIPv4("example.com", {
      timeoutMs: 10,
      resolve4: async () => new Promise(() => {}),
    }),
    (error) => error.code === "AGY_PROXY_DNS_TIMEOUT"
  );
});

test("R14 upstream CONNECT pins the resolved IP and never forwards the hostname", () => {
  const request = buildAgyUpstreamConnectRequest("93.184.216.34", 443);

  assert.equal(
    request,
    "CONNECT 93.184.216.34:443 HTTP/1.1\r\n" +
      "Host: 93.184.216.34:443\r\n" +
      "Proxy-Connection: Keep-Alive\r\n\r\n"
  );
  assert.equal(request.includes("example.com"), false);
  assert.throws(
    () => buildAgyUpstreamConnectRequest("127.0.0.1", 443),
    (error) => error.code === "AGY_PROXY_UPSTREAM_TARGET_INVALID"
  );
});

test("R14 loads only a small, owned, single-link, private regular policy file", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r14-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, "policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(validPolicy())}\n`, { mode: 0o600 });

  const loaded = await loadAgyProxyPolicyFile(policyPath, {
    expectedListenHost: "0.0.0.0",
    expectedClientIPv4: "172.30.250.3",
  });
  assert.equal(loaded.ready, true);
  assert.deepEqual(loaded.policy.allowedHosts, ["example.com"]);

  fs.chmodSync(policyPath, 0o644);
  await assert.rejects(
    loadAgyProxyPolicyFile(policyPath, {
      expectedListenHost: "0.0.0.0",
      expectedClientIPv4: "172.30.250.3",
    }),
    (error) => error.code === "AGY_PROXY_POLICY_FILE_MODE_INVALID"
  );
});

test("R14 rejects symlinked, hard-linked, relative, and oversized policy files", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r14-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, "policy.json");
  const hardLinkPath = path.join(directory, "policy-hardlink.json");
  const symlinkPath = path.join(directory, "policy-symlink.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(validPolicy())}\n`, { mode: 0o600 });
  fs.linkSync(policyPath, hardLinkPath);
  fs.symlinkSync(policyPath, symlinkPath);

  await assert.rejects(
    loadAgyProxyPolicyFile("policy.json", {
      expectedListenHost: "0.0.0.0",
      expectedClientIPv4: "172.30.250.3",
    }),
    (error) => error.code === "AGY_PROXY_POLICY_PATH_INVALID"
  );
  await assert.rejects(
    loadAgyProxyPolicyFile(symlinkPath, {
      expectedListenHost: "0.0.0.0",
      expectedClientIPv4: "172.30.250.3",
    }),
    (error) => error.code === "AGY_PROXY_POLICY_FILE_INVALID"
  );
  await assert.rejects(
    loadAgyProxyPolicyFile(hardLinkPath, {
      expectedListenHost: "0.0.0.0",
      expectedClientIPv4: "172.30.250.3",
    }),
    (error) => error.code === "AGY_PROXY_POLICY_FILE_LINK_INVALID"
  );

  fs.unlinkSync(hardLinkPath);
  fs.writeFileSync(policyPath, "x".repeat(65 * 1024), { mode: 0o600 });
  await assert.rejects(
    loadAgyProxyPolicyFile(policyPath, {
      expectedListenHost: "0.0.0.0",
      expectedClientIPv4: "172.30.250.3",
    }),
    (error) => error.code === "AGY_PROXY_POLICY_FILE_SIZE_INVALID"
  );
});

test("R14 accepts only a bounded HTTP 200 upstream CONNECT response", () => {
  assert.deepEqual(
    parseAgyUpstreamConnectResponse(
      Buffer.from("HTTP/1.1 200 Connection established\r\nProxy-Agent: local\r\n\r\nTLS")
    ),
    { complete: true, remainder: Buffer.from("TLS") }
  );
  assert.deepEqual(
    parseAgyUpstreamConnectResponse(Buffer.from("HTTP/1.1 200 OK\r\n")),
    { complete: false, remainder: null }
  );

  for (const response of [
    "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
    "HTTP/1.0 200 OK\r\n\r\n",
    "HTTP/1.1 2000 Ambiguous\r\n\r\n",
    "not-http\r\n\r\n",
  ]) {
    assert.throws(
      () => parseAgyUpstreamConnectResponse(Buffer.from(response)),
      (error) => error.code === "AGY_PROXY_UPSTREAM_RESPONSE_DENIED"
    );
  }
  assert.throws(
    () => parseAgyUpstreamConnectResponse(Buffer.alloc(16 * 1024 + 1, 65)),
    (error) => error.code === "AGY_PROXY_UPSTREAM_RESPONSE_TOO_LARGE"
  );
});

test("R14 CONNECT handler resolves once, dials the pinned IP, and preserves head bytes", async (t) => {
  const target = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  const policy = validPolicy();
  const audited = auditAgyProxyPolicy(policy, {
    expectedListenHost: "0.0.0.0",
    expectedClientIPv4: "172.30.250.3",
  });
  const dialed = [];
  const handler = createAgyConnectHandler({
    auditedPolicy: audited,
    resolvePublicIPv4: async () => ({
      address: "93.184.216.34",
      addresses: ["93.184.216.34"],
    }),
    connect: (options) => {
      dialed.push(options);
      return net.connect({ host: "127.0.0.1", port: targetPort });
    },
    getRemoteAddress: () => "172.30.250.3",
  });
  const proxy = http.createServer();
  proxy.on("connect", handler.handleConnect);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    handler.destroyAll();
    await close(proxy);
    await close(target);
  });

  const client = net.connect({ host: "127.0.0.1", port: proxyPort });
  client.write(
    "CONNECT example.com:443 HTTP/1.1\r\n" +
      "Host: example.com:443\r\n\r\nEARLY"
  );
  const response = await readUntil(client, Buffer.from("EARLY"));
  client.end();

  assert.match(response.toString("latin1"), /^HTTP\/1\.1 200 Connection Established/);
  assert.equal(response.subarray(response.indexOf("\r\n\r\n") + 4).toString(), "EARLY");
  assert.deepEqual(dialed, [{ host: "93.184.216.34", port: 443, family: 4 }]);
});

test("R14 CONNECT handler rejects unlisted hosts and proxy credentials before DNS or dial", async (t) => {
  const policy = validPolicy();
  const audited = auditAgyProxyPolicy(policy, {
    expectedListenHost: "0.0.0.0",
    expectedClientIPv4: "172.30.250.3",
  });
  let resolveCalls = 0;
  let connectCalls = 0;
  const handler = createAgyConnectHandler({
    auditedPolicy: audited,
    resolvePublicIPv4: async () => {
      resolveCalls += 1;
      return { address: "93.184.216.34", addresses: ["93.184.216.34"] };
    },
    connect: () => {
      connectCalls += 1;
      throw new Error("must not dial");
    },
    getRemoteAddress: () => "172.30.250.3",
  });
  const proxy = http.createServer();
  proxy.on("connect", handler.handleConnect);
  const proxyPort = await listen(proxy);
  t.after(async () => {
    handler.destroyAll();
    await close(proxy);
  });

  for (const request of [
    "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n",
    "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n\r\n",
  ]) {
    const client = net.connect({ host: "127.0.0.1", port: proxyPort });
    client.write(request);
    const response = await readUntil(client, Buffer.from("\r\n\r\n"));
    client.destroy();
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 403 Forbidden/);
  }

  assert.equal(resolveCalls, 0);
  assert.equal(connectCalls, 0);
});
