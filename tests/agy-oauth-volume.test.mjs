import assert from "node:assert/strict";
import test from "node:test";

import {
  auditAgyOAuthVolumeDescriptor,
  buildAgyOAuthVolumeCreateArgs,
  createAgyOAuthVolumeName,
  prepareAgyOAuthVolume,
} from "../scripts/lib/agy-oauth-volume.mjs";

const NAME = "cc-suite-agy-oauth-0123456789abcdef";
const HOME = "/Users/ccsuite-test";
const SOURCE_ROOT = `${HOME}/Library/Application Support/com.apple.container/volumes`;
const NOW = new Date("2026-08-10T18:43:00.000Z");

function validDescriptor(overrides = {}) {
  return {
    configuration: {
      creationDate: "2026-08-10T18:42:47Z",
      driver: "local",
      format: "ext4",
      labels: {
        "cc-suite.owner": "cc-suite",
        "cc-suite.purpose": "agy-oauth-state",
        "cc-suite.schema": "1",
        "cc-suite.sensitivity": "oauth",
      },
      name: NAME,
      options: { size: "256M" },
      sizeInBytes: 268435456,
      source: `${SOURCE_ROOT}/${NAME}/volume.img`,
      ...overrides,
    },
    id: NAME,
  };
}

const EXPECTED = {
  expectedName: NAME,
  expectedSourceRoot: SOURCE_ROOT,
  expectedSizeInBytes: 268435456,
  maxCreationAgeMs: 10 * 60 * 1000,
  now: NOW,
};

test("R14 accepts only the exact labeled local ext4 OAuth volume", () => {
  const result = auditAgyOAuthVolumeDescriptor(validDescriptor(), EXPECTED);

  assert.equal(result.ready, true);
  assert.deepEqual(result.findings, []);
});

test("R14 generates strong names and shell-free exact create arguments", () => {
  const first = createAgyOAuthVolumeName();
  const second = createAgyOAuthVolumeName();
  assert.match(first, /^cc-suite-agy-oauth-[a-f0-9]{16}$/);
  assert.match(second, /^cc-suite-agy-oauth-[a-f0-9]{16}$/);
  assert.notEqual(first, second);

  assert.deepEqual(buildAgyOAuthVolumeCreateArgs(NAME), [
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
    "256M",
    NAME,
  ]);
});

test("R14 rejects descriptor identity, label, format, driver, and size drift", () => {
  for (const [override, finding] of [
    [{ name: "other" }, "AGY_OAUTH_VOLUME_NAME_MISMATCH"],
    [{ driver: "bind" }, "AGY_OAUTH_VOLUME_DRIVER_INVALID"],
    [{ format: "apfs" }, "AGY_OAUTH_VOLUME_FORMAT_INVALID"],
    [{ labels: {} }, "AGY_OAUTH_VOLUME_LABELS_INVALID"],
    [{ sizeInBytes: 67108864 }, "AGY_OAUTH_VOLUME_SIZE_MISMATCH"],
  ]) {
    const result = auditAgyOAuthVolumeDescriptor(validDescriptor(override), EXPECTED);
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes(finding));
  }

  const wrongId = validDescriptor();
  wrongId.id = "other";
  const result = auditAgyOAuthVolumeDescriptor(wrongId, EXPECTED);
  assert.equal(result.ready, false);
  assert.ok(result.findings.includes("AGY_OAUTH_VOLUME_ID_MISMATCH"));
});

test("R14 rejects source-path escapes and loose expected scope", () => {
  const escape = auditAgyOAuthVolumeDescriptor(
    validDescriptor({ source: `/tmp/${NAME}/volume.img` }),
    EXPECTED
  );
  assert.equal(escape.ready, false);
  assert.ok(escape.findings.includes("AGY_OAUTH_VOLUME_SOURCE_MISMATCH"));

  const loose = auditAgyOAuthVolumeDescriptor(validDescriptor(), {});
  assert.equal(loose.ready, false);
  assert.ok(loose.findings.includes("AGY_OAUTH_VOLUME_EXPECTED_SCOPE_INVALID"));
});

test("R14 rejects stale, future, and malformed creation timestamps", () => {
  for (const [creationDate, finding] of [
    ["2026-08-10 18:42:47Z", "AGY_OAUTH_VOLUME_TIME_INVALID"],
    ["2026-08-10T18:44:00Z", "AGY_OAUTH_VOLUME_TIME_FROM_FUTURE"],
    ["2026-08-09T18:42:47Z", "AGY_OAUTH_VOLUME_STALE"],
  ]) {
    const result = auditAgyOAuthVolumeDescriptor(
      validDescriptor({ creationDate }),
      EXPECTED
    );
    assert.equal(result.ready, false);
    assert.ok(result.findings.includes(finding));
  }
});

test("R14 creates, inspects, and returns only an independently audited volume", () => {
  const calls = [];
  const result = prepareAgyOAuthVolume({
    expectedName: NAME,
    homeDirectory: HOME,
    now: NOW,
    runContainer(args) {
      calls.push(args);
      if (args[1] === "create") return { status: 0, stdout: `${NAME}\n` };
      if (args[1] === "inspect") {
        return { status: 0, stdout: JSON.stringify(validDescriptor()) };
      }
      throw new Error("unexpected command");
    },
  });

  assert.equal(result.ready, true);
  assert.equal(result.name, NAME);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(calls, [
    buildAgyOAuthVolumeCreateArgs(NAME),
    ["volume", "inspect", NAME],
  ]);
});

test("R14 deletes only the just-created exact volume when inspection cannot prove it", () => {
  const calls = [];
  assert.throws(
    () => prepareAgyOAuthVolume({
      expectedName: NAME,
      homeDirectory: HOME,
      now: NOW,
      runContainer(args) {
        calls.push(args);
        if (args[1] === "create") return { status: 0, stdout: `${NAME}\n` };
        if (args[1] === "inspect") {
          return {
            status: 0,
            stdout: JSON.stringify(validDescriptor({ labels: {} })),
          };
        }
        if (args[1] === "delete") return { status: 0, stdout: "" };
        throw new Error("unexpected command");
      },
    }),
    (error) => error.code === "AGY_OAUTH_VOLUME_AUDIT_FAILED"
  );

  assert.deepEqual(calls.at(-1), ["volume", "delete", NAME]);
  assert.equal(calls.some((args) => args.includes("--all")), false);
});
