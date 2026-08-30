import net from "node:net";

import { AGY_HOST_PROXY_NETWORK } from "./agy-host-proxy-bridge.mjs";

export const AGY_R15_IMAGE_DIGESTS = Object.freeze({
  "cc-suite/agy-r14-capsule:1.1.11":
    "sha256:97f32d395735445e4157793d8258d5e84787e9dd4d60c637da05ff0ad36bb815",
  "cc-suite/agy-r15-egress:probe":
    "sha256:b7b08812eea3032da58535c6431527162d064ebc4366b9628f18ba6fe99035eb",
});

export const AGY_R15_IMAGE_VARIANT_DIGESTS = Object.freeze({
  "cc-suite/agy-r14-capsule:1.1.11":
    "sha256:ed0e9126c7ebef384a98cb9cde55ee7957b27fd20ce5350bffd7960537da5d71",
  "cc-suite/agy-r15-egress:probe":
    "sha256:d054b8f8ad273893f761f8c508f704470c678e5feaf7f6ebf9a2c4c9d9dbe31c",
});

const RESOURCE_SUFFIX_PATTERN = /^[a-f0-9]{12}$/;
const CLIENT_NAME_PATTERN = /^cc-suite-agy-r15-auth-[a-f0-9]{12}$/;
const PROXY_NAME_PATTERN = /^cc-suite-agy-r15-proxy-[a-f0-9]{12}$/;
const VERIFICATION_CLIENT_NAME_PATTERN =
  /^cc-suite-agy-r15-(?:models|request)-[a-f0-9]{12}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseSingleDescriptor(rawJson, code) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw sessionError(code, "descriptor JSON is invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null ||
      typeof parsed[0] !== "object" || Array.isArray(parsed[0])) {
    throw sessionError(code, "descriptor cardinality is invalid");
  }
  return parsed[0];
}

export function auditAgyR15Consent(argv, tty = {}) {
  const findings = [];
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string") ||
      argv.length > 2 || argv.some((value, index) => value !== [
        "--acknowledge-cloud-platform-scope",
        "--acknowledge-host-proxy-bridge",
      ][index])) {
    findings.push("AGY_R15_AUTH_ARGUMENTS_INVALID");
  } else if (!argv.includes("--acknowledge-cloud-platform-scope")) {
    findings.push("AGY_R15_SCOPE_ACK_REQUIRED");
  } else if (!argv.includes("--acknowledge-host-proxy-bridge")) {
    findings.push("AGY_R15_HOST_PROXY_ACK_REQUIRED");
  }
  if (tty.stdin !== true || tty.stdout !== true || tty.stderr !== true) {
    findings.push("AGY_R15_DIRECT_TTY_REQUIRED");
  }
  return { ready: findings.length === 0, findings };
}

export function buildAgyR15ResourceNames(suffix) {
  if (!RESOURCE_SUFFIX_PATTERN.test(suffix || "")) {
    throw sessionError(
      "AGY_R15_RESOURCE_SUFFIX_INVALID",
      "R15 resource suffix is invalid"
    );
  }
  return {
    client: `cc-suite-agy-r15-auth-${suffix}`,
    network: AGY_HOST_PROXY_NETWORK,
    proxy: `cc-suite-agy-r15-proxy-${suffix}`,
  };
}

export function parseAgyR15NetworkPrefix(rawJson, expectedName) {
  if (expectedName !== AGY_HOST_PROXY_NETWORK) {
    throw sessionError("AGY_R15_NETWORK_AUDIT_FAILED", "network scope is invalid");
  }
  const descriptor = parseSingleDescriptor(rawJson, "AGY_R15_NETWORK_AUDIT_FAILED");
  const configuration = descriptor.configuration;
  const status = descriptor.status;
  const labels = configuration?.labels;
  const labelKeys = labels && typeof labels === "object" && !Array.isArray(labels)
    ? Object.keys(labels).sort()
    : [];
  const subnetMatch = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(
    status?.ipv4Subnet || ""
  );
  const prefix = subnetMatch?.[1];
  const privateCandidate = prefix ? `${prefix}.1` : "";
  const gatewayExpected = prefix ? `${prefix}.1` : "";
  const exactLabels = labelKeys.length === 1 &&
    labelKeys[0] === "com.apple.container.resource.role" &&
    labels["com.apple.container.resource.role"] === "builtin";
  if (
    descriptor.id !== expectedName ||
    configuration?.name !== expectedName ||
    configuration?.mode !== "nat" ||
    configuration?.plugin !== "container-network-vmnet" ||
    !exactLabels ||
    !prefix ||
    net.isIP(privateCandidate) !== 4 ||
    !privateCandidate.startsWith("10.") &&
      !/^172\.(?:1[6-9]|2\d|3[01])\./.test(privateCandidate) &&
      !privateCandidate.startsWith("192.168.") ||
    status?.ipv4Gateway !== gatewayExpected
  ) {
    throw sessionError("AGY_R15_NETWORK_AUDIT_FAILED", "network audit failed");
  }
  return prefix;
}

function parseExactContainerIPv4(rawJson, expectedName, expectedNetwork, namePattern) {
  if (!namePattern.test(expectedName || "") ||
      expectedNetwork !== AGY_HOST_PROXY_NETWORK) {
    throw sessionError(
      "AGY_R15_CLIENT_NETWORK_AUDIT_FAILED",
      "client network scope is invalid"
    );
  }
  const descriptor = parseSingleDescriptor(
    rawJson,
    "AGY_R15_CLIENT_NETWORK_AUDIT_FAILED"
  );
  const networks = descriptor.status?.networks;
  const address = Array.isArray(networks) && networks.length === 1
    ? networks[0]?.ipv4Address
    : null;
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/24$/.exec(address || "");
  const ipv4 = match?.[1];
  if (
    descriptor.id !== expectedName ||
    descriptor.status?.state !== "running" ||
    !Array.isArray(networks) || networks.length !== 1 ||
    networks[0]?.network !== expectedNetwork ||
    !ipv4 || net.isIP(ipv4) !== 4
  ) {
    throw sessionError(
      "AGY_R15_CLIENT_NETWORK_AUDIT_FAILED",
      "client network audit failed"
    );
  }
  return ipv4;
}

export function parseAgyR15ContainerIPv4(rawJson, expectedName, expectedNetwork) {
  return parseExactContainerIPv4(
    rawJson,
    expectedName,
    expectedNetwork,
    CLIENT_NAME_PATTERN
  );
}

export function parseAgyR15ProxyIPv4(rawJson, expectedName, expectedNetwork) {
  return parseExactContainerIPv4(
    rawJson,
    expectedName,
    expectedNetwork,
    PROXY_NAME_PATTERN
  );
}

export function parseAgyR15VerificationClientIPv4(
  rawJson,
  expectedName,
  expectedNetwork
) {
  return parseExactContainerIPv4(
    rawJson,
    expectedName,
    expectedNetwork,
    VERIFICATION_CLIENT_NAME_PATTERN
  );
}

export function auditAgyR15Images(rawJson) {
  const findings = [];
  let descriptors;
  try {
    descriptors = JSON.parse(rawJson);
  } catch {
    return { ready: false, findings: ["AGY_R15_IMAGE_INSPECT_JSON_INVALID"] };
  }
  const expectedNames = Object.keys(AGY_R15_IMAGE_DIGESTS).sort();
  if (!Array.isArray(descriptors) || descriptors.length !== expectedNames.length) {
    return { ready: false, findings: ["AGY_R15_IMAGE_SET_INVALID"] };
  }
  const byName = new Map();
  for (const descriptor of descriptors) {
    const name = descriptor?.configuration?.name;
    if (typeof name !== "string" || byName.has(name)) {
      if (!findings.includes("AGY_R15_IMAGE_SET_INVALID")) {
        findings.push("AGY_R15_IMAGE_SET_INVALID");
      }
      continue;
    }
    byName.set(name, descriptor);
  }
  for (const name of expectedNames) {
    const descriptor = byName.get(name);
    const indexDigest = descriptor?.configuration?.descriptor?.digest;
    if (!IMAGE_DIGEST_PATTERN.test(indexDigest || "") ||
        indexDigest !== AGY_R15_IMAGE_DIGESTS[name]) {
      if (!findings.includes("AGY_R15_IMAGE_DIGEST_MISMATCH")) {
        findings.push("AGY_R15_IMAGE_DIGEST_MISMATCH");
      }
    }
    const variants = descriptor?.variants;
    const variant = Array.isArray(variants) && variants.length === 1 ? variants[0] : null;
    if (
      variant?.platform?.architecture !== "arm64" ||
      variant?.platform?.os !== "linux" ||
      !IMAGE_DIGEST_PATTERN.test(variant?.digest || "") ||
      variant?.digest !== AGY_R15_IMAGE_VARIANT_DIGESTS[name]
    ) {
      if (!findings.includes("AGY_R15_IMAGE_VARIANT_MISMATCH")) {
        findings.push("AGY_R15_IMAGE_VARIANT_MISMATCH");
      }
    }
  }
  return { ready: findings.length === 0, findings };
}

export function buildAgyR15AttachSpec(clientName) {
  if (!CLIENT_NAME_PATTERN.test(clientName || "")) {
    throw sessionError("AGY_R15_AUTH_SCOPE_INVALID", "R15 client name is invalid");
  }
  return {
    command: "container",
    args: ["start", "--attach", "--interactive", clientName],
    options: {
      shell: false,
      stdio: "inherit",
    },
  };
}
