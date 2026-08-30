import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AGY_HOST_PROXY_DOMAIN,
  AGY_HOST_PROXY_REDIRECT_IPV4,
  auditAgyHostProxyContainerInventory,
  buildAgyHostProxyBridgeConfig,
  createAgyHostProxyBridge,
  buildAgyHostProxyProbeArgs,
  runAgyHostProxyProbe,
} from "../scripts/lib/agy-host-proxy-bridge.mjs";

const VALID_SCUTIL = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7892
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7892
  HTTPSProxy : 127.0.0.1
}
`;

test("R15 host proxy bridge accepts one exact credential-free loopback proxy", () => {
  assert.deepEqual(buildAgyHostProxyBridgeConfig({
    dnsList: `DOMAIN\n${AGY_HOST_PROXY_DOMAIN}\n`,
    scutilProxy: VALID_SCUTIL,
  }), {
    domain: AGY_HOST_PROXY_DOMAIN,
    redirectIPv4: AGY_HOST_PROXY_REDIRECT_IPV4,
    hostProxyIPv4: "127.0.0.1",
    hostProxyPort: 7892,
  });
});

test("R15 host proxy bridge refuses missing PF domain or loose proxy settings", () => {
  for (const [overrides, finding] of [
    [{ dnsList: "DOMAIN\n" }, "AGY_R15_HOST_PROXY_DOMAIN_REQUIRED"],
    [{ scutilProxy: VALID_SCUTIL.replaceAll("127.0.0.1", "0.0.0.0") },
      "AGY_R15_HOST_PROXY_SETTINGS_INVALID"],
    [{ scutilProxy: VALID_SCUTIL.replace("HTTPSPort : 7892", "HTTPSPort : 7893") },
      "AGY_R15_HOST_PROXY_SETTINGS_INVALID"],
    [{ scutilProxy: VALID_SCUTIL.replace("HTTPEnable : 1", "HTTPEnable : 0") },
      "AGY_R15_HOST_PROXY_SETTINGS_INVALID"],
  ]) {
    assert.throws(
      () => buildAgyHostProxyBridgeConfig({
        dnsList: `DOMAIN\n${AGY_HOST_PROXY_DOMAIN}\n`,
        scutilProxy: VALID_SCUTIL,
        ...overrides,
      }),
      (error) => error.code === finding
    );
  }
});

test("R15 host proxy bridge requires an otherwise empty Apple Container runtime", () => {
  assert.deepEqual(auditAgyHostProxyContainerInventory("[]"), {
    ready: true,
    findings: [],
  });
  for (const raw of [
    "not-json",
    JSON.stringify([{ id: "foreign-container" }]),
    JSON.stringify({ containers: [] }),
  ]) {
    const result = auditAgyHostProxyContainerInventory(raw);
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes("AGY_R15_HOST_PROXY_RUNTIME_NOT_EMPTY"));
  }
});

test("R15 host proxy probe is fixed, credential-free, and runs inside the exact proxy capsule", () => {
  const args = buildAgyHostProxyProbeArgs({
    proxyName: "cc-suite-agy-r15-proxy-0123456789ab",
    redirectIPv4: AGY_HOST_PROXY_REDIRECT_IPV4,
    redirectPort: 49152,
  });
  assert.deepEqual(args.slice(0, 3), [
    "exec",
    "cc-suite-agy-r15-proxy-0123456789ab",
    "/usr/local/bin/node",
  ]);
  assert.equal(args.at(-2), AGY_HOST_PROXY_REDIRECT_IPV4);
  assert.equal(args.at(-1), "49152");
  const flattened = args.join(" ");
  assert.match(flattened, /oauth2\.googleapis\.com/);
  assert.equal(/token|authorization|cookie|bearer/i.test(flattened), false);

  assert.throws(
    () => buildAgyHostProxyProbeArgs({
      proxyName: "latest",
      redirectIPv4: AGY_HOST_PROXY_REDIRECT_IPV4,
      redirectPort: 49152,
    }),
    (error) => error.code === "AGY_R15_HOST_PROXY_PROBE_SCOPE_INVALID"
  );
});

test("R15 host proxy probe is asynchronous, bounded, and retains no output", async () => {
  const args = buildAgyHostProxyProbeArgs({
    proxyName: "cc-suite-agy-r15-proxy-0123456789ab",
    redirectIPv4: AGY_HOST_PROXY_REDIRECT_IPV4,
    redirectPort: 49152,
  });
  let observed;
  const spawnProcess = (command, childArgs, options) => {
    observed = { command, childArgs, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.write("unexpected but bounded output");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyHostProxyProbe({
    args,
    environment: {
      HOME: "/tmp/host-home",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    },
    spawnProcess,
  });
  assert.deepEqual(result, {
    outputTooLarge: false,
    ready: true,
    signal: null,
    spawnFailed: false,
    status: 0,
    timedOut: false,
  });
  assert.equal(observed.command, "container");
  assert.deepEqual(observed.childArgs, args);
  assert.equal(observed.options.shell, false);
  assert.deepEqual(observed.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(Object.hasOwn(result, "stdout"), false);
  assert.equal(Object.hasOwn(result, "stderr"), false);
});

function connectOnce(port, payload = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      if (error.code === "ECONNRESET") finish(data);
      else reject(error);
    });
    socket.on("data", (chunk) => {
      data += chunk;
      if (payload && data.length >= payload.length) socket.end();
    });
    socket.once("close", () => finish(data));
    socket.once("connect", () => {
      if (payload) socket.write(payload);
      else socket.end();
    });
  });
}

test("R15 host proxy bridge rejects every source except the exact proxy capsule IPv4", async () => {
  const events = [];
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const upstreamPort = upstream.address().port;

  let observedSource = "192.168.65.2";
  const bridge = await createAgyHostProxyBridge({
    getRemoteAddress: () => observedSource,
    hostProxyIPv4: "127.0.0.1",
    hostProxyPort: upstreamPort,
    logger: (event) => events.push(event),
  });
  try {
    assert.throws(
      () => bridge.authorizeClientIPv4("8.8.8.8"),
      (error) => error.code === "AGY_R15_HOST_PROXY_CLIENT_INVALID"
    );
    bridge.authorizeClientIPv4("192.168.65.3");
    assert.equal(await connectOnce(bridge.listenPort, "denied"), "");

    observedSource = "192.168.65.3";
    assert.equal(await connectOnce(bridge.listenPort, "allowed"), "allowed");
    assert.throws(
      () => bridge.authorizeClientIPv4("192.168.65.4"),
      (error) => error.code === "AGY_R15_HOST_PROXY_CLIENT_LOCKED"
    );

    assert.equal(events.some((event) => event.event === "agy_host_proxy_denied"), true);
    assert.equal(events.some((event) => event.event === "agy_host_proxy_tunnel_opened"), true);
    assert.equal(JSON.stringify(events).includes("allowed"), false);
    assert.equal(JSON.stringify(events).includes("denied"), true);
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
