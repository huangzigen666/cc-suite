import assert from "node:assert/strict";
import test from "node:test";

import { buildAgyBootstrapPayload } from "../scripts/lib/agy-bootstrap.mjs";

test("R14 bootstrap payload is exact, bounded, and newline terminated", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  assert.equal(
    buildAgyBootstrapPayload(nonce, "172.30.250.6"),
    `${nonce} 172.30.250.6\n`
  );
});

test("R14 bootstrap payload rejects weak nonces and non-private IPv4", () => {
  for (const [nonce, ipv4] of [
    ["predictable", "172.30.250.6"],
    ["A".repeat(32), "172.30.250.6"],
    ["0".repeat(32), "127.0.0.1"],
    ["0".repeat(32), "8.8.8.8"],
    ["0".repeat(32), "2001:db8::1"],
  ]) {
    assert.throws(
      () => buildAgyBootstrapPayload(nonce, ipv4),
      (error) => error.code === "AGY_BOOTSTRAP_PAYLOAD_INVALID"
    );
  }
});
