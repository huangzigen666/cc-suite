import assert from "node:assert/strict";
import test from "node:test";

import {
  AGY_R16_HOME_VOLUME_SIZE_BYTES,
  auditAgyR16HomeVolume,
  auditAgyR16TokenTransition,
  auditAgyR16ToolTranscript,
  buildAgyR16HomeMergeArgs,
  buildAgyR16HomeSeedArgs,
  buildAgyR16HomeToolAuditArgs,
  buildAgyR16HomeVolumeCreateArgs,
  parseAgyR16HomeHelperResult,
  parseAgyR16TokenBuffer,
} from "../scripts/lib/agy-r16-home.mjs";

const HOME = "cc-suite-agy-r16-home-0123456789ab";
const HELPER = "cc-suite-agy-r16-home-helper-0123456789ab";
const OAUTH = "cc-suite-agy-oauth-0123456789abcdef";
const IMAGE = "cc-suite/agy-r16-egress:probe";
const RUN_ID = "0123456789abcdef0123456789abcdef";

function token({
  access = "a".repeat(160),
  expiry = "2026-08-18T02:00:00.000Z",
  refresh = "r".repeat(160),
} = {}) {
  return Buffer.from(JSON.stringify({
    auth_method: "oauth",
    token: {
      access_token: access,
      expiry,
      refresh_token: refresh,
      token_type: "Bearer",
    },
  }));
}

test("R16 token transition accepts unchanged state or one bounded OAuth refresh", () => {
  const now = new Date("2026-08-18T01:00:00.000Z");
  const before = token();
  const unchanged = auditAgyR16TokenTransition(before, before, now);
  assert.equal(unchanged.ready, true);
  assert.equal(unchanged.changed, false);
  assert.match(unchanged.beforeHash, /^sha256:[a-f0-9]{64}$/);

  const after = token({
    access: "b".repeat(160),
    expiry: "2026-08-18T03:00:00.000Z",
  });
  const refreshed = auditAgyR16TokenTransition(before, after, now);
  assert.equal(refreshed.ready, true);
  assert.equal(refreshed.changed, true);
  assert.notEqual(refreshed.beforeHash, refreshed.afterHash);

  for (const invalid of [
    token({ access: "b".repeat(160), refresh: "x".repeat(160) }),
    token({ access: "b".repeat(160), expiry: "2026-08-18T01:01:00.000Z" }),
    Buffer.from("not-json"),
  ]) {
    assert.throws(
      () => auditAgyR16TokenTransition(before, invalid, now),
      (error) => ["AGY_R16_TOKEN_INVALID", "AGY_R16_TOKEN_TRANSITION_INVALID"].includes(error.code)
    );
  }
  assert.equal(parseAgyR16TokenBuffer(before).value.token.refresh_token, "r".repeat(160));
});

test("R16 creates and audits one exact ephemeral home volume", () => {
  const args = buildAgyR16HomeVolumeCreateArgs(HOME);
  assert.deepEqual(args.slice(0, 2), ["volume", "create"]);
  assert.equal(args.at(-1), HOME);
  const descriptor = [{
    id: HOME,
    configuration: {
      driver: "local",
      format: "ext4",
      labels: {
        "cc-suite.owner": "cc-suite",
        "cc-suite.purpose": "agy-r16-ephemeral-home",
        "cc-suite.schema": "1",
        "cc-suite.sensitivity": "transient",
      },
      name: HOME,
      options: { size: "256M" },
      sizeInBytes: AGY_R16_HOME_VOLUME_SIZE_BYTES,
    },
  }];
  assert.deepEqual(auditAgyR16HomeVolume(JSON.stringify(descriptor), HOME), {
    ready: true,
    findings: [],
  });
  descriptor[0].configuration.labels["cc-suite.sensitivity"] = "oauth";
  assert.equal(auditAgyR16HomeVolume(JSON.stringify(descriptor), HOME).ready, false);
});

test("R16 seed and merge helpers receive only exact named volumes and hashes", () => {
  const seed = buildAgyR16HomeSeedArgs({
    helperImage: IMAGE,
    helperName: HELPER,
    homeVolumeName: HOME,
    oauthVolumeName: OAUTH,
  });
  assert.ok(seed.includes("type=volume,source=" + OAUTH + ",target=/source,readonly"));
  assert.ok(seed.includes("type=volume,source=" + HOME + ",target=/target"));
  assert.ok(seed.includes("--no-dns"));
  assert.ok(seed.includes("--read-only"));
  assert.ok(seed.includes("--cap-drop"));
  assert.ok(seed.includes("DAC_READ_SEARCH"));
  assert.deepEqual(seed.slice(-3), [IMAGE, "/app/agy-r16-home-helper.mjs", "seed"]);

  const hash = `sha256:${"a".repeat(64)}`;
  const merge = buildAgyR16HomeMergeArgs({
    expectedDurableHash: hash,
    helperImage: IMAGE,
    helperName: HELPER,
    homeVolumeName: HOME,
    oauthVolumeName: OAUTH,
    runId: RUN_ID,
  });
  assert.ok(merge.includes("type=volume,source=" + HOME + ",target=/source,readonly"));
  assert.ok(merge.includes("type=volume,source=" + OAUTH + ",target=/target"));
  assert.deepEqual(merge.slice(-5), [
    IMAGE,
    "/app/agy-r16-home-helper.mjs",
    "merge",
    RUN_ID,
    hash,
  ]);

  assert.deepEqual(parseAgyR16HomeHelperResult(JSON.stringify({
    status: "seeded",
    sourceHash: hash,
    targetHash: hash,
  }) + "\n", "seed"), {
    status: "seeded",
    sourceHash: hash,
    targetHash: hash,
  });
});

test("R16 tool audit accepts only direct file targets below /workspace", () => {
  const accepted = auditAgyR16ToolTranscript([
    JSON.stringify({ tool_calls: [{
      name: "write_to_file",
      args: { TargetFile: "/workspace/proof.txt", CodeContent: "secret-not-returned" },
    }] }),
    JSON.stringify({ type: "tool_result", status: "success" }),
  ].join("\n"));
  assert.equal(accepted.ready, true);
  assert.deepEqual(accepted.counts, { write_to_file: 1 });
  assert.equal(accepted.targetCount, 1);
  assert.deepEqual(accepted.targets, ["/workspace/proof.txt"]);
  assert.match(accepted.targetsSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(accepted).includes("secret-not-returned"), false);

  for (const [target, finding] of [
    ["/home/agy/scratch/proof.txt", "AGY_R16_TOOL_TARGET_OUTSIDE_WORKSPACE"],
    ["/workspace/.git", "AGY_R16_TOOL_TARGET_OUTSIDE_WORKSPACE"],
    ["/workspace/../escape.txt", "AGY_R16_TOOL_TARGET_OUTSIDE_WORKSPACE"],
  ]) {
    const denied = auditAgyR16ToolTranscript(JSON.stringify({
      tool_calls: [{ name: "write_to_file", args: { TargetFile: target } }],
    }));
    assert.equal(denied.ready, false);
    assert.ok(denied.findings.includes(finding));
  }
  const command = auditAgyR16ToolTranscript(JSON.stringify({
    tool_calls: [{ name: "run_command", args: { TargetFile: "/workspace/x" } }],
  }));
  assert.equal(command.ready, false);
  assert.ok(command.findings.includes("AGY_R16_TOOL_NOT_ALLOWED"));

  const args = buildAgyR16HomeToolAuditArgs({
    conversationId: "01234567-89ab-cdef-0123-456789abcdef",
    helperImage: IMAGE,
    helperName: HELPER,
    homeVolumeName: HOME,
  });
  assert.ok(args.includes(`type=volume,source=${HOME},target=/source,readonly`));
  assert.deepEqual(args.slice(-4), [
    IMAGE,
    "/app/agy-r16-home-helper.mjs",
    "audit-tools",
    "01234567-89ab-cdef-0123-456789abcdef",
  ]);
});
