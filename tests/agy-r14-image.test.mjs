import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = new URL(
  "../dev-probes/agy-r14/capsule/entrypoint.sh",
  import.meta.url
);
test("R14 capsule quarantines networking before waiting for the exact proxy IP", () => {
  const source = fs.readFileSync(ENTRYPOINT, "utf8");
  const quarantine = source.indexOf("table inet agy_quarantine");
  const waitForProxy = source.indexOf("/usr/local/bin/agy-bootstrap-receiver");
  const finalPolicy = source.indexOf("table inet agy_guard");

  assert.ok(quarantine > 0);
  assert.ok(waitForProxy > quarantine);
  assert.ok(finalPolicy > waitForProxy);
  assert.match(source, /policy drop/);
  assert.match(source, /ip daddr \$\{proxy_ip\} tcp dport \$\{proxy_port\}/);
});

test("R14 capsule requires one ext4 OAuth mount and initializes state as final uid", () => {
  const source = fs.readFileSync(ENTRYPOINT, "utf8");

  assert.match(source, /require_mount \/home\/agy rw/);
  assert.match(source, /-o FSTYPE/);
  assert.match(source, /= "ext4"/);
  assert.match(source, /chown 65532:65532 \/home\/agy/);
  assert.match(source, /setpriv --reuid=65532 --regid=65532 --clear-groups/);
  assert.match(source, /chmod 0700 \/home\/agy/);
  assert.match(source, /for state_directory in \.cache \.config \.gemini/);
  assert.match(source, /state_path="\/home\/agy\/\$\{state_directory\}"/);
  assert.match(source, /unexpected owner/);
});

test("R14 loopback handoff requires a one-time nonce and removes the ingress rule", () => {
  const source = fs.readFileSync(ENTRYPOINT, "utf8");

  assert.match(source, /AGY_BOOTSTRAP_NONCE/);
  assert.match(source, /\[ "\$\{#bootstrap_nonce\}" -eq 32 \]/);
  assert.match(source, /received_nonce.*bootstrap_nonce/);
  assert.equal(source.includes("set -- $handoff_payload"), false);
  assert.match(source, /proxy_ip=\$\{handoff_payload#\* \}/);
  const quarantinePort = source.indexOf("tcp dport ${bootstrap_port}");
  const finalPolicy = source.indexOf("table inet agy_guard");
  assert.ok(quarantinePort > 0);
  assert.ok(finalPolicy > quarantinePort);
  assert.equal(source.slice(finalPolicy).includes("bootstrap_port"), false);
});

test("R14 observation summary is explicitly partial and binds current sources", () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const summary = JSON.parse(fs.readFileSync(
    path.join(repository, "dev-probes/agy-r14/observation-summary.json"),
    "utf8"
  ));

  assert.equal(summary.status, "blocked-no-go");
  assert.equal(summary.promotionEligible, false);
  assert.equal(summary.oneBoundCapsuleRun, false);
  assert.equal(summary.oauthAttempted, false);
  assert.equal(summary.realModelCallAttempted, false);
  assert.equal(summary.artifactLogsRetained, false);
  assert.equal(Object.hasOwn(summary.successfulProbe, "bootstrapNonce"), false);
  for (const [relativePath, expected] of Object.entries(summary.sourceSha256)) {
    const actual = createHash("sha256")
      .update(fs.readFileSync(path.join(repository, relativePath)))
      .digest("hex");
    assert.equal(actual, expected, relativePath);
  }
});
