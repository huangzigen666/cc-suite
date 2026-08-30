import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildAgyHostGatewayProbeArgs,
  buildAgyHostGatewayProxyUrl,
  buildAgyLoopbackProxyConfig,
  createAgyHostGatewayBridge,
  runAgyHostGatewayProbe,
} from "../scripts/lib/agy-host-gateway-bridge.mjs";

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

test("R16 gateway bridge accepts only one exact loopback system proxy", () => {
  assert.deepEqual(buildAgyLoopbackProxyConfig({ scutilProxy: VALID_SCUTIL }), {
    contractSource: "system-settings",
    hostProxyIPv4: "127.0.0.1",
    hostProxyPort: 7892,
  });
  for (const invalid of [
    VALID_SCUTIL.replace("HTTPEnable : 1", "HTTPEnable : 0"),
    VALID_SCUTIL.replace("HTTPSPort : 7892", "HTTPSPort : 7893"),
    VALID_SCUTIL.replaceAll("127.0.0.1", "0.0.0.0"),
  ]) {
    assert.throws(
      () => buildAgyLoopbackProxyConfig({ scutilProxy: invalid }),
      (error) => error.code === "AGY_R16_HOST_PROXY_SETTINGS_INVALID"
    );
  }
});

test("R16 gateway bridge accepts one exact inherited proxy contract without forwarding it", () => {
  const environment = {
    HTTP_PROXY: "http://127.0.0.1:7892",
    HTTPS_PROXY: "http://127.0.0.1:7892",
    ALL_PROXY: "http://127.0.0.1:7892",
  };
  assert.deepEqual(buildAgyLoopbackProxyConfig({
    environment,
    scutilProxy: "<dictionary> {\n}\n",
  }), {
    contractSource: "process-environment",
    hostProxyIPv4: "127.0.0.1",
    hostProxyPort: 7892,
  });
  assert.throws(
    () => buildAgyLoopbackProxyConfig({
      environment: { ...environment, HTTPS_PROXY: "http://127.0.0.1:7893" },
      scutilProxy: "<dictionary> {\n}\n",
    }),
    (error) => error.code === "AGY_R16_HOST_PROXY_SETTINGS_INVALID"
  );
  assert.throws(
    () => buildAgyLoopbackProxyConfig({
      environment: { ...environment, ALL_PROXY: "http://user:secret@127.0.0.1:7892" },
      scutilProxy: "<dictionary> {\n}\n",
    }),
    (error) => error.code === "AGY_R16_HOST_PROXY_SETTINGS_INVALID"
  );
  assert.throws(
    () => buildAgyLoopbackProxyConfig({ environment, scutilProxy: VALID_SCUTIL.replaceAll("7892", "7893") }),
    (error) => error.code === "AGY_R16_HOST_PROXY_SETTINGS_CONFLICT"
  );
});

test("R16 gateway endpoint and probe are exact and credential-free", () => {
  assert.equal(
    buildAgyHostGatewayProxyUrl("172.30.251.1", 49152),
    "http://172.30.251.1:49152"
  );
  const args = buildAgyHostGatewayProbeArgs({
    proxyName: "cc-suite-agy-r16-proxy-0123456789ab",
    redirectIPv4: "172.30.251.1",
    redirectPort: 49152,
  });
  assert.deepEqual(args.slice(0, 3), [
    "exec",
    "cc-suite-agy-r16-proxy-0123456789ab",
    "/usr/local/bin/node",
  ]);
  assert.equal(args.at(-2), "172.30.251.1");
  assert.equal(args.at(-1), "49152");
  assert.match(args.join(" "), /oauth2\.googleapis\.com/);
  assert.equal(/token|authorization|cookie|bearer/i.test(args.join(" ")), false);

  for (const invalid of [
    ["8.8.8.8", 49152],
    ["172.30.251.1", 80],
  ]) {
    assert.throws(
      () => buildAgyHostGatewayProxyUrl(invalid[0], invalid[1]),
      (error) => error.code === "AGY_R16_HOST_GATEWAY_INVALID"
    );
  }
});

test("R16 gateway probe is asynchronous, bounded, and retains no output", async () => {
  const args = buildAgyHostGatewayProbeArgs({
    proxyName: "cc-suite-agy-r16-proxy-0123456789ab",
    redirectIPv4: "172.30.251.1",
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
      child.stdout.end("bounded output");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyHostGatewayProbe({
    args,
    environment: { HOME: "/tmp/host-home", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
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
      if (["ECONNREFUSED", "ECONNRESET"].includes(error.code)) finish(data);
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

test("R16 gateway bridge denies every source until one private proxy IP is locked", async () => {
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
  let observedSource = "127.0.0.1";
  const bridge = await createAgyHostGatewayBridge({
    getRemoteAddress: () => observedSource,
    hostProxyIPv4: "127.0.0.1",
    hostProxyPort: upstreamPort,
    logger: (event) => events.push(event),
  });
  const listenPort = bridge.listenPort;
  try {
    assert.equal(bridge.listenIPv4, "0.0.0.0");
    assert.equal(await connectOnce(listenPort, "denied-before-lock"), "");
    assert.throws(
      () => bridge.authorizeClientIPv4("8.8.8.8"),
      (error) => error.code === "AGY_R16_HOST_GATEWAY_CLIENT_INVALID"
    );
    bridge.authorizeClientIPv4("172.30.251.3");
    assert.equal(await connectOnce(listenPort, "denied-wrong-source"), "");
    observedSource = "172.30.251.3";
    assert.equal(await connectOnce(listenPort, "allowed"), "allowed");
    assert.throws(
      () => bridge.authorizeClientIPv4("172.30.251.4"),
      (error) => error.code === "AGY_R16_HOST_GATEWAY_CLIENT_LOCKED"
    );
  } finally {
    await bridge.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
  assert.equal(await connectOnce(listenPort), "");
  assert.equal(events.filter((event) => event.event === "agy_host_gateway_ready").length, 1);
  assert.equal(events.filter((event) => event.event === "agy_host_gateway_denied").length, 2);
  assert.equal(events.filter((event) => event.event === "agy_host_gateway_tunnel_opened").length, 1);
  assert.equal(events.filter((event) => event.event === "agy_host_gateway_stopped").length, 1);
  assert.equal(JSON.stringify(events).includes("allowed"), false);
});
