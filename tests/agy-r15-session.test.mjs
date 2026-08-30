import assert from "node:assert/strict";
import test from "node:test";

import {
  AGY_R15_IMAGE_DIGESTS,
  AGY_R15_IMAGE_VARIANT_DIGESTS,
  auditAgyR15Consent,
  auditAgyR15Images,
  buildAgyR15AttachSpec,
  buildAgyR15ResourceNames,
  parseAgyR15ContainerIPv4,
  parseAgyR15NetworkPrefix,
  parseAgyR15ProxyIPv4,
  parseAgyR15VerificationClientIPv4,
} from "../scripts/lib/agy-r15-session.mjs";

const SUFFIX = "0123456789ab";
const NAMES = {
  client: `cc-suite-agy-r15-auth-${SUFFIX}`,
  network: "default",
  proxy: `cc-suite-agy-r15-proxy-${SUFFIX}`,
};

test("R15 requires an exact broad-scope acknowledgement and a direct TTY", () => {
  assert.deepEqual(
    auditAgyR15Consent([
      "--acknowledge-cloud-platform-scope",
      "--acknowledge-host-proxy-bridge",
    ], {
      stdin: true,
      stdout: true,
      stderr: true,
    }),
    { ready: true, findings: [] }
  );

  for (const [argv, tty, finding] of [
    [[], { stdin: true, stdout: true, stderr: true }, "AGY_R15_SCOPE_ACK_REQUIRED"],
    [["--acknowledge-cloud-platform-scope"], { stdin: true, stdout: true, stderr: true }, "AGY_R15_HOST_PROXY_ACK_REQUIRED"],
    [["--acknowledge-cloud-platform-scope", "--acknowledge-host-proxy-bridge", "--yes"], { stdin: true, stdout: true, stderr: true }, "AGY_R15_AUTH_ARGUMENTS_INVALID"],
    [["--acknowledge-cloud-platform-scope", "--acknowledge-host-proxy-bridge"], { stdin: false, stdout: true, stderr: true }, "AGY_R15_DIRECT_TTY_REQUIRED"],
  ]) {
    const result = auditAgyR15Consent(argv, tty);
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes(finding));
  }
});

test("R15 produces only exact per-session resource names", () => {
  assert.deepEqual(buildAgyR15ResourceNames(SUFFIX), NAMES);
  assert.throws(
    () => buildAgyR15ResourceNames("latest"),
    (error) => error.code === "AGY_R15_RESOURCE_SUFFIX_INVALID"
  );
});

test("R15 accepts only the exact builtin default NAT network descriptor", () => {
  const descriptor = [{
    configuration: {
      labels: {
        "com.apple.container.resource.role": "builtin",
      },
      mode: "nat",
      name: NAMES.network,
      plugin: "container-network-vmnet",
    },
    id: NAMES.network,
    status: {
      ipv4Gateway: "192.168.64.1",
      ipv4Subnet: "192.168.64.0/24",
    },
  }];
  assert.equal(parseAgyR15NetworkPrefix(JSON.stringify(descriptor), NAMES.network), "192.168.64");

  descriptor[0].configuration.labels = {};
  assert.throws(
    () => parseAgyR15NetworkPrefix(JSON.stringify(descriptor), NAMES.network),
    (error) => error.code === "AGY_R15_NETWORK_AUDIT_FAILED"
  );
});

test("R15 binds the client and proxy to exact distinct IPv4s on default", () => {
  const descriptor = [{
    id: NAMES.client,
    status: {
      state: "running",
      networks: [{
        ipv4Address: "192.168.64.2/24",
        network: NAMES.network,
      }],
    },
  }];
  assert.equal(
    parseAgyR15ContainerIPv4(JSON.stringify(descriptor), NAMES.client, NAMES.network),
    "192.168.64.2"
  );
  const proxyDescriptor = structuredClone(descriptor);
  proxyDescriptor[0].id = NAMES.proxy;
  proxyDescriptor[0].status.networks = [
    { ipv4Address: "192.168.64.3/24", network: NAMES.network },
  ];
  assert.equal(
    parseAgyR15ProxyIPv4(
      JSON.stringify(proxyDescriptor),
      NAMES.proxy,
      NAMES.network
    ),
    "192.168.64.3"
  );

  for (const mutate of [
    (value) => value[0].status.networks.push({
      ipv4Address: "192.168.66.3/24",
      network: "foreign",
    }),
  ]) {
    const invalid = structuredClone(proxyDescriptor);
    mutate(invalid);
    assert.throws(
      () => parseAgyR15ProxyIPv4(
        JSON.stringify(invalid),
        NAMES.proxy,
        NAMES.network
      ),
      (error) => error.code === "AGY_R15_CLIENT_NETWORK_AUDIT_FAILED"
    );
  }

  descriptor[0].status.networks.push({
    ipv4Address: "192.168.65.2/24",
    network: "foreign",
  });
  assert.throws(
    () => parseAgyR15ContainerIPv4(JSON.stringify(descriptor), NAMES.client, NAMES.network),
    (error) => error.code === "AGY_R15_CLIENT_NETWORK_AUDIT_FAILED"
  );
});

test("R15 binds verification phases to one exact private client address", () => {
  for (const phase of ["models", "request"]) {
    const name = `cc-suite-agy-r15-${phase}-${SUFFIX}`;
    const descriptor = [{
      id: name,
      status: {
        state: "running",
        networks: [{
          ipv4Address: "192.168.64.2/24",
          network: NAMES.network,
        }],
      },
    }];
    assert.equal(
      parseAgyR15VerificationClientIPv4(
        JSON.stringify(descriptor),
        name,
        NAMES.network
      ),
      "192.168.64.2"
    );
  }
});

test("R15 pins both local image references to the accepted R14 digests", () => {
  const descriptors = Object.entries(AGY_R15_IMAGE_DIGESTS).map(([name, digest]) => ({
    configuration: { descriptor: { digest }, name },
    variants: [{
      digest: AGY_R15_IMAGE_VARIANT_DIGESTS[name],
      platform: { architecture: "arm64", os: "linux" },
    }],
  }));
  assert.deepEqual(auditAgyR15Images(JSON.stringify(descriptors)), {
    ready: true,
    findings: [],
  });

  descriptors[0].configuration.descriptor.digest = `sha256:${"0".repeat(64)}`;
  const drift = auditAgyR15Images(JSON.stringify(descriptors));
  assert.equal(drift.ready, false);
  assert.ok(drift.findings.includes("AGY_R15_IMAGE_DIGEST_MISMATCH"));
});

test("R15 attached auth leaves OAuth bytes directly on the user's terminal", () => {
  assert.deepEqual(buildAgyR15AttachSpec(NAMES.client), {
    command: "container",
    args: ["start", "--attach", "--interactive", NAMES.client],
    options: {
      shell: false,
      stdio: "inherit",
    },
  });
});
