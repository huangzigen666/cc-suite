export const AGY_CAPSULE_CONTRACT_VERSION = 5;
export const AGY_CAPSULE_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
export const AGY_LIFECYCLE_REQUIRED_PROBE_IDS = Object.freeze([
  "lifecycle:exit-zero",
  "lifecycle:exit-nonzero",
  "lifecycle:signal",
  "lifecycle:forged-record",
  "lifecycle:descendant-drain",
  "lifecycle:missing-kill-capability",
]);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROBE_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export const AGY_CAPSULE_REQUIRED_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "external_vm_boundary",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
  }),
  Object.freeze({
    id: "workspace_mount_boundary",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
  }),
  Object.freeze({
    id: "alternate_mutators_contained",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
  }),
  Object.freeze({
    id: "host_credential_isolation",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
    requiredProbeIds: Object.freeze([
      "oauth-volume:named-ext4",
      "oauth-volume:mode-0700-uid65532",
      "oauth-volume:host-paths-absent",
      "oauth-volume:state-persists",
      "oauth-volume:missing-mount-fails",
    ]),
  }),
  Object.freeze({
    id: "off_policy_egress_blocked",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
    requiredProbeIds: Object.freeze([
      "proxy:direct-egress-blocked",
      "proxy:denied-ip-literal",
      "proxy:denied-wrong-client",
    ]),
  }),
  Object.freeze({
    id: "destination_egress_allowlist",
    acceptedAssurance: Object.freeze(["kernel-enforced", "supervisor-enforced"]),
    requiredProbeIds: Object.freeze([
      "proxy:allowed-exact-host",
      "proxy:denied-unlisted-host",
      "proxy:dns-pinned-public-ip",
      "proxy:bounded-teardown",
    ]),
  }),
  Object.freeze({
    id: "inbound_unpublished",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
    requiredProbeIds: Object.freeze([
      "bootstrap:loopback-only",
      "bootstrap:ingress-removed",
    ]),
  }),
  Object.freeze({
    id: "host_routable_listener_blocked",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
  }),
  Object.freeze({
    id: "workload_privilege_drop",
    acceptedAssurance: Object.freeze(["kernel-enforced"]),
    requiredProbeIds: Object.freeze([
      "bootstrap:quarantine-before-handoff",
    ]),
  }),
  Object.freeze({
    id: "lifecycle_attribution",
    acceptedAssurance: Object.freeze(["supervisor-enforced"]),
    requiredProbeIds: AGY_LIFECYCLE_REQUIRED_PROBE_IDS,
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function addFinding(findings, finding) {
  if (!findings.includes(finding)) findings.push(finding);
}

export function createPendingAgyCapsuleState({
  runtimeDetected = false,
  runtimeDiscoveryFingerprint = null,
} = {}) {
  return {
    contractVersion: AGY_CAPSULE_CONTRACT_VERSION,
    runtime: "apple-container",
    runtimeDetected: runtimeDetected === true,
    runtimeUsable: false,
    runtimeVersion: null,
    runtimeDiscoveryFingerprint:
      typeof runtimeDiscoveryFingerprint === "string" && runtimeDiscoveryFingerprint
      ? runtimeDiscoveryFingerprint
      : null,
    promotionReady: false,
    reason: runtimeDetected === true
      ? "r14_capsule_evidence_missing"
      : "r14_apple_container_not_installed",
    capabilities: AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => ({
      id: capability.id,
      status: "unknown",
      assurance: null,
    })),
  };
}

export function auditAgyCapsuleEvidence(evidence, expected = {}) {
  const findings = [];
  const provenCapabilities = [];

  if (!isRecord(evidence)) {
    return {
      promotionReady: false,
      findings: ["AGY_CAPSULE_EVIDENCE_INVALID"],
      provenCapabilities,
    };
  }

  if (evidence.contractVersion !== AGY_CAPSULE_CONTRACT_VERSION) {
    addFinding(findings, "AGY_CAPSULE_CONTRACT_VERSION_MISMATCH");
  }

  const expectedNow = expected.now instanceof Date
    ? expected.now.getTime()
    : Number.NaN;
  const expectedDigests = isRecord(expected.evidenceDigests)
    ? expected.evidenceDigests
    : {};
  const expectedScopeValid =
    typeof expected.runtimeKind === "string" && expected.runtimeKind.length > 0 &&
    SHA256_PATTERN.test(expected.runtimeFingerprint || "") &&
    SHA256_PATTERN.test(expected.agyFingerprint || "") &&
    typeof expected.hostFingerprint === "string" && expected.hostFingerprint.length > 0 &&
    SHA256_PATTERN.test(expected.profileHash || "") &&
    typeof expected.probeRunId === "string" && expected.probeRunId.length > 0 &&
    Number.isFinite(expectedNow) &&
    isRecord(expected.evidenceDigests) &&
    Object.keys(expectedDigests).length > 0 &&
    Object.values(expectedDigests).every((digest) => SHA256_PATTERN.test(digest));
  if (!expectedScopeValid) {
    addFinding(findings, "AGY_CAPSULE_EXPECTED_SCOPE_INVALID");
  }

  const runtime = isRecord(evidence.runtime) ? evidence.runtime : {};
  const scope = isRecord(evidence.scope) ? evidence.scope : {};
  if (runtime.kind !== expected.runtimeKind) {
    addFinding(findings, "AGY_CAPSULE_RUNTIME_KIND_MISMATCH");
  }
  if (runtime.fingerprint !== expected.runtimeFingerprint) {
    addFinding(findings, "AGY_CAPSULE_RUNTIME_DRIFT");
  }
  if (!SHA256_PATTERN.test(runtime.fingerprint || "")) {
    addFinding(findings, "AGY_CAPSULE_RUNTIME_FINGERPRINT_INVALID");
  }
  if (typeof runtime.version !== "string" || !runtime.version.trim()) {
    addFinding(findings, "AGY_CAPSULE_RUNTIME_VERSION_MISSING");
  }
  if (scope.agyFingerprint !== expected.agyFingerprint) {
    addFinding(findings, "AGY_CAPSULE_AGY_DRIFT");
  }
  if (!SHA256_PATTERN.test(scope.agyFingerprint || "")) {
    addFinding(findings, "AGY_CAPSULE_AGY_FINGERPRINT_INVALID");
  }
  if (scope.hostFingerprint !== expected.hostFingerprint) {
    addFinding(findings, "AGY_CAPSULE_HOST_DRIFT");
  }
  if (scope.profileHash !== expected.profileHash) {
    addFinding(findings, "AGY_CAPSULE_PROFILE_DRIFT");
  }
  if (!SHA256_PATTERN.test(scope.profileHash || "")) {
    addFinding(findings, "AGY_CAPSULE_PROFILE_HASH_INVALID");
  }
  if (scope.probeRunId !== expected.probeRunId) {
    addFinding(findings, "AGY_CAPSULE_PROBE_RUN_DRIFT");
  }

  const probedAt = validTimestamp(evidence.probedAt);
  const expiresAt = validTimestamp(evidence.expiresAt);
  const now = expectedNow;
  if (probedAt === null || expiresAt === null || expiresAt <= probedAt) {
    addFinding(findings, "AGY_CAPSULE_EVIDENCE_TIME_INVALID");
  } else {
    if (probedAt > now + 5 * 60 * 1000) {
      addFinding(findings, "AGY_CAPSULE_EVIDENCE_FROM_FUTURE");
    }
    if (expiresAt <= now) {
      addFinding(findings, "AGY_CAPSULE_EVIDENCE_EXPIRED");
    }
    if (expiresAt - probedAt > AGY_CAPSULE_MAX_EVIDENCE_AGE_MS) {
      addFinding(findings, "AGY_CAPSULE_EVIDENCE_TTL_UNSAFE");
    }
  }

  const capabilities = Array.isArray(evidence.capabilities)
    ? evidence.capabilities
    : [];
  if (!Array.isArray(evidence.capabilities)) {
    addFinding(findings, "AGY_CAPSULE_CAPABILITIES_INVALID");
  }

  const byId = new Map();
  const seenProbeIds = new Set();
  for (const capability of capabilities) {
    if (!isRecord(capability) || typeof capability.id !== "string") {
      addFinding(findings, "AGY_CAPSULE_CAPABILITY_INVALID");
      continue;
    }
    if (byId.has(capability.id)) {
      addFinding(findings, `AGY_CAPSULE_CAPABILITY_DUPLICATE:${capability.id}`);
      continue;
    }
    byId.set(capability.id, capability);
  }

  const requiredIds = new Set(
    AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => capability.id)
  );
  for (const id of byId.keys()) {
    if (!requiredIds.has(id)) {
      addFinding(findings, `AGY_CAPSULE_CAPABILITY_UNEXPECTED:${id}`);
    }
  }

  for (const requirement of AGY_CAPSULE_REQUIRED_CAPABILITIES) {
    const capability = byId.get(requirement.id);
    if (!capability) {
      addFinding(findings, `AGY_CAPSULE_CAPABILITY_MISSING:${requirement.id}`);
      continue;
    }
    if (capability.status !== "proven") {
      addFinding(findings, `AGY_CAPSULE_CAPABILITY_NOT_PROVEN:${requirement.id}`);
      continue;
    }
    if (!requirement.acceptedAssurance.includes(capability.assurance)) {
      addFinding(findings, `AGY_CAPSULE_ASSURANCE_INSUFFICIENT:${requirement.id}`);
      continue;
    }
    if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
      addFinding(findings, `AGY_CAPSULE_PROBE_EVIDENCE_MISSING:${requirement.id}`);
      continue;
    }
    let probeEvidenceValid = true;
    const validProbeIds = new Set();
    for (const probe of capability.evidence) {
      let probeValid = true;
      if (
        !isRecord(probe) ||
        typeof probe.probeId !== "string" ||
        !PROBE_ID_PATTERN.test(probe.probeId) ||
        !SHA256_PATTERN.test(probe.artifactSha256 || "") ||
        probe.outcome !== "pass"
      ) {
        addFinding(findings, `AGY_CAPSULE_PROBE_EVIDENCE_INVALID:${requirement.id}`);
        probeEvidenceValid = false;
        continue;
      }
      if (seenProbeIds.has(probe.probeId)) {
        addFinding(findings, `AGY_CAPSULE_PROBE_DUPLICATE:${probe.probeId}`);
        probeEvidenceValid = false;
        probeValid = false;
      }
      seenProbeIds.add(probe.probeId);
      if (probe.runId !== expected.probeRunId) {
        addFinding(findings, `AGY_CAPSULE_PROBE_RUN_MISMATCH:${requirement.id}`);
        probeEvidenceValid = false;
        probeValid = false;
      }
      if (
        !Object.hasOwn(expectedDigests, probe.probeId) ||
        expectedDigests[probe.probeId] !== probe.artifactSha256
      ) {
        addFinding(findings, `AGY_CAPSULE_PROBE_DIGEST_MISMATCH:${requirement.id}`);
        probeEvidenceValid = false;
        probeValid = false;
      }
      if (probeValid) validProbeIds.add(probe.probeId);
    }
    for (const requiredProbeId of requirement.requiredProbeIds || []) {
      if (!validProbeIds.has(requiredProbeId)) {
        addFinding(
          findings,
          `AGY_CAPSULE_REQUIRED_PROBE_MISSING:${requirement.id}:${requiredProbeId}`
        );
        probeEvidenceValid = false;
      }
    }
    if (!probeEvidenceValid) continue;
    provenCapabilities.push(requirement.id);
  }

  return {
    promotionReady: findings.length === 0,
    findings,
    provenCapabilities,
  };
}

export function assertAgyCapsuleEvidence(evidence, expected = {}) {
  const result = auditAgyCapsuleEvidence(evidence, expected);
  if (!result.promotionReady) {
    const error = new Error(
      `AGY external capsule evidence failed: ${result.findings.join(", ")}`
    );
    error.code = "AGY_CAPSULE_EVIDENCE_INVALID";
    error.findings = result.findings;
    throw error;
  }
  return result;
}
