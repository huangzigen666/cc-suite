import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertAgyRuntimeToolBoundary,
  auditAgyCustomizationSurface,
  auditExecutionBoundary,
  auditIsolatedCustomizationBoundary,
  buildAgyArgs,
  consumeAgyEventLine,
  createAgyEventState,
  finalizeAgyEventState,
  isSameExecutionPath,
  normalizeModelSelection,
} from "../scripts/lib/agy-contract.mjs";
import { buildAgyToolPolicyHookConfig } from "../scripts/lib/agy-tool-policy.mjs";

function baseArgs(overrides = {}) {
  return {
    project: "project-123",
    model: "gemini-3.6-flash-low",
    effort: null,
    sandbox: "workspace-write",
    mode: null,
    addDirs: [],
    resume: null,
    timeoutMs: 10_000,
    prompt: "hello",
    candidateWorkspaceWrite: true,
    seatbeltWorktreeVerified: true,
    ...overrides,
  };
}

function safeSharedConfig(overrides = {}) {
  return {
    userSettings: {
      nonWorkspaceFileAccessPolicy: "AGENT_SETTING_POLICY_DENY",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
      browserJsExecutionPolicy: "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK",
      ...overrides,
    },
  };
}

test("workspace-write uses an explicit project, terminal sandbox, and stream-json", () => {
  const argv = buildAgyArgs(baseArgs());

  assert.deepEqual(argv.slice(0, 4), [
    "--project",
    "project-123",
    "--model",
    "gemini-3.6-flash-low",
  ]);
  assert.ok(argv.includes("--sandbox"));
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  assert.ok(!argv.includes("--mode"));
});

test("runtime tool inventory fails closed on alternate mutators and unknown tools", () => {
  assert.doesNotThrow(() =>
    assertAgyRuntimeToolBoundary([
      "finish",
      "find_by_name",
      "grep_search",
      "list_dir",
      "multi_replace_file_content",
      "replace_file_content",
      "sed_file",
      "view_file",
      "write_to_file",
    ])
  );

  for (const tool of [
    "browser_subagent",
    "call_mcp_tool",
    "define_subagent",
    "execute_browser_javascript",
    "invoke_subagent",
    "manage_subagents",
    "notebook_execution",
    "open_browser_url",
    "run_command",
    "schedule",
    "send_message",
    "unknown_future_tool",
  ]) {
    assert.throws(
      () => assertAgyRuntimeToolBoundary(["view_file", tool]),
      (error) =>
        error.code === "AGY_RUNTIME_TOOL_SURFACE_UNSAFE" &&
        error.message.includes(tool)
    );
  }

  assert.throws(
    () => assertAgyRuntimeToolBoundary([]),
    (error) => error.code === "AGY_RUNTIME_TOOL_INVENTORY_MISSING"
  );
});

test("workspace customization audit rejects executable AGY surfaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-agy-customizations-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, ".agents", "rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "rules", "safe.md"), "safe\n");
  fs.mkdirSync(path.join(root, ".agents", "plugins", "safe"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agents", "plugins", "safe", "plugin.json"),
    "{}\n"
  );
  assert.deepEqual(auditAgyCustomizationSurface(root), []);

  fs.writeFileSync(path.join(root, ".agents", "mcp_config.json"), "{}\n");
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "hooks.json"), "{}\n");
  fs.mkdirSync(path.join(root, "nested", "_agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "_agents", "plugins.json"), "{}\n");
  fs.mkdirSync(path.join(root, "_agent", "plugins", "unsafe"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "_agent", "plugins", "unsafe", "mcp_config.json"),
    "{}\n"
  );

  const findings = auditAgyCustomizationSurface(root);
  assert.ok(findings.includes("WORKSPACE_MCP_CONFIG_PRESENT"));
  assert.ok(findings.includes("WORKSPACE_HOOKS_PRESENT"));
  assert.ok(findings.includes("WORKSPACE_PLUGINS_CONFIG_PRESENT"));
  assert.ok(findings.includes("WORKSPACE_PLUGIN_EXECUTION_SURFACE_PRESENT"));
});

test("isolated customization boundary requires empty MCP/plugins and the exact R9 deny hook", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-r9-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const toolPolicyFile = path.join(root, "agy-tool-policy.mjs");
  const toolPolicySource = "// exact R9 policy\n";
  fs.writeFileSync(toolPolicyFile, toolPolicySource, { mode: 0o400 });
  const nodeExecutable = process.execPath;
  const hooksConfig = buildAgyToolPolicyHookConfig({
    nodeExecutable,
    policyFile: toolPolicyFile,
  });
  const hooksConfigFile = path.join(root, "hooks.json");
  const hooksConfigSource = `${JSON.stringify(hooksConfig, null, 2)}\n`;
  fs.writeFileSync(hooksConfigFile, hooksConfigSource, { mode: 0o400 });
  assert.deepEqual(
    auditIsolatedCustomizationBoundary({
      mcpConfig: { mcpServers: {} },
      pluginsConfig: { entries: [], inherits: [] },
      hooksConfig,
      hooksConfigFile,
      hooksConfigSource,
      toolPolicyFile,
      toolPolicySource,
      nodeExecutable,
    }),
    []
  );

  fs.chmodSync(hooksConfigFile, 0o600);
  assert.ok(
    auditIsolatedCustomizationBoundary({
      mcpConfig: { mcpServers: {} },
      pluginsConfig: { entries: [], inherits: [] },
      hooksConfig,
      hooksConfigFile,
      hooksConfigSource,
      toolPolicyFile,
      toolPolicySource,
      nodeExecutable,
    }).includes("ISOLATED_HOOKS_CONFIG_UNSAFE")
  );
  fs.chmodSync(hooksConfigFile, 0o400);

  const findings = auditIsolatedCustomizationBoundary({
    mcpConfig: { mcpServers: { escape: { serverUrl: "https://example.invalid" } } },
    pluginsConfig: { entries: [{ path: "/tmp/plugin" }], inherits: [] },
    hooksConfig: { escape: { PreInvocation: [] } },
    hooksConfigFile,
    hooksConfigSource,
    toolPolicyFile,
    toolPolicySource: "// different\n",
    nodeExecutable,
  });
  assert.ok(findings.includes("ISOLATED_MCP_CONFIG_UNSAFE"));
  assert.ok(findings.includes("ISOLATED_PLUGINS_CONFIG_UNSAFE"));
  assert.ok(findings.includes("ISOLATED_HOOKS_CONFIG_UNSAFE"));
  assert.ok(findings.includes("ISOLATED_TOOL_POLICY_UNSAFE"));
});

test("unsafe or unproven access modes fail closed before spawn", () => {
  assert.throws(
    () => buildAgyArgs(baseArgs({ candidateWorkspaceWrite: false })),
    (error) => error.code === "AGY_WORKSPACE_WRITE_RUNTIME_PROBE_REQUIRED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ seatbeltWorktreeVerified: false })),
    (error) => error.code === "AGY_WORKSPACE_WRITE_OS_BOUNDARY_REQUIRED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ model: null })),
    (error) => error.code === "AGY_MODEL_REQUIRED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ sandbox: "read-only" })),
    (error) => error.code === "AGY_READ_ONLY_UNENFORCEABLE"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ sandbox: "danger-full-access" })),
    (error) => error.code === "AGY_UNSAFE_MODE_DISABLED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ project: "default-cli-project" })),
    (error) => error.code === "AGY_PROJECT_REQUIRED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ mode: "plan" })),
    (error) => error.code === "AGY_MODE_OVERRIDE_DISABLED"
  );
  assert.throws(
    () => buildAgyArgs(baseArgs({ addDirs: ["/tmp/extra"] })),
    (error) => error.code === "AGY_ADD_DIR_DISABLED"
  );
});

test("model suffix is the authoritative effort when the slug encodes one", () => {
  assert.deepEqual(
    normalizeModelSelection("gemini-3.6-flash-low", null),
    { model: "gemini-3.6-flash-low", effort: null }
  );
  assert.deepEqual(
    normalizeModelSelection("gemini-3.6-flash-low", "low"),
    { model: "gemini-3.6-flash-low", effort: null }
  );
  assert.throws(
    () => normalizeModelSelection("gemini-3.6-flash-low", "high"),
    (error) => error.code === "AGY_MODEL_EFFORT_CONFLICT"
  );
  assert.throws(
    () => normalizeModelSelection("gemini-3.6-flash-low\tGemini 3.6 Flash (Low)", null),
    (error) => error.code === "AGY_MODEL_SLUG_INVALID"
  );
  assert.throws(
    () => normalizeModelSelection("gemini-flash-high-high", null),
    (error) => error.code === "AGY_MODEL_PROFILE_AMBIGUOUS"
  );
  assert.deepEqual(
    normalizeModelSelection("gemini-high-flash", "low"),
    { model: "gemini-high-flash", effort: "low" }
  );
  assert.deepEqual(
    normalizeModelSelection("claude-sonnet-4-6", "high"),
    { model: "claude-sonnet-4-6", effort: "high" }
  );
});

test("stream-json state uses init identity and result payload", () => {
  const state = createAgyEventState();
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-1",
      init: {
        model: "gemini-3.6-flash-low",
        cwd: "/workspace",
        tools: ["view_file"],
        permission_mode: "request-review",
      },
    })
  );
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conversation-1",
        status: "SUCCESS",
        response: "done\n",
        usage: { total_tokens: 42 },
      },
    })
  );

  assert.deepEqual(finalizeAgyEventState(state), {
    conversationId: "conversation-1",
    rawOutput: "done",
    runtime: {
      model: "gemini-3.6-flash-low",
      cwd: "/workspace",
      tools: ["view_file"],
      permissionMode: "request-review",
    },
    usage: { total_tokens: 42 },
  });
});

test("stream-json protocol fails on malformed, missing, or contradictory terminal events", () => {
  const malformed = createAgyEventState();
  assert.throws(
    () => consumeAgyEventLine(malformed, "not json"),
    (error) => error.code === "AGY_STREAM_MALFORMED"
  );

  const outOfOrder = createAgyEventState();
  assert.throws(
    () => consumeAgyEventLine(outOfOrder, JSON.stringify({ event: "step_update" })),
    (error) => error.code === "AGY_STREAM_INIT_NOT_FIRST"
  );

  const missingInit = createAgyEventState();
  assert.throws(
    () => finalizeAgyEventState(missingInit),
    (error) => error.code === "AGY_STREAM_INIT_MISSING"
  );

  const resultFirst = createAgyEventState();
  assert.throws(
    () =>
      consumeAgyEventLine(
        resultFirst,
        JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "done" },
        })
      ),
    (error) => error.code === "AGY_STREAM_INIT_NOT_FIRST"
  );

  const trailing = createAgyEventState();
  consumeAgyEventLine(
    trailing,
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-3",
      init: { cwd: "/workspace" },
    })
  );
  consumeAgyEventLine(
    trailing,
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "done" },
    })
  );
  assert.throws(
    () => consumeAgyEventLine(trailing, JSON.stringify({ event: "step_update" })),
    (error) => error.code === "AGY_STREAM_TRAILING_EVENT"
  );
  assert.throws(
    () => consumeAgyEventLine(trailing, JSON.stringify({ event: "result" })),
    (error) => error.code === "AGY_STREAM_RESULT_DUPLICATE"
  );

  const failed = createAgyEventState();
  consumeAgyEventLine(
    failed,
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-2",
      init: { cwd: "/workspace" },
    })
  );
  consumeAgyEventLine(
    failed,
    JSON.stringify({
      event: "result",
      result: { status: "ERROR", error: "timeout waiting for response" },
    })
  );
  assert.throws(
    () => finalizeAgyEventState(failed),
    (error) =>
      error.code === "AGY_RESULT_ERROR" &&
      error.message.includes("timeout waiting for response")
  );
});

test("stream-json reports a failed tool even when the terminal result says SUCCESS", () => {
  const state = createAgyEventState();
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-tool-error",
      init: { cwd: "/workspace" },
    })
  );
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "step_update",
      step_update: {
        state: "ERROR",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          error: {
            type: "TOOL_ERROR",
            message: "User denied permission for write_file(/workspace/file.txt).",
          },
        },
      },
    })
  );
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "" },
    })
  );

  assert.throws(
    () => finalizeAgyEventState(state),
    (error) =>
      error.code === "AGY_TOOL_ERROR" &&
      error.message.includes("User denied permission")
  );
});

test("stream-json treats cancelled tool states as failures without an error payload", () => {
  const state = createAgyEventState();
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "init",
      conversation_id: "conversation-tool-cancelled",
      init: { cwd: "/workspace" },
    })
  );
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "step_update",
      step_update: {
        state: "CANCELLED",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file" },
      },
    })
  );
  consumeAgyEventLine(
    state,
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "" },
    })
  );

  assert.throws(
    () => finalizeAgyEventState(state),
    (error) =>
      error.code === "AGY_TOOL_ERROR" &&
      error.message.includes("CANCELLED")
  );
});

test("boundary audit rejects broad trust, non-workspace access, and project/cwd mismatch", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-agy-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);

  const projectConfig = {
    id: "project-123",
    projectResources: {
      resources: [{ folderUri: pathToFileURL(workspace).href }],
    },
  };

  assert.deepEqual(
    auditExecutionBoundary({
      cwd: workspace,
      projectConfig,
      settings: {
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [workspace],
        permissions: { allow: [`read_file(${workspace})`, `write_file(${workspace})`] },
      },
      sharedConfig: safeSharedConfig(),
    }),
    []
  );

  assert.deepEqual(
    auditExecutionBoundary({
      cwd: workspace,
      projectConfig,
      settings: {
        trustedWorkspaces: [workspace],
        permissions: { allow: [`write_file(${workspace})`] },
      },
      sharedConfig: safeSharedConfig(),
    }),
    []
  );

  const projectGrantFindings = auditExecutionBoundary({
    cwd: workspace,
    projectConfig: {
      ...projectConfig,
      permissionGrants: {
        permissionGrants: {
          allow: [`write_file(${workspace})`],
          deny: [],
          ask: [],
        },
      },
    },
    settings: {
      trustedWorkspaces: [workspace],
      permissions: { allow: [`write_file(${workspace})`] },
    },
    sharedConfig: safeSharedConfig(),
  });
  assert.ok(
    projectGrantFindings.includes("PROJECT_PERMISSION_AUTO_APPROVAL_PRESENT")
  );
  assert.ok(
    auditExecutionBoundary({
      cwd: workspace,
      projectConfig: { ...projectConfig, permissionGrants: { permissionGrants: [] } },
      settings: {
        trustedWorkspaces: [workspace],
        permissions: { allow: [`write_file(${workspace})`] },
      },
      sharedConfig: safeSharedConfig(),
    }).includes("PROJECT_PERMISSION_GRANTS_INVALID")
  );

  const findings = auditExecutionBoundary({
    cwd: workspace,
    projectConfig,
    settings: {
      allowNonWorkspaceAccess: true,
      trustedWorkspaces: ["/"],
      permissions: {
        allow: [
          "write_file(*)",
          `write_file(${outside})`,
          `write_file(${workspace}/future.txt)`,
          "write_file(~/escape.txt)",
          `read_file(${workspace}/**)`,
          `read_file(${outside})`,
          `read_file(${workspace}/missing.txt)`,
          "unsandboxed(*)",
          "unsandboxed(git push)",
          "command(git status)",
          "read_url(example.com)",
          "mcp(database/mutate)",
          "execute_url(example.com)",
        ],
      },
    },
    sharedConfig: safeSharedConfig({
      nonWorkspaceFileAccessPolicy: "AGENT_SETTING_POLICY_ALLOW",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_TURBO",
      browserJsExecutionPolicy: "BROWSER_JS_EXECUTION_POLICY_TURBO",
      permissions: { allow: ["command(*)"] },
    }),
  });
  assert.ok(findings.includes("NON_WORKSPACE_ACCESS_ALLOWED"));
  assert.ok(findings.includes("TRUSTED_WORKSPACE_TOO_BROAD"));
  assert.ok(findings.includes("GLOBAL_WRITE_ALLOWED"));
  assert.ok(findings.includes("EXTERNAL_WRITE_ALLOWED"));
  assert.ok(findings.includes("EXTERNAL_READ_ALLOWED"));
  assert.ok(findings.includes("WRITE_TARGET_MISSING"));
  assert.ok(findings.includes("READ_TARGET_MISSING"));
  assert.ok(findings.includes("UNSANDBOXED_AUTO_APPROVAL_PRESENT"));
  assert.ok(findings.includes("COMMAND_AUTO_APPROVAL_PRESENT"));
  assert.ok(findings.includes("READ_URL_AUTO_APPROVAL_PRESENT"));
  assert.ok(findings.includes("MCP_AUTO_APPROVAL_PRESENT"));
  assert.ok(findings.includes("EXECUTE_URL_AUTO_APPROVAL_PRESENT"));
  assert.ok(findings.includes("WORKSPACE_WRITE_NOT_EXPLICITLY_ALLOWED"));
  assert.ok(findings.includes("SHARED_NON_WORKSPACE_ACCESS_UNSAFE"));
  assert.ok(findings.includes("SHARED_COMMAND_AUTO_EXECUTION_UNSAFE"));
  assert.ok(findings.includes("SHARED_ARTIFACT_REVIEW_UNSAFE"));
  assert.ok(findings.includes("SHARED_BROWSER_JS_EXECUTION_UNSAFE"));
  assert.ok(findings.includes("SHARED_PERMISSION_AUTO_APPROVAL_PRESENT"));

  assert.ok(
    auditExecutionBoundary({
      cwd: outside,
      projectConfig,
      settings: {
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [outside],
        permissions: { allow: [`write_file(${outside})`] },
      },
      sharedConfig: safeSharedConfig(),
    }).includes("PROJECT_WORKSPACE_MISMATCH")
  );
});

test("execution path identity resolves aliases and rejects invalid values", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-agy-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const alias = path.join(root, "alias");
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, alias);

  assert.equal(isSameExecutionPath(workspace, alias), true);
  assert.equal(isSameExecutionPath(workspace, null), false);
});

test("boundary audit resolves symlinks before checking file grants", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-agy-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "escape.txt"), "escape");
  fs.symlinkSync(outside, path.join(workspace, "link"));

  const findings = auditExecutionBoundary({
    cwd: workspace,
    projectConfig: {
      projectResources: {
        resources: [{ folderUri: pathToFileURL(workspace).href }],
      },
    },
    settings: {
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: [workspace],
      permissions: {
        allow: [
          `write_file(${workspace})`,
          "write_file(link/escape.txt)",
          "write_file(future.txt)",
        ],
      },
    },
    sharedConfig: safeSharedConfig(),
  });

  assert.ok(findings.includes("EXTERNAL_WRITE_ALLOWED"));
  assert.ok(findings.includes("WRITE_TARGET_MISSING"));
});
