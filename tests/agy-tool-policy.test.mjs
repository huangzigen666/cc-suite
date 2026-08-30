import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAgyToolPolicy } from "../scripts/lib/agy-tool-policy.mjs";

test("R9 tool policy denies every known and future tool call", () => {
  for (const name of [
    "write_to_file",
    "run_command",
    "call_mcp_tool",
    "open_browser_url",
    "invoke_subagent",
    "unknown_future_tool",
  ]) {
    assert.deepEqual(evaluateAgyToolPolicy({ toolCall: { name, args: {} } }), {
      decision: "deny",
      reason: `CC_SUITE_R9_POLICY_DENY:${name}`,
    });
  }
});

test("R9 tool policy rejects malformed envelopes without throwing", () => {
  for (const payload of [null, {}, { toolCall: {} }, { toolCall: { name: "bad\nname" } }]) {
    assert.deepEqual(evaluateAgyToolPolicy(payload), {
      decision: "deny",
      reason: "CC_SUITE_R9_POLICY_INPUT_INVALID",
    });
  }
});
