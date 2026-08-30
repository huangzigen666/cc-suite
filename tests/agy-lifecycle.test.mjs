import assert from "node:assert/strict";
import test from "node:test";

import {
  AGY_SUPERVISOR_RECORD_PREFIX,
  auditAgySupervisorCompletion,
  createAgySupervisorRunNonce,
} from "../scripts/lib/agy-lifecycle.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const PROFILE_HASH = `sha256:${"a".repeat(64)}`;
const NOW = new Date("2026-08-11T04:00:01.000Z");

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    profileHash: PROFILE_HASH,
    supervisorPid: 1,
    workloadPid: 19,
    exitKind: "exit",
    exitCode: 0,
    signal: null,
    startedAt: "2026-08-11T04:00:00.000Z",
    finishedAt: "2026-08-11T04:00:00.250Z",
    ...overrides,
  };
}

function output(...records) {
  return [
    "untrusted workload output",
    ...records.map((item) => `${AGY_SUPERVISOR_RECORD_PREFIX}${JSON.stringify(item)}`),
    "",
  ].join("\n");
}

const EXPECTED = {
  cliExitCode: 0,
  expectedRunId: RUN_ID,
  expectedProfileHash: PROFILE_HASH,
  now: NOW,
};

test("R13 accepts one terminal completion record for a successful workload", () => {
  const result = auditAgySupervisorCompletion(output(record()), EXPECTED);

  assert.equal(result.attributed, true);
  assert.equal(result.workloadSucceeded, true);
  assert.equal(result.workloadExitCode, 0);
  assert.deepEqual(result.findings, []);
});

test("R13 attributes non-zero exit and SIGKILL even when Apple CLI reports zero", () => {
  const nonzero = auditAgySupervisorCompletion(
    output(record({ exitCode: 7 })),
    EXPECTED
  );
  assert.equal(nonzero.attributed, true);
  assert.equal(nonzero.workloadSucceeded, false);
  assert.equal(nonzero.workloadExitCode, 7);

  const killed = auditAgySupervisorCompletion(
    output(record({ exitKind: "signal", exitCode: null, signal: 9 })),
    EXPECTED
  );
  assert.equal(killed.attributed, true);
  assert.equal(killed.workloadSucceeded, false);
  assert.equal(killed.workloadExitCode, 137);
});

test("R13 fails closed when the CLI fails or no completion record exists", () => {
  const cliFailure = auditAgySupervisorCompletion(output(record()), {
    ...EXPECTED,
    cliExitCode: 1,
  });
  assert.equal(cliFailure.attributed, false);
  assert.ok(cliFailure.findings.includes("AGY_SUPERVISOR_CLI_FAILED"));

  const missing = auditAgySupervisorCompletion("workload only\n", EXPECTED);
  assert.equal(missing.attributed, false);
  assert.ok(missing.findings.includes("AGY_SUPERVISOR_RECORD_MISSING"));
});

test("R13 rejects forged, duplicated, non-terminal, and malformed records", () => {
  const duplicated = auditAgySupervisorCompletion(
    output(record({ workloadPid: 18 }), record()),
    EXPECTED
  );
  assert.equal(duplicated.attributed, false);
  assert.ok(duplicated.findings.includes("AGY_SUPERVISOR_RECORD_COUNT_INVALID"));

  const nonterminal = auditAgySupervisorCompletion(
    `${output(record())}untrusted trailing output\n`,
    EXPECTED
  );
  assert.equal(nonterminal.attributed, false);
  assert.ok(nonterminal.findings.includes("AGY_SUPERVISOR_RECORD_NOT_TERMINAL"));

  const malformed = auditAgySupervisorCompletion(
    `${AGY_SUPERVISOR_RECORD_PREFIX}{not-json}\n`,
    EXPECTED
  );
  assert.equal(malformed.attributed, false);
  assert.ok(malformed.findings.includes("AGY_SUPERVISOR_RECORD_JSON_INVALID"));
});

test("R13 binds completion to the host-generated run and policy profile", () => {
  const wrongRun = auditAgySupervisorCompletion(
    output(record({ runId: "agy-r13-attacker" })),
    EXPECTED
  );
  assert.equal(wrongRun.attributed, false);
  assert.ok(wrongRun.findings.includes("AGY_SUPERVISOR_RUN_ID_MISMATCH"));

  const wrongProfile = auditAgySupervisorCompletion(
    output(record({ profileHash: `sha256:${"b".repeat(64)}` })),
    EXPECTED
  );
  assert.equal(wrongProfile.attributed, false);
  assert.ok(wrongProfile.findings.includes("AGY_SUPERVISOR_PROFILE_MISMATCH"));
});

test("R13 requires a non-disclosed 128-bit lowercase hex run nonce", () => {
  const nonceA = createAgySupervisorRunNonce();
  const nonceB = createAgySupervisorRunNonce();
  assert.match(nonceA, /^[a-f0-9]{32}$/);
  assert.match(nonceB, /^[a-f0-9]{32}$/);
  assert.notEqual(nonceA, nonceB);

  const weakExpectedNonce = auditAgySupervisorCompletion(output(record()), {
    ...EXPECTED,
    expectedRunId: "agy-r13-predictable",
  });
  assert.equal(weakExpectedNonce.attributed, false);
  assert.ok(
    weakExpectedNonce.findings.includes("AGY_SUPERVISOR_EXPECTED_SCOPE_INVALID")
  );

  const weakRecordNonce = auditAgySupervisorCompletion(
    output(record({ runId: "agy-r13-predictable" })),
    EXPECTED
  );
  assert.equal(weakRecordNonce.attributed, false);
  assert.ok(weakRecordNonce.findings.includes("AGY_SUPERVISOR_RUN_ID_INVALID"));
});

test("R13 permits only bounded host/guest clock skew", () => {
  const boundedSkew = auditAgySupervisorCompletion(
    output(record({ finishedAt: "2026-08-11T04:00:01.100Z" })),
    EXPECTED
  );
  assert.equal(boundedSkew.attributed, true);
  assert.deepEqual(boundedSkew.findings, []);
});

test("R13 rejects ambiguous schemas, invalid exit tuples, and unsafe timestamps", () => {
  const extraKey = auditAgySupervisorCompletion(
    output(record({ attackerControlled: true })),
    EXPECTED
  );
  assert.equal(extraKey.attributed, false);
  assert.ok(extraKey.findings.includes("AGY_SUPERVISOR_RECORD_SCHEMA_INVALID"));

  for (const invalidRecord of [
    record({ exitKind: "exit", exitCode: null, signal: 9 }),
    record({ exitKind: "signal", exitCode: 0, signal: null }),
    record({ startedAt: "2026-08-11 04:00:00Z" }),
    record({ finishedAt: "2026-08-11T03:59:59.000Z" }),
    record({ finishedAt: "2026-08-11T04:00:02.000Z" }),
  ]) {
    const result = auditAgySupervisorCompletion(output(invalidRecord), EXPECTED);
    assert.equal(result.attributed, false);
    assert.ok(result.findings.length > 0);
  }
});
