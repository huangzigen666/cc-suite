import { randomBytes } from "node:crypto";
import path from "node:path";

export const AGY_OAUTH_VOLUME_SIZE = "256M";
export const AGY_OAUTH_VOLUME_SIZE_BYTES = 256 * 1024 * 1024;
export const AGY_OAUTH_VOLUME_LABELS = Object.freeze({
  "cc-suite.owner": "cc-suite",
  "cc-suite.purpose": "agy-oauth-state",
  "cc-suite.schema": "1",
  "cc-suite.sensitivity": "oauth",
});

const NAME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;
const APPLE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
}

function exactLabels(labels) {
  if (!isRecord(labels)) return false;
  const expected = Object.entries(AGY_OAUTH_VOLUME_LABELS).sort();
  const actual = Object.entries(labels).sort();
  return actual.length === expected.length && actual.every(
    ([key, value], index) => key === expected[index][0] && value === expected[index][1]
  );
}

function parseAppleTimestamp(value) {
  if (typeof value !== "string" || !APPLE_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value.replace("Z", ".000Z")
    ? milliseconds
    : null;
}

export function createAgyOAuthVolumeName() {
  return `cc-suite-agy-oauth-${randomBytes(8).toString("hex")}`;
}

export function buildAgyOAuthVolumeCreateArgs(name) {
  if (!NAME_PATTERN.test(name || "")) {
    const error = new Error("invalid AGY OAuth volume name");
    error.code = "AGY_OAUTH_VOLUME_NAME_INVALID";
    throw error;
  }
  return [
    "volume",
    "create",
    "--label",
    "cc-suite.owner=cc-suite",
    "--label",
    "cc-suite.purpose=agy-oauth-state",
    "--label",
    "cc-suite.schema=1",
    "--label",
    "cc-suite.sensitivity=oauth",
    "-s",
    AGY_OAUTH_VOLUME_SIZE,
    name,
  ];
}

export function auditAgyOAuthVolumeDescriptor(descriptor, expected = {}) {
  const findings = [];
  const now = expected.now instanceof Date ? expected.now.getTime() : Number.NaN;
  const expectedScopeValid =
    NAME_PATTERN.test(expected.expectedName || "") &&
    typeof expected.expectedSourceRoot === "string" &&
    path.isAbsolute(expected.expectedSourceRoot) &&
    expected.expectedSizeInBytes === AGY_OAUTH_VOLUME_SIZE_BYTES &&
    Number.isFinite(expected.maxCreationAgeMs) && expected.maxCreationAgeMs > 0 &&
    Number.isFinite(now);
  if (!expectedScopeValid) {
    addFinding(findings, "AGY_OAUTH_VOLUME_EXPECTED_SCOPE_INVALID");
  }

  if (!isRecord(descriptor) || !isRecord(descriptor.configuration)) {
    return {
      ready: false,
      findings: ["AGY_OAUTH_VOLUME_DESCRIPTOR_INVALID", ...findings],
    };
  }
  const configuration = descriptor.configuration;
  if (descriptor.id !== expected.expectedName) {
    addFinding(findings, "AGY_OAUTH_VOLUME_ID_MISMATCH");
  }
  if (configuration.name !== expected.expectedName) {
    addFinding(findings, "AGY_OAUTH_VOLUME_NAME_MISMATCH");
  }
  if (configuration.driver !== "local") {
    addFinding(findings, "AGY_OAUTH_VOLUME_DRIVER_INVALID");
  }
  if (configuration.format !== "ext4") {
    addFinding(findings, "AGY_OAUTH_VOLUME_FORMAT_INVALID");
  }
  if (!exactLabels(configuration.labels)) {
    addFinding(findings, "AGY_OAUTH_VOLUME_LABELS_INVALID");
  }
  if (
    configuration.sizeInBytes !== expected.expectedSizeInBytes ||
    configuration.options?.size !== AGY_OAUTH_VOLUME_SIZE
  ) {
    addFinding(findings, "AGY_OAUTH_VOLUME_SIZE_MISMATCH");
  }
  const expectedSource = expectedScopeValid
    ? path.join(expected.expectedSourceRoot, expected.expectedName, "volume.img")
    : null;
  if (
    expectedSource === null ||
    path.resolve(configuration.source || "") !== path.resolve(expectedSource)
  ) {
    addFinding(findings, "AGY_OAUTH_VOLUME_SOURCE_MISMATCH");
  }

  const createdAt = parseAppleTimestamp(configuration.creationDate);
  if (createdAt === null) {
    addFinding(findings, "AGY_OAUTH_VOLUME_TIME_INVALID");
  } else if (Number.isFinite(now)) {
    if (createdAt > now + 5000) {
      addFinding(findings, "AGY_OAUTH_VOLUME_TIME_FROM_FUTURE");
    }
    if (
      Number.isFinite(expected.maxCreationAgeMs) &&
      now - createdAt > expected.maxCreationAgeMs
    ) {
      addFinding(findings, "AGY_OAUTH_VOLUME_STALE");
    }
  }

  return { ready: findings.length === 0, findings };
}

function volumeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function prepareAgyOAuthVolume(options = {}) {
  const expectedName = options.expectedName;
  const runContainer = options.runContainer;
  const homeDirectory = options.homeDirectory;
  const now = options.now;
  if (
    typeof runContainer !== "function" ||
    typeof homeDirectory !== "string" ||
    !path.isAbsolute(homeDirectory) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw volumeError("AGY_OAUTH_VOLUME_PREP_SCOPE_INVALID", "volume scope is invalid");
  }

  const createArgs = buildAgyOAuthVolumeCreateArgs(expectedName);
  const created = runContainer(createArgs);
  if (created?.status !== 0) {
    throw volumeError("AGY_OAUTH_VOLUME_CREATE_FAILED", "volume creation failed");
  }

  const removeCreatedVolume = () => {
    const removed = runContainer(["volume", "delete", expectedName]);
    return removed?.status === 0;
  };

  let inspected;
  try {
    inspected = runContainer(["volume", "inspect", expectedName]);
  } catch {
    const cleanupSucceeded = removeCreatedVolume();
    const error = volumeError("AGY_OAUTH_VOLUME_INSPECT_FAILED", "volume inspection failed");
    error.cleanupSucceeded = cleanupSucceeded;
    throw error;
  }
  if (inspected?.status !== 0) {
    const cleanupSucceeded = removeCreatedVolume();
    const error = volumeError("AGY_OAUTH_VOLUME_INSPECT_FAILED", "volume inspection failed");
    error.cleanupSucceeded = cleanupSucceeded;
    throw error;
  }

  let descriptor;
  try {
    const parsed = JSON.parse(inspected.stdout);
    descriptor = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  } catch {
    const cleanupSucceeded = removeCreatedVolume();
    const error = volumeError("AGY_OAUTH_VOLUME_INSPECT_JSON_INVALID", "inspect JSON is invalid");
    error.cleanupSucceeded = cleanupSucceeded;
    throw error;
  }

  const expectedSourceRoot = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "com.apple.container",
    "volumes"
  );
  const audit = auditAgyOAuthVolumeDescriptor(descriptor, {
    expectedName,
    expectedSourceRoot,
    expectedSizeInBytes: AGY_OAUTH_VOLUME_SIZE_BYTES,
    maxCreationAgeMs: 10 * 60 * 1000,
    now,
  });
  if (!audit.ready) {
    const cleanupSucceeded = removeCreatedVolume();
    const error = volumeError("AGY_OAUTH_VOLUME_AUDIT_FAILED", "volume audit failed");
    error.findings = audit.findings;
    error.cleanupSucceeded = cleanupSucceeded;
    throw error;
  }

  return {
    ready: true,
    name: expectedName,
    findings: [],
    driver: descriptor.configuration.driver,
    format: descriptor.configuration.format,
    sizeInBytes: descriptor.configuration.sizeInBytes,
    creationDate: descriptor.configuration.creationDate,
  };
}
