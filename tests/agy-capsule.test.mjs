import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  AGY_CAPSULE_CONTRACT_VERSION,
  AGY_CAPSULE_REQUIRED_CAPABILITIES,
  AGY_LIFECYCLE_REQUIRED_PROBE_IDS,
  assertAgyCapsuleEvidence,
  auditAgyCapsuleEvidence,
  createPendingAgyCapsuleState,
} from "../scripts/lib/agy-capsule.mjs";

const NOW = new Date("2026-08-10T08:00:00.000Z");
const PROBE_RUN_ID = "019fe836-2079-7880-a157-c180e9fb3845";
const sha256 = (character) => `sha256:${character.repeat(64)}`;
const probeIdsFor = (capability) => capability.requiredProbeIds?.length
  ? capability.requiredProbeIds
  : [`probe:${capability.id}`];
const ALL_PROBE_IDS = AGY_CAPSULE_REQUIRED_CAPABILITIES.flatMap(probeIdsFor);
const EVIDENCE_DIGESTS = Object.fromEntries(
  ALL_PROBE_IDS.map((probeId, index) => [
    probeId,
    sha256(((index + 1) % 10).toString()),
  ])
);

function validEvidence(overrides = {}) {
  return {
    contractVersion: AGY_CAPSULE_CONTRACT_VERSION,
    runtime: {
      kind: "apple-container",
      fingerprint: sha256("a"),
      version: "container 0.9.0",
    },
    scope: {
      agyFingerprint: sha256("b"),
      hostFingerprint: "darwin-arm64-26.5.2",
      profileHash: sha256("c"),
      probeRunId: PROBE_RUN_ID,
    },
    probedAt: "2026-08-10T07:30:00.000Z",
    expiresAt: "2026-08-10T09:00:00.000Z",
    capabilities: AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => ({
      id: capability.id,
      status: "proven",
      assurance: capability.acceptedAssurance[0],
      evidence: probeIdsFor(capability).map((probeId) => ({
        probeId,
        runId: PROBE_RUN_ID,
        outcome: "pass",
        artifactSha256: EVIDENCE_DIGESTS[probeId],
      })),
    })),
    ...overrides,
  };
}

const EXPECTED_SCOPE = {
  runtimeKind: "apple-container",
  runtimeFingerprint: sha256("a"),
  agyFingerprint: sha256("b"),
  hostFingerprint: "darwin-arm64-26.5.2",
  profileHash: sha256("c"),
  probeRunId: PROBE_RUN_ID,
  evidenceDigests: EVIDENCE_DIGESTS,
  now: NOW,
};

test("R14 capsule contract accepts only complete, current, scope-bound evidence", () => {
  const result = auditAgyCapsuleEvidence(validEvidence(), EXPECTED_SCOPE);

  assert.equal(result.promotionReady, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.provenCapabilities.length, AGY_CAPSULE_REQUIRED_CAPABILITIES.length);
});

test("R14 capsule contract fails closed on missing, unknown, or disproven capabilities", () => {
  const missing = validEvidence();
  missing.capabilities.pop();
  assert.equal(auditAgyCapsuleEvidence(missing, EXPECTED_SCOPE).promotionReady, false);
  assert.ok(
    auditAgyCapsuleEvidence(missing, EXPECTED_SCOPE).findings.includes(
      "AGY_CAPSULE_CAPABILITY_MISSING:lifecycle_attribution"
    )
  );

  for (const status of ["unknown", "disproven"]) {
    const evidence = validEvidence();
    evidence.capabilities[0].status = status;
    const result = auditAgyCapsuleEvidence(evidence, EXPECTED_SCOPE);
    assert.equal(result.promotionReady, false);
    assert.ok(result.findings.includes(`AGY_CAPSULE_CAPABILITY_NOT_PROVEN:external_vm_boundary`));
    assert.throws(
      () => assertAgyCapsuleEvidence(evidence, EXPECTED_SCOPE),
      (error) => error.code === "AGY_CAPSULE_EVIDENCE_INVALID"
    );
  }
});

test("R14 capsule contract rejects advisory, detective, duplicate, and evidence-free claims", () => {
  for (const mutate of [
    (evidence) => { evidence.capabilities[0].assurance = "advisory"; },
    (evidence) => { evidence.capabilities[0].assurance = "detective"; },
    (evidence) => { evidence.capabilities[0].evidence = []; },
    (evidence) => { evidence.capabilities.push({ ...evidence.capabilities[0] }); },
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    const result = auditAgyCapsuleEvidence(evidence, EXPECTED_SCOPE);
    assert.equal(result.promotionReady, false);
    assert.ok(result.findings.length > 0);
  }
});

test("R14 capsule evidence expires and is invalidated by runtime, AGY, host, or profile drift", () => {
  const expired = auditAgyCapsuleEvidence(validEvidence(), {
    ...EXPECTED_SCOPE,
    now: new Date("2026-08-10T10:00:00.000Z"),
  });
  assert.equal(expired.promotionReady, false);
  assert.ok(expired.findings.includes("AGY_CAPSULE_EVIDENCE_EXPIRED"));

  for (const [key, value, finding] of [
    ["runtimeFingerprint", sha256("d"), "AGY_CAPSULE_RUNTIME_DRIFT"],
    ["agyFingerprint", sha256("e"), "AGY_CAPSULE_AGY_DRIFT"],
    ["hostFingerprint", "darwin-arm64-27.0", "AGY_CAPSULE_HOST_DRIFT"],
    ["profileHash", sha256("f"), "AGY_CAPSULE_PROFILE_DRIFT"],
  ]) {
    const result = auditAgyCapsuleEvidence(validEvidence(), {
      ...EXPECTED_SCOPE,
      [key]: value,
    });
    assert.equal(result.promotionReady, false);
    assert.ok(result.findings.includes(finding));
  }
});

test("R14 capsule contract rejects unbound producers, forged digests, and loose timestamps", () => {
  const noExpectedScope = auditAgyCapsuleEvidence(validEvidence(), {});
  assert.equal(noExpectedScope.promotionReady, false);
  assert.ok(noExpectedScope.findings.includes("AGY_CAPSULE_EXPECTED_SCOPE_INVALID"));

  const wrongRun = validEvidence();
  wrongRun.capabilities[0].evidence[0].runId = "019fe836-2079-7880-a157-c180e9fb9999";
  assert.ok(
    auditAgyCapsuleEvidence(wrongRun, EXPECTED_SCOPE).findings.includes(
      "AGY_CAPSULE_PROBE_RUN_MISMATCH:external_vm_boundary"
    )
  );

  const forgedDigest = validEvidence();
  forgedDigest.capabilities[0].evidence[0].artifactSha256 = sha256("9");
  assert.ok(
    auditAgyCapsuleEvidence(forgedDigest, EXPECTED_SCOPE).findings.includes(
      "AGY_CAPSULE_PROBE_DIGEST_MISMATCH:external_vm_boundary"
    )
  );

  const looseTime = validEvidence({ probedAt: "2026-08-10 07:30:00Z" });
  assert.ok(
    auditAgyCapsuleEvidence(looseTime, EXPECTED_SCOPE).findings.includes(
      "AGY_CAPSULE_EVIDENCE_TIME_INVALID"
    )
  );
});

test("R12 requires host-routable listener blocking independently of empty publish metadata", () => {
  assert.equal(AGY_CAPSULE_CONTRACT_VERSION, 5);
  const ids = AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => capability.id);
  assert.ok(ids.includes("inbound_unpublished"));
  assert.ok(ids.includes("host_routable_listener_blocked"));

  const evidence = validEvidence();
  const listener = evidence.capabilities.find(
    (capability) => capability.id === "host_routable_listener_blocked"
  );
  listener.status = "disproven";
  const result = auditAgyCapsuleEvidence(evidence, EXPECTED_SCOPE);
  assert.equal(result.promotionReady, false);
  assert.ok(
    result.findings.includes(
      "AGY_CAPSULE_CAPABILITY_NOT_PROVEN:host_routable_listener_blocked"
    )
  );
});

test("R12 requires an irreversible workload privilege drop after guest firewall setup", () => {
  const ids = AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => capability.id);
  assert.ok(ids.includes("workload_privilege_drop"));

  const evidence = validEvidence();
  const privilegeDrop = evidence.capabilities.find(
    (capability) => capability.id === "workload_privilege_drop"
  );
  privilegeDrop.status = "disproven";
  const result = auditAgyCapsuleEvidence(evidence, EXPECTED_SCOPE);
  assert.equal(result.promotionReady, false);
  assert.ok(
    result.findings.includes(
      "AGY_CAPSULE_CAPABILITY_NOT_PROVEN:workload_privilege_drop"
    )
  );
});

test("R13 lifecycle attribution requires all adversarial probe classes", () => {
  assert.deepEqual(AGY_LIFECYCLE_REQUIRED_PROBE_IDS, [
    "lifecycle:exit-zero",
    "lifecycle:exit-nonzero",
    "lifecycle:signal",
    "lifecycle:forged-record",
    "lifecycle:descendant-drain",
    "lifecycle:missing-kill-capability",
  ]);

  const evidence = validEvidence();
  const lifecycle = evidence.capabilities.find(
    (capability) => capability.id === "lifecycle_attribution"
  );
  lifecycle.evidence = lifecycle.evidence.slice(0, 1);
  const result = auditAgyCapsuleEvidence(evidence, EXPECTED_SCOPE);
  assert.equal(result.promotionReady, false);
  for (const probeId of AGY_LIFECYCLE_REQUIRED_PROBE_IDS.slice(1)) {
    assert.ok(
      result.findings.includes(
        `AGY_CAPSULE_REQUIRED_PROBE_MISSING:lifecycle_attribution:${probeId}`
      )
    );
  }
});

test("R14 requires exact proxy, bootstrap, and OAuth-state probe classes", () => {
  const requirements = Object.fromEntries(
    AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => [
      capability.id,
      capability.requiredProbeIds || [],
    ])
  );
  assert.deepEqual(requirements.host_credential_isolation, [
    "oauth-volume:named-ext4",
    "oauth-volume:mode-0700-uid65532",
    "oauth-volume:host-paths-absent",
    "oauth-volume:state-persists",
    "oauth-volume:missing-mount-fails",
  ]);
  assert.deepEqual(requirements.off_policy_egress_blocked, [
    "proxy:direct-egress-blocked",
    "proxy:denied-ip-literal",
    "proxy:denied-wrong-client",
  ]);
  assert.deepEqual(requirements.destination_egress_allowlist, [
    "proxy:allowed-exact-host",
    "proxy:denied-unlisted-host",
    "proxy:dns-pinned-public-ip",
    "proxy:bounded-teardown",
  ]);
  assert.deepEqual(requirements.inbound_unpublished, [
    "bootstrap:loopback-only",
    "bootstrap:ingress-removed",
  ]);
  assert.deepEqual(requirements.workload_privilege_drop, [
    "bootstrap:quarantine-before-handoff",
  ]);
});

test("detecting an Apple container CLI never fabricates capsule evidence", () => {
  const missing = createPendingAgyCapsuleState();
  assert.equal(missing.runtimeDetected, false);
  assert.equal(missing.promotionReady, false);
  assert.equal(missing.reason, "r14_apple_container_not_installed");

  const detected = createPendingAgyCapsuleState({
    runtimeDetected: true,
    runtimeDiscoveryFingerprint: "path|unexecuted|mtime|size",
  });
  assert.equal(detected.runtimeDetected, true);
  assert.equal(detected.runtimeUsable, false);
  assert.equal(detected.runtimeVersion, null);
  assert.equal(detected.runtimeDiscoveryFingerprint, "path|unexecuted|mtime|size");
  assert.equal(detected.promotionReady, false);
  assert.equal(detected.reason, "r14_capsule_evidence_missing");
  assert.ok(detected.capabilities.every((capability) => capability.status === "unknown"));
});

test("shell preflight and validator expose the same required capability IDs", () => {
  const script = fs.readFileSync(
    new URL("../scripts/agy-preflight.sh", import.meta.url),
    "utf8"
  );
  const match = script.match(/^CAPSULE_CAPABILITIES='([^']+)'$/m);
  assert.ok(match, "preflight capsule capability declaration is missing");
  const shellIds = JSON.parse(match[1]).map((capability) => capability.id);
  const validatorIds = AGY_CAPSULE_REQUIRED_CAPABILITIES.map((capability) => capability.id);
  assert.deepEqual(shellIds, validatorIds);
});
