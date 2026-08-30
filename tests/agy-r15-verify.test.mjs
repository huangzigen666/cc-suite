import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGY_SUPERVISOR_RECORD_PREFIX } from "../scripts/lib/agy-lifecycle.mjs";
import {
  AGY_R15_MODEL_MARKER,
  AGY_R15_MODEL_PROMPT,
  AGY_R15_VERIFY_MODEL,
  AGY_R15_VERIFY_PROFILE_HASHES,
  auditAgyR15ExistingOAuthVolume,
  auditAgyR15ModelTranscript,
  auditAgyR15ModelsTranscript,
  buildAgyR15CaptureSpec,
  buildAgyR15VerificationClientCreateArgs,
  buildAgyR15VerificationResourceNames,
  parseAgyR15VerifyArguments,
  summarizeAgyR15Capture,
} from "../scripts/lib/agy-r15-verify.mjs";

const VOLUME_NAME = "cc-suite-agy-oauth-0123456789abcdef";
const HOME = "/Users/ccsuite-test";
const SOURCE_ROOT = `${HOME}/Library/Application Support/com.apple.container/volumes`;
const NOW = new Date("2026-08-12T04:00:01.000Z");
const RUN_ID = "0123456789abcdef0123456789abcdef";
const PROFILE_HASH = `sha256:${"a".repeat(64)}`;
const SUFFIX = "0123456789ab";

function volumeDescriptor(overrides = {}) {
  return [{
    configuration: {
      creationDate: "2026-08-12T03:59:00Z",
      driver: "local",
      format: "ext4",
      labels: {
        "cc-suite.owner": "cc-suite",
        "cc-suite.purpose": "agy-oauth-state",
        "cc-suite.schema": "1",
        "cc-suite.sensitivity": "oauth",
      },
      name: VOLUME_NAME,
      options: { size: "256M" },
      sizeInBytes: 268435456,
      source: `${SOURCE_ROOT}/${VOLUME_NAME}/volume.img`,
      ...overrides,
    },
    id: VOLUME_NAME,
  }];
}

function completion(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    profileHash: PROFILE_HASH,
    supervisorPid: 1,
    workloadPid: 31,
    exitKind: "exit",
    exitCode: 0,
    signal: null,
    startedAt: "2026-08-12T04:00:00.000Z",
    finishedAt: "2026-08-12T04:00:00.250Z",
    ...overrides,
  };
}

function withCompletion(workloadOutput, overrides = {}) {
  return `${workloadOutput}\n${AGY_SUPERVISOR_RECORD_PREFIX}${JSON.stringify(
    completion(overrides)
  )}\n`;
}

const EXPECTED = {
  cliExitCode: 0,
  expectedRunId: RUN_ID,
  expectedProfileHash: PROFILE_HASH,
  now: NOW,
};

test("R15 verifier accepts only one exact labeled recent OAuth volume", () => {
  const ready = auditAgyR15ExistingOAuthVolume(
    JSON.stringify(volumeDescriptor()),
    {
      expectedName: VOLUME_NAME,
      homeDirectory: HOME,
      now: NOW,
    }
  );
  assert.deepEqual(ready, { ready: true, findings: [] });

  for (const [override, finding] of [
    [{ labels: {} }, "AGY_OAUTH_VOLUME_LABELS_INVALID"],
    [{ source: `/tmp/${VOLUME_NAME}/volume.img` }, "AGY_OAUTH_VOLUME_SOURCE_MISMATCH"],
    [{ creationDate: "2026-08-10T03:59:00Z" }, "AGY_OAUTH_VOLUME_STALE"],
  ]) {
    const result = auditAgyR15ExistingOAuthVolume(
      JSON.stringify(volumeDescriptor(override)),
      {
        expectedName: VOLUME_NAME,
        homeDirectory: HOME,
        now: NOW,
      }
    );
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes(finding));
  }
});

test("R15 verifier requires the exact volume and real-request acknowledgement", () => {
  assert.deepEqual(parseAgyR15VerifyArguments([
    "--oauth-volume",
    VOLUME_NAME,
    "--acknowledge-real-model-request",
    "--acknowledge-host-proxy-bridge",
  ]), {
    oauthVolumeName: VOLUME_NAME,
  });

  for (const argv of [
    [],
    ["--oauth-volume", "latest", "--acknowledge-real-model-request"],
    ["--oauth-volume", VOLUME_NAME],
    ["--oauth-volume", VOLUME_NAME, "--acknowledge-real-model-request", "--raw"],
    ["--oauth-volume", VOLUME_NAME, "--acknowledge-real-model-request"],
  ]) {
    assert.throws(
      () => parseAgyR15VerifyArguments(argv),
      (error) => error.code === "AGY_R15_VERIFY_ARGUMENTS_INVALID"
    );
  }
});

test("R15 uses separate exact resources for models and model-request phases", () => {
  assert.match(AGY_R15_VERIFY_PROFILE_HASHES.models, /^sha256:[a-f0-9]{64}$/);
  assert.match(AGY_R15_VERIFY_PROFILE_HASHES.request, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    AGY_R15_VERIFY_PROFILE_HASHES.models,
    AGY_R15_VERIFY_PROFILE_HASHES.request
  );
  assert.deepEqual(buildAgyR15VerificationResourceNames(SUFFIX, "models"), {
    client: `cc-suite-agy-r15-models-${SUFFIX}`,
    network: "default",
    proxy: `cc-suite-agy-r15-proxy-${SUFFIX}`,
  });
  assert.deepEqual(buildAgyR15VerificationResourceNames(SUFFIX, "request"), {
    client: `cc-suite-agy-r15-request-${SUFFIX}`,
    network: "default",
    proxy: `cc-suite-agy-r15-proxy-${SUFFIX}`,
  });
  assert.throws(
    () => buildAgyR15VerificationResourceNames(SUFFIX, "auth"),
    (error) => error.code === "AGY_R15_VERIFY_PHASE_INVALID"
  );
});

function clientOptions(phase) {
  return {
    bootstrapHostPort: 28083,
    bootstrapNonce: "abcdef0123456789abcdef0123456789",
    clientName: `cc-suite-agy-r15-${phase}-${SUFFIX}`,
    networkName: "default",
    networkPrefix: "172.30.251",
    oauthVolumeName: VOLUME_NAME,
    phase,
    profileHash: AGY_R15_VERIFY_PROFILE_HASHES[phase],
    proxyPort: 18443,
    runId: RUN_ID,
  };
}

test("R15 models probe is noninteractive and mounts no host path", () => {
  const args = buildAgyR15VerificationClientCreateArgs(clientOptions("models"));
  const flattened = args.join(" ");

  assert.equal(args[0], "create");
  assert.equal(args.includes("--interactive"), false);
  assert.equal(args.includes("--tty"), false);
  assert.ok(args.includes("--no-dns"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes(`type=volume,source=${VOLUME_NAME},target=/home/agy`));
  assert.ok(args.includes("127.0.0.1:28083:18083"));
  assert.equal(flattened.includes("/Users/"), false);
  assert.equal(flattened.includes("--ssh"), false);
  assert.deepEqual(args.slice(-3), [
    "cc-suite/agy-r14-capsule:1.1.11",
    "/usr/local/bin/agy",
    "models",
  ]);

  assert.throws(
    () => buildAgyR15VerificationClientCreateArgs({
      ...clientOptions("models"),
      networkPrefix: "192.168.999",
    }),
    (error) => error.code === "AGY_R15_VERIFY_SCOPE_INVALID"
  );
  assert.throws(
    () => buildAgyR15VerificationClientCreateArgs({
      ...clientOptions("models"),
      profileHash: PROFILE_HASH,
    }),
    (error) => error.code === "AGY_R15_VERIFY_SCOPE_INVALID"
  );
});

test("R15 real request is fixed, sandboxed, stream-json, and has no mode override", () => {
  const args = buildAgyR15VerificationClientCreateArgs(clientOptions("request"));
  const flattened = args.join(" ");

  assert.equal(AGY_R15_MODEL_MARKER, "AGY_R15_MODEL_OK");
  assert.match(AGY_R15_MODEL_PROMPT, /Do not call any tool/);
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("default-cli-project"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes(AGY_R15_VERIFY_MODEL));
  assert.ok(args.includes(AGY_R15_MODEL_PROMPT));
  assert.equal(args.includes("--mode"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(flattened.includes("--add-dir"), false);
});

test("R15 capture never attaches stdin or forwards raw workload output", () => {
  assert.deepEqual(buildAgyR15CaptureSpec(`cc-suite-agy-r15-models-${SUFFIX}`), {
    command: "container",
    args: ["start", "--attach", `cc-suite-agy-r15-models-${SUFFIX}`],
    options: {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
});

test("R15 capture diagnostics expose structure without raw output or identifiers", () => {
  const stdout = withCompletion([
    JSON.stringify({
      event: "init",
      conversation_id: "private-conversation",
      init: { cwd: "/workspace", model: "gemini-3.6-flash-low" },
    }),
    JSON.stringify({
      event: "result",
      result: {
        error: "project not found; token rejected",
        response: "private response",
        status: "ERROR",
        usage: { total_tokens: 1 },
      },
    }),
  ].join("\n"));
  const summary = summarizeAgyR15Capture({
    exitCode: 1,
    signal: null,
    stdout,
    stderr: "project not found; token rejected",
    observedAt: NOW,
  });

  assert.equal(summary.exitCode, 1);
  assert.deepEqual(summary.eventCounts, { init: 1, result: 1 });
  assert.equal(summary.initHasModel, true);
  assert.equal(summary.initWorkspaceExact, true);
  assert.equal(summary.resultHasResponse, true);
  assert.equal(summary.resultHasUsage, true);
  assert.equal(summary.resultStatus, "ERROR");
  assert.deepEqual(summary.resultErrorClasses, ["authentication", "project"]);
  assert.match(summary.resultErrorSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(summary.stderrClasses, ["authentication", "project"]);
  assert.match(summary.stderrSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.equal(Object.hasOwn(summary, "stdout"), false);
  assert.equal(Object.hasOwn(summary, "stderr"), false);
  assert.equal(summary.completionClockDeltaMs, -750);
});

test("R15 models proof derives only a count and hash from attributed output", () => {
  const result = auditAgyR15ModelsTranscript(
    withCompletion("gemini-3.6-flash-high\ngemini-3.6-flash-low"),
    EXPECTED
  );
  assert.equal(result.ready, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.modelCount, 2);
  assert.equal(result.requiredModelPresent, true);
  assert.match(result.outputSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, "rawOutput"), false);

  const refused = auditAgyR15ModelsTranscript(
    withCompletion("Please sign in: https://accounts.google.com/example"),
    EXPECTED
  );
  assert.equal(refused.ready, false);
  assert.ok(refused.findings.includes("AGY_R15_MODELS_AUTH_NOT_PROVEN"));

  const oversized = auditAgyR15ModelsTranscript(
    `${"x".repeat(1024 * 1024 + 1)}`,
    EXPECTED
  );
  assert.equal(oversized.ready, false);
  assert.ok(oversized.findings.includes("AGY_R15_VERIFY_OUTPUT_TOO_LARGE"));
});

test("R15 model proof accepts one fixed response and no mutating tool step", () => {
  const stream = [
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-r15",
      init: {
        cwd: "/workspace",
        model: "gemini-3.6-flash-low",
        permission_mode: "request-review",
        tools: ["finish", "write_to_file"],
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        state: "SUCCESS",
        step_type: "tool",
        tool_name: "finish",
        tool_info: { name: "finish" },
      },
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-r15",
        response: AGY_R15_MODEL_MARKER,
        status: "SUCCESS",
        usage: { total_tokens: 17 },
      },
    }),
  ].join("\n");
  const result = auditAgyR15ModelTranscript(withCompletion(stream), EXPECTED);
  assert.equal(result.ready, true);
  assert.equal(result.realModelCallProven, true);
  assert.equal(result.markerMatched, true);
  assert.equal(result.totalTokens, 17);
  assert.match(result.responseSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, "conversationId"), false);

  const substitutedModel = stream.replace(
    '"model":"gemini-3.6-flash-low"',
    '"model":"gemini-3.6-flash-high"'
  );
  const substitutedResult = auditAgyR15ModelTranscript(
    withCompletion(substitutedModel),
    EXPECTED
  );
  assert.equal(substitutedResult.ready, false);
  assert.ok(
    substitutedResult.findings.includes("AGY_R15_MODEL_IDENTITY_MISMATCH")
  );

  const mutating = stream.replace('"tool_name":"finish"', '"tool_name":"write_to_file"')
    .replace('"name":"finish"', '"name":"write_to_file"');
  const denied = auditAgyR15ModelTranscript(withCompletion(mutating), EXPECTED);
  assert.equal(denied.ready, false);
  assert.ok(denied.findings.includes("AGY_R15_MODEL_TOOL_USED"));

  const unfinished = stream.replace('"state":"SUCCESS"', '"state":"RUNNING"');
  const unfinishedResult = auditAgyR15ModelTranscript(
    withCompletion(unfinished),
    EXPECTED
  );
  assert.equal(unfinishedResult.ready, false);
  assert.ok(
    unfinishedResult.findings.includes("AGY_R15_MODEL_TOOL_STATE_INVALID")
  );
});

test("R15 observation summary records live proof without claiming promotion", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const summary = JSON.parse(fs.readFileSync(
    path.join(repository, "dev-probes/agy-r15/observation-summary.json"),
    "utf8"
  ));

  assert.equal(summary.status, "verified-auth-real-model-call-refresh-pending");
  assert.equal(summary.promotionEligible, false);
  assert.equal(summary.hostProxyFailureObserved, true);
  assert.equal(summary.hostProxyFailureReason, "AGY_PROXY_CONNECT_TIMEOUT");
  assert.equal(summary.hostProxyBridgeImplemented, true);
  assert.equal(summary.hostProxySystemDomainPresent, true);
  assert.equal(summary.privateRelaySideEffectAcknowledged, true);
  assert.equal(summary.hostProxyProbePassed, true);
  assert.equal(summary.fullDefaultTopologyProbePassed, true);
  assert.equal(summary.oauthVolumePresent, true);
  assert.equal(summary.oauthAuthorizationCodeSubmitted, true);
  assert.equal(summary.tokenExchangeAttempted, true);
  assert.equal(summary.tokenExchangeCompleted, true);
  assert.equal(summary.oauthAuthorizationCompleted, true);
  assert.equal(summary.authenticationPersistedAcrossFreshCapsule, true);
  assert.equal(summary.modelsProbeAttempted, true);
  assert.equal(summary.modelsProbePassed, true);
  assert.equal(summary.modelsObserved, 8);
  assert.equal(summary.verificationModel, AGY_R15_VERIFY_MODEL);
  assert.equal(summary.verificationModelPresent, true);
  assert.equal(summary.realModelCallAttempted, true);
  assert.equal(summary.realModelCallProven, true);
  assert.equal(summary.modelMarkerMatched, true);
  assert.ok(Number.isInteger(summary.modelTotalTokens));
  assert.match(summary.modelResponseSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(summary.printModeEligibilityHostObserved, "lh3.googleusercontent.com");
  assert.equal(summary.tokenRefreshAttempted, false);
  assert.equal(summary.rawOAuthOrModelOutputRetainedInEvidence, false);
  assert.equal(summary.verifierImplemented, true);
  assert.equal(summary.liveInventory.oauthVolumes, 1);
  assert.equal(summary.validation.unitTestsPassed, 207);
  assert.equal(summary.validation.integrationAssertionsPassed, 424);
  assert.equal(summary.validation.independentReview.countedAsEvidence, false);
  for (const [relativePath, expectedHash] of Object.entries(summary.sourceSha256)) {
    const actualHash = createHash("sha256")
      .update(fs.readFileSync(path.join(repository, relativePath)))
      .digest("hex");
    assert.equal(actualHash, expectedHash, relativePath);
  }
});
