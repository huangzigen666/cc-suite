import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const AGY_TOOL_POLICY_HOOK_NAME = "cc-suite-r9-deny-all";
export const AGY_TOOL_POLICY_TIMEOUT_SECONDS = 5;
export const AGY_TOOL_POLICY_SOURCE_FILE = fileURLToPath(import.meta.url);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildAgyToolPolicyHookConfig({ nodeExecutable, policyFile }) {
  if (!path.isAbsolute(nodeExecutable || "") || !path.isAbsolute(policyFile || "")) {
    throw new Error("The R9 tool-policy hook requires absolute executable and policy paths");
  }
  return {
    [AGY_TOOL_POLICY_HOOK_NAME]: {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${shellQuote(nodeExecutable)} ${shellQuote(policyFile)}`,
              timeout: AGY_TOOL_POLICY_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

export function evaluateAgyToolPolicy(payload) {
  const name = payload?.toolCall?.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(name)) {
    return {
      decision: "deny",
      reason: "CC_SUITE_R9_POLICY_INPUT_INVALID",
    };
  }
  return {
    decision: "deny",
    reason: `CC_SUITE_R9_POLICY_DENY:${name}`,
  };
}

function runHook() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    payload = null;
  }
  process.stdout.write(JSON.stringify(evaluateAgyToolPolicy(payload)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === AGY_TOOL_POLICY_SOURCE_FILE) {
  runHook();
}
