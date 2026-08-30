import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { buildAgyToolPolicyHookConfig } from "./agy-tool-policy.mjs";

const VALID_EFFORTS = new Set(["low", "medium", "high"]);
const AGY_CUSTOMIZATION_ROOT_NAMES = new Set([
  ".agents",
  ".agent",
  "_agents",
  "_agent",
]);
const R9_ALLOWED_RUNTIME_TOOLS = new Set([
  "find_by_name",
  "finish",
  "grep_search",
  "list_dir",
  "multi_replace_file_content",
  "replace_file_content",
  "sed_file",
  "view_file",
  "write_to_file",
]);

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  let existing = absolute;
  const missingSegments = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }

  const canonicalExisting = fs.realpathSync.native(existing);
  return path.join(canonicalExisting, ...missingSegments);
}

function isSamePath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function isStrictAncestor(candidate, target) {
  const relative = path.relative(canonicalPath(candidate), canonicalPath(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function extractPermissionTarget(rule, action) {
  const match = String(rule).match(new RegExp(`^${action}\\((.*)\\)$`));
  return match?.[1] ?? null;
}

function permissionPathStaysInWorkspace(target, cwd) {
  if (!target || target === "*") return false;
  // Permission targets with expansion/glob syntax are runtime-dependent. The
  // adapter cannot prove their resolved boundary, so it rejects them.
  if (target.startsWith("~") || /[$*?\[\]{}]/.test(target)) return false;
  const resolved = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  return isSamePath(resolved, cwd) || isStrictAncestor(cwd, resolved);
}

function permissionPathExists(target, cwd) {
  if (!target || target === "*" || target.startsWith("~")) return true;
  if (/[$*?\[\]{}]/.test(target)) return true;
  const resolved = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  return fs.existsSync(resolved);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

function isExactPrivateBoundaryFile(file, source, mode) {
  try {
    const stat = fs.lstatSync(file);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o777) === mode &&
      (typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
      typeof source === "string" &&
      fs.readFileSync(file, "utf8") === source
    );
  } catch {
    return false;
  }
}

function directoryTarget(entryPath, workspace) {
  try {
    const resolved = canonicalPath(entryPath);
    const relative = path.relative(workspace, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function scanPluginExecutionSurfaces(pluginsRoot, workspace, findings) {
  const pending = [pluginsRoot];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    const resolved = directoryTarget(current, workspace);
    if (!resolved || visited.has(resolved)) continue;
    visited.add(resolved);
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const entryPath = path.join(resolved, entry.name);
      if (entry.name === "mcp_config.json" || entry.name === "hooks.json") {
        findings.push("WORKSPACE_PLUGIN_EXECUTION_SURFACE_PRESENT");
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) pending.push(entryPath);
    }
  }
}

function scanCustomizationRoot(customizationRoot, workspace, findings) {
  for (const [fileName, finding] of [
    ["mcp_config.json", "WORKSPACE_MCP_CONFIG_PRESENT"],
    ["hooks.json", "WORKSPACE_HOOKS_PRESENT"],
    ["plugins.json", "WORKSPACE_PLUGINS_CONFIG_PRESENT"],
  ]) {
    if (fs.existsSync(path.join(customizationRoot, fileName))) findings.push(finding);
  }
  const pluginsRoot = path.join(customizationRoot, "plugins");
  if (fs.existsSync(pluginsRoot)) {
    scanPluginExecutionSurfaces(pluginsRoot, workspace, findings);
  }
}

export function auditAgyCustomizationSurface(workspacePath) {
  const findings = [];
  let workspace;
  try {
    workspace = canonicalPath(workspacePath);
    if (!fs.statSync(workspace).isDirectory()) {
      return ["WORKSPACE_CUSTOMIZATION_AUDIT_FAILED"];
    }
    const pending = [workspace];
    const visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      const resolved = directoryTarget(current, workspace);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const entryPath = path.join(resolved, entry.name);
        const target = directoryTarget(entryPath, workspace);
        if (!target) continue;
        if (AGY_CUSTOMIZATION_ROOT_NAMES.has(entry.name)) {
          scanCustomizationRoot(target, workspace, findings);
        }
        pending.push(target);
      }
    }
  } catch {
    findings.push("WORKSPACE_CUSTOMIZATION_AUDIT_FAILED");
  }
  return [...new Set(findings)];
}

export function assertAgyCustomizationSurface(workspacePath) {
  const findings = auditAgyCustomizationSurface(workspacePath);
  if (findings.length) {
    throw contractError(
      "AGY_WORKSPACE_CUSTOMIZATION_UNSAFE",
      `Executable AGY workspace customizations are disabled for the R9 internal harness: ${findings.join(", ")}`
    );
  }
}

export function auditIsolatedCustomizationBoundary({
  mcpConfig,
  pluginsConfig,
  hooksConfig,
  hooksConfigFile,
  hooksConfigSource,
  toolPolicyFile,
  toolPolicySource,
  nodeExecutable,
}) {
  const findings = [];
  if (
    !hasExactKeys(mcpConfig, ["mcpServers"]) ||
    !isPlainObject(mcpConfig.mcpServers) ||
    Object.keys(mcpConfig.mcpServers).length !== 0
  ) {
    findings.push("ISOLATED_MCP_CONFIG_UNSAFE");
  }
  if (
    !hasExactKeys(pluginsConfig, ["entries", "inherits"]) ||
    !Array.isArray(pluginsConfig.entries) ||
    pluginsConfig.entries.length !== 0 ||
    !Array.isArray(pluginsConfig.inherits) ||
    pluginsConfig.inherits.length !== 0
  ) {
    findings.push("ISOLATED_PLUGINS_CONFIG_UNSAFE");
  }
  let expectedHooksConfig = null;
  try {
    expectedHooksConfig = buildAgyToolPolicyHookConfig({
      nodeExecutable,
      policyFile: toolPolicyFile,
    });
  } catch {
    // Missing policy identity is reported by both hook and policy findings.
  }
  if (!expectedHooksConfig || !isDeepStrictEqual(hooksConfig, expectedHooksConfig)) {
    findings.push("ISOLATED_HOOKS_CONFIG_UNSAFE");
  }
  if (!isExactPrivateBoundaryFile(hooksConfigFile, hooksConfigSource, 0o400)) {
    findings.push("ISOLATED_HOOKS_CONFIG_UNSAFE");
  }
  if (!isExactPrivateBoundaryFile(toolPolicyFile, toolPolicySource, 0o400)) {
    findings.push("ISOLATED_TOOL_POLICY_UNSAFE");
  }
  return [...new Set(findings)];
}

export function assertAgyRuntimeToolBoundary(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw contractError(
      "AGY_RUNTIME_TOOL_INVENTORY_MISSING",
      "AGY init did not provide a non-empty authoritative tool inventory"
    );
  }
  const unsafe = [...new Set(tools)].filter(
    (tool) => typeof tool !== "string" || !R9_ALLOWED_RUNTIME_TOOLS.has(tool)
  );
  if (unsafe.length) {
    throw contractError(
      "AGY_RUNTIME_TOOL_SURFACE_UNSAFE",
      `AGY exposed tools outside the R9 direct-workspace-file allowlist: ${unsafe.join(", ")}`
    );
  }
}

export function isSameExecutionPath(left, right) {
  try {
    return isSamePath(left, right);
  } catch {
    return false;
  }
}

export function normalizeModelSelection(model, effort) {
  if (!model) {
    throw contractError(
      "AGY_MODEL_REQUIRED",
      "An explicit AGY model slug from preflight is required"
    );
  }
  if (model && !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw contractError(
      "AGY_MODEL_SLUG_INVALID",
      "AGY --model must be a machine slug from preflight, not a display label"
    );
  }
  if (effort && !VALID_EFFORTS.has(effort)) {
    throw contractError(
      "AGY_EFFORT_UNSUPPORTED",
      `Unsupported agy effort '${effort}'; expected low, medium, or high`
    );
  }

  const effortSegments = model.match(/-(?:low|medium|high)(?=-|$)/g) ?? [];
  if (effortSegments.length > 1) {
    throw contractError(
      "AGY_MODEL_PROFILE_AMBIGUOUS",
      `Model '${model}' contains more than one effort segment`
    );
  }
  const encodedEffort = model?.match(/-(low|medium|high)$/)?.[1] ?? null;
  if (encodedEffort && effort && encodedEffort !== effort) {
    throw contractError(
      "AGY_MODEL_EFFORT_CONFLICT",
      `Model '${model}' encodes effort '${encodedEffort}' and conflicts with --effort '${effort}'`
    );
  }

  return {
    model,
    effort: encodedEffort ? null : effort,
  };
}

export function buildAgyArgs(args) {
  if (
    !args.project ||
    args.project === "default-cli-project" ||
    args.project === "outside-of-project"
  ) {
    throw contractError(
      "AGY_PROJECT_REQUIRED",
      "A non-default Antigravity project ID is required"
    );
  }
  if (args.resume) {
    throw contractError(
      "AGY_RESUME_GUARD_UNRESOLVED",
      "Conversation resume is disabled until its project boundary can be verified before tool execution"
    );
  }
  if (args.mode) {
    throw contractError(
      "AGY_MODE_OVERRIDE_DISABLED",
      "Direct --mode overrides are disabled: plan is not read-only and accept-edits is unreliable in agy 1.1.11 print mode"
    );
  }
  if (args.addDirs?.length) {
    throw contractError(
      "AGY_ADD_DIR_DISABLED",
      "--add-dir is disabled until every added root can be covered by the execution boundary audit"
    );
  }
  if (args.sandbox === "read-only") {
    throw contractError(
      "AGY_READ_ONLY_UNENFORCEABLE",
      "agy 1.1.11 plan mode can still execute write_to_file; read-only is disabled pending an enforced permission profile"
    );
  }
  if (args.sandbox === "danger-full-access") {
    throw contractError(
      "AGY_UNSAFE_MODE_DISABLED",
      "danger-full-access is not a supported production mode for the Antigravity runner"
    );
  }
  if (args.sandbox !== "workspace-write") {
    throw contractError(
      "AGY_ACCESS_MODE_INVALID",
      `Unknown agy access mode '${args.sandbox}'`
    );
  }
  if (!args.candidateWorkspaceWrite) {
    throw contractError(
      "AGY_WORKSPACE_WRITE_RUNTIME_PROBE_REQUIRED",
      "workspace-write remains blocked in R14: the credential-free state-volume and exact-egress capsule passed a probe, but OAuth authentication, token refresh, a real model call, chaos teardown, and complete scope-bound evidence are still missing; only the internal harness may collect evidence"
    );
  }
  if (!args.seatbeltWorktreeVerified) {
    throw contractError(
      "AGY_WORKSPACE_WRITE_OS_BOUNDARY_REQUIRED",
      "workspace-write requires the R5 full-process Seatbelt gate in a verified detached linked worktree"
    );
  }

  const selection = normalizeModelSelection(args.model, args.effort);
  const agyArgs = ["--project", args.project];
  if (selection.model) agyArgs.push("--model", selection.model);
  if (selection.effort) agyArgs.push("--effort", selection.effort);

  // In agy 1.1.11, workspace files are already auto-allowed by the global
  // permission engine. `--sandbox` contains terminal commands; it is not a
  // direct-file gate. No execution mode is added here because plan still wrote
  // files in runtime probes and accept-edits timed out after producing output.
  agyArgs.push("--sandbox");
  agyArgs.push("--disable-slash-commands");
  agyArgs.push("--output-format", "stream-json");
  agyArgs.push(
    "--print-timeout",
    `${Math.max(1, Math.round(args.timeoutMs / 1000))}s`
  );
  agyArgs.push("-p", args.prompt);
  return agyArgs;
}

export function createAgyEventState() {
  return {
    eventCount: 0,
    initCount: 0,
    resultCount: 0,
    conversationId: null,
    runtime: null,
    result: null,
    toolErrors: [],
  };
}

export function consumeAgyEventLine(state, line) {
  if (!line.trim()) return;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw contractError(
      "AGY_STREAM_MALFORMED",
      "Antigravity emitted a non-JSON line on its stream-json channel"
    );
  }

  state.eventCount += 1;
  if (state.resultCount > 0 && event.event === "result") {
    throw contractError(
      "AGY_STREAM_RESULT_DUPLICATE",
      "Antigravity emitted more than one result event"
    );
  }
  if (state.resultCount > 0) {
    throw contractError(
      "AGY_STREAM_TRAILING_EVENT",
      "Antigravity emitted an event after the terminal result"
    );
  }
  if (state.initCount === 0 && event.event !== "init") {
    throw contractError(
      "AGY_STREAM_INIT_NOT_FIRST",
      "Antigravity stream did not begin with the authoritative init event"
    );
  }

  if (event.event === "init") {
    state.initCount += 1;
    if (state.initCount > 1) {
      throw contractError(
        "AGY_STREAM_INIT_DUPLICATE",
        "Antigravity emitted more than one init event"
      );
    }
    state.conversationId = event.conversation_id || null;
    state.runtime = {
      model: event.init?.model ?? null,
      cwd: event.init?.cwd ?? null,
      tools: Array.isArray(event.init?.tools) ? event.init.tools : [],
      permissionMode: event.init?.permission_mode ?? null,
    };
    return;
  }

  if (event.event === "result") {
    state.resultCount += 1;
    state.result = event.result ?? {};
    return;
  }

  const toolState = String(event.step_update?.state ?? "").toUpperCase();
  const toolFailed = new Set([
    "ERROR",
    "CANCELLED",
    "CANCELED",
    "DENIED",
    "REJECTED",
  ]).has(toolState);
  if (
    event.event === "step_update" &&
    event.step_update?.step_type === "tool" &&
    (toolFailed || event.step_update?.tool_info?.error)
  ) {
    const toolError = event.step_update?.tool_info?.error ?? {};
    state.toolErrors.push({
      name:
        event.step_update.tool_info?.name ??
        event.step_update.tool_name ??
        "unknown",
      type: toolError.type ?? `TOOL_${toolState || "FAILED"}`,
      message:
        toolError.message ??
        `Antigravity tool terminal state was '${toolState || "unknown"}'`,
    });
  }
}

export function finalizeAgyEventState(state) {
  if (state.initCount !== 1 || !state.conversationId) {
    throw contractError(
      "AGY_STREAM_INIT_MISSING",
      "Antigravity stream ended without one authoritative init conversation identity"
    );
  }
  if (state.resultCount !== 1 || !state.result) {
    throw contractError(
      "AGY_STREAM_RESULT_MISSING",
      "Antigravity stream ended without one terminal result event"
    );
  }
  if (
    state.result.conversation_id &&
    state.result.conversation_id !== state.conversationId
  ) {
    throw contractError(
      "AGY_STREAM_ID_MISMATCH",
      "Antigravity init and result events reported different conversation IDs"
    );
  }
  if (state.result.status !== "SUCCESS") {
    throw contractError(
      "AGY_RESULT_ERROR",
      state.result.error || `Antigravity result status was '${state.result.status ?? "missing"}'`
    );
  }
  if (state.toolErrors.length) {
    const first = state.toolErrors[0];
    throw contractError(
      "AGY_TOOL_ERROR",
      `${first.name} failed [${first.type}]: ${first.message}`
    );
  }

  return {
    conversationId: state.conversationId,
    rawOutput: String(state.result.response ?? "").trim(),
    runtime: state.runtime,
    usage: state.result.usage ?? null,
  };
}

export function auditExecutionBoundary({
  cwd,
  projectConfig,
  settings,
  sharedConfig,
}) {
  const findings = [];

  if (!projectConfig || !settings || !sharedConfig) {
    return ["BOUNDARY_CONFIG_MISSING"];
  }

  const resources = projectConfig.projectResources?.resources;
  if (!Array.isArray(resources) || resources.length !== 1 || !resources[0]?.folderUri) {
    findings.push("PROJECT_RESOURCE_SCOPE_UNSUPPORTED");
  } else {
    try {
      const projectRoot = fileURLToPath(resources[0].folderUri);
      if (!isSamePath(projectRoot, cwd)) {
        findings.push("PROJECT_WORKSPACE_MISMATCH");
      }
    } catch {
      findings.push("PROJECT_RESOURCE_INVALID");
    }
  }

  // AGY 1.1.11 loads Project grants into an in-memory permission overlay. R4
  // proved that a Project-scoped write_file(<workspace>) grant could still
  // authorize a sibling-path write, so the probe runner must reject every
  // Project auto-approval instead of assuming its target is an enforcement
  // boundary. Restrictive deny/ask entries remain allowed, but malformed grant
  // envelopes fail closed.
  const projectPermissionEnvelope = projectConfig.permissionGrants;
  if (projectPermissionEnvelope !== undefined && projectPermissionEnvelope !== null) {
    const projectPermissions = projectPermissionEnvelope.permissionGrants;
    if (
      !projectPermissions ||
      typeof projectPermissions !== "object" ||
      Array.isArray(projectPermissions)
    ) {
      findings.push("PROJECT_PERMISSION_GRANTS_INVALID");
    } else {
      for (const listName of ["allow", "deny", "ask"]) {
        if (
          projectPermissions[listName] !== undefined &&
          !Array.isArray(projectPermissions[listName])
        ) {
          findings.push("PROJECT_PERMISSION_GRANTS_INVALID");
        }
      }
      if (
        Array.isArray(projectPermissions.allow) &&
        projectPermissions.allow.length > 0
      ) {
        findings.push("PROJECT_PERMISSION_AUTO_APPROVAL_PRESENT");
      }
    }
  }

  // The CLI uses sparse persistence and removes this key when it equals the
  // documented default (`false`). Only an explicit non-false value is unsafe.
  if (
    settings.allowNonWorkspaceAccess !== undefined &&
    settings.allowNonWorkspaceAccess !== false
  ) {
    findings.push("NON_WORKSPACE_ACCESS_ALLOWED");
  }

  const trusted = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces
    : [];
  if (!trusted.some((entry) => isSamePath(entry, cwd))) {
    findings.push("WORKSPACE_NOT_EXACTLY_TRUSTED");
  }
  if (trusted.some((entry) => isStrictAncestor(entry, cwd))) {
    findings.push("TRUSTED_WORKSPACE_TOO_BROAD");
  }

  const allowed = Array.isArray(settings.permissions?.allow)
    ? settings.permissions.allow
    : [];
  for (const rule of allowed) {
    const parsedRule = String(rule).match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\((.*)\)$/);
    if (!parsedRule) {
      findings.push("UNRECOGNIZED_AUTO_APPROVAL");
      continue;
    }
    const action = parsedRule[1];
    if (action !== "read_file" && action !== "write_file") {
      findings.push(`${action.toUpperCase().replaceAll("-", "_")}_AUTO_APPROVAL_PRESENT`);
    }

    const writeTarget = extractPermissionTarget(rule, "write_file");
    if (writeTarget !== null) {
      if (!permissionPathExists(writeTarget, cwd)) {
        findings.push("WRITE_TARGET_MISSING");
      } else if (!permissionPathStaysInWorkspace(writeTarget, cwd)) {
        findings.push(
          writeTarget === "*" ? "GLOBAL_WRITE_ALLOWED" : "EXTERNAL_WRITE_ALLOWED"
        );
      }
    }

    const readTarget = extractPermissionTarget(rule, "read_file");
    if (readTarget !== null) {
      if (!permissionPathExists(readTarget, cwd)) {
        findings.push("READ_TARGET_MISSING");
      } else if (!permissionPathStaysInWorkspace(readTarget, cwd)) {
        findings.push(
          readTarget === "*" ? "GLOBAL_READ_ALLOWED" : "EXTERNAL_READ_ALLOWED"
        );
      }
    }

  }

  const explicitWorkspaceWrite = allowed.some((rule) => {
    const target = extractPermissionTarget(rule, "write_file");
    if (target === null || target === "*" || target.startsWith("~")) return false;
    if (/[$*?\[\]{}]/.test(target)) return false;
    const resolved = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    return fs.existsSync(resolved) && isSamePath(resolved, cwd);
  });
  if (!explicitWorkspaceWrite) {
    findings.push("WORKSPACE_WRITE_NOT_EXPLICITLY_ALLOWED");
  }

  const sharedUserSettings = sharedConfig.userSettings;
  if (!sharedUserSettings || typeof sharedUserSettings !== "object") {
    findings.push("SHARED_USER_SETTINGS_MISSING");
  } else {
    if (
      sharedUserSettings.nonWorkspaceFileAccessPolicy !==
      "AGENT_SETTING_POLICY_DENY"
    ) {
      findings.push("SHARED_NON_WORKSPACE_ACCESS_UNSAFE");
    }
    if (
      sharedUserSettings.autoExecutionPolicy !==
      "CASCADE_COMMANDS_AUTO_EXECUTION_OFF"
    ) {
      findings.push("SHARED_COMMAND_AUTO_EXECUTION_UNSAFE");
    }
    if (
      sharedUserSettings.artifactReviewMode !==
      "ARTIFACT_REVIEW_MODE_ALWAYS"
    ) {
      findings.push("SHARED_ARTIFACT_REVIEW_UNSAFE");
    }
    if (
      sharedUserSettings.browserJsExecutionPolicy !==
        "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK" &&
      sharedUserSettings.browserJsExecutionPolicy !==
        "BROWSER_JS_EXECUTION_POLICY_DISABLED"
    ) {
      findings.push("SHARED_BROWSER_JS_EXECUTION_UNSAFE");
    }
    const sharedAutoApprovals = sharedUserSettings.permissions?.allow;
    if (Array.isArray(sharedAutoApprovals) && sharedAutoApprovals.length) {
      findings.push("SHARED_PERMISSION_AUTO_APPROVAL_PRESENT");
    }
  }

  return [...new Set(findings)];
}

export function makeAgyContractError(code, message) {
  return contractError(code, message);
}
