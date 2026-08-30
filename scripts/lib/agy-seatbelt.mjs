import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  AGY_TOOL_POLICY_SOURCE_FILE,
  buildAgyToolPolicyHookConfig,
} from "./agy-tool-policy.mjs";

export const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const AGY_SEATBELT_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny appleevent-send)",
  "(deny network-outbound (remote unix-socket))",
  "(deny network-outbound",
  "  (require-not (remote ip (param \"CC_SUITE_EGRESS_PROXY\"))))",
  "(deny file-write* (literal (param \"CC_SUITE_AGY_HOOKS\")))",
  "(deny file-write* (literal (param \"CC_SUITE_AGY_TOOL_POLICY\")))",
  "(deny file-write* (literal (param \"CC_SUITE_GIT_LINK\")))",
  "(deny file-write*",
  "  (require-all",
  "    (require-not (subpath (param \"CC_SUITE_WORKSPACE\")))",
  "    (require-not (subpath (param \"CC_SUITE_SCRATCH\")))))",
].join("\n");

const SCRATCH_PREFIX = "cc-suite-agy-seatbelt-";
const SEATBELT_ENV_ALLOWLIST = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);
const PROXY_URL_ENV = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]);
const REQUIRED_PROXY_URL_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

function seatbeltError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalExisting(value) {
  return fs.realpathSync.native(path.resolve(value));
}

function pathStaysWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function runGit(workspace, args) {
  return spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function gitOutput(workspace, args, code) {
  const result = runGit(workspace, args);
  if (result.status !== 0) {
    throw seatbeltError(
      code,
      (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim()
    );
  }
  return result.stdout.trim();
}

function scanWorkspaceLinks(workspace) {
  const findings = [];
  const pending = [workspace];

  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);

      if (stat.isSymbolicLink()) {
        let resolved;
        try {
          resolved = canonicalExisting(entryPath);
        } catch {
          findings.push("WORKTREE_DANGLING_SYMLINK_PRESENT");
          continue;
        }
        if (!pathStaysWithin(workspace, resolved)) {
          findings.push("WORKTREE_EXTERNAL_SYMLINK_PRESENT");
        }
        continue;
      }

      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile() && stat.nlink > 1) {
        findings.push("WORKTREE_HARDLINK_PRESENT");
      }
    }
  }

  return findings;
}

export function auditDisposableWorktree(workspacePath) {
  const findings = [];
  let workspace;

  try {
    workspace = canonicalExisting(workspacePath);
    if (!fs.statSync(workspace).isDirectory()) {
      return ["WORKTREE_DIRECTORY_REQUIRED"];
    }
  } catch {
    return ["WORKTREE_DIRECTORY_REQUIRED"];
  }

  try {
    const topLevel = canonicalExisting(
      gitOutput(workspace, ["rev-parse", "--show-toplevel"], "WORKTREE_GIT_REQUIRED")
    );
    if (topLevel !== workspace) findings.push("WORKTREE_ROOT_MISMATCH");

    const gitDir = canonicalExisting(
      gitOutput(
        workspace,
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        "WORKTREE_GIT_DIR_UNAVAILABLE"
      )
    );
    const commonDir = canonicalExisting(
      gitOutput(
        workspace,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "WORKTREE_COMMON_DIR_UNAVAILABLE"
      )
    );
    if (gitDir === commonDir) findings.push("LINKED_WORKTREE_REQUIRED");

    const gitLink = path.join(workspace, ".git");
    const gitLinkStat = fs.lstatSync(gitLink);
    if (!gitLinkStat.isFile() || gitLinkStat.isSymbolicLink()) {
      findings.push("WORKTREE_GIT_LINK_INVALID");
    }

    const symbolicHead = runGit(workspace, ["symbolic-ref", "-q", "HEAD"]);
    if (symbolicHead.status === 0) findings.push("DETACHED_WORKTREE_REQUIRED");
    else if (symbolicHead.status !== 1) findings.push("WORKTREE_HEAD_UNVERIFIABLE");

    const status = gitOutput(
      workspace,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "WORKTREE_STATUS_UNAVAILABLE"
    );
    if (status) findings.push("WORKTREE_NOT_CLEAN");
  } catch (error) {
    findings.push(error.code || "WORKTREE_GIT_REQUIRED");
  }

  try {
    findings.push(...scanWorkspaceLinks(workspace));
  } catch {
    findings.push("WORKTREE_LINK_AUDIT_FAILED");
  }

  return [...new Set(findings)];
}

export function assertDisposableWorktree(workspacePath) {
  const findings = auditDisposableWorktree(workspacePath);
  if (findings.length) {
    throw seatbeltError(
      "AGY_SEATBELT_WORKTREE_UNSAFE",
      `AGY Seatbelt worktree gate failed: ${findings.join(", ")}`
    );
  }
  return canonicalExisting(workspacePath);
}

export function listWorkspaceChanges(workspacePath) {
  const workspace = canonicalExisting(workspacePath);
  const status = gitOutput(
    workspace,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "AGY_WORKSPACE_INVENTORY_FAILED"
  );
  return status ? status.split("\n") : [];
}

export function resolveExecutableOnPath(command, env = process.env) {
  if (path.isAbsolute(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return canonicalExisting(command);
    } catch {
      return null;
    }
  }

  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return canonicalExisting(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function resolveAgyEgressProxy(env) {
  const parsed = [];
  for (const name of REQUIRED_PROXY_URL_ENV) {
    const value = env?.[name];
    if (typeof value !== "string" || !value) {
      throw seatbeltError(
        "AGY_EGRESS_PROXY_UNSAFE",
        `AGY R9 requires ${REQUIRED_PROXY_URL_ENV.join(", ")} to declare one loopback HTTP proxy`
      );
    }
    let proxy;
    try {
      proxy = new URL(value);
    } catch {
      throw seatbeltError("AGY_EGRESS_PROXY_UNSAFE", `${name} is not a valid proxy URL`);
    }
    if (
      proxy.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(proxy.hostname) ||
      !proxy.port ||
      proxy.username ||
      proxy.password ||
      proxy.pathname !== "/" ||
      proxy.search ||
      proxy.hash
    ) {
      throw seatbeltError(
        "AGY_EGRESS_PROXY_UNSAFE",
        `${name} must be a credential-free loopback HTTP proxy with an explicit port`
      );
    }
    parsed.push(proxy.toString());
  }
  if (new Set(parsed).size !== 1) {
    throw seatbeltError(
      "AGY_EGRESS_PROXY_UNSAFE",
      "All AGY proxy variables must resolve to the same loopback endpoint"
    );
  }
  const proxy = new URL(parsed[0]);
  return {
    url: proxy.toString(),
    seatbeltRemote: `localhost:${proxy.port}`,
  };
}

export function buildSeatbeltEnvironment(env, scratchDir, egressProxy = null) {
  const filtered = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (!SEATBELT_ENV_ALLOWLIST.has(name) || typeof value !== "string") continue;
    if (PROXY_URL_ENV.has(name)) continue;
    filtered[name] = value;
  }
  if (egressProxy) {
    for (const name of REQUIRED_PROXY_URL_ENV) filtered[name] = egressProxy.url;
  }
  return {
    ...filtered,
    TMPDIR: scratchDir,
    TMP: scratchDir,
    TEMP: scratchDir,
    XDG_CACHE_HOME: scratchDir,
    XDG_STATE_HOME: scratchDir,
    CC_SUITE_AGY_SEATBELT: "1",
  };
}

export function createDetachedProbeWorktree({
  sourcePath,
  revision = "HEAD",
  destinationParent = os.tmpdir(),
}) {
  if (!revision || revision.startsWith("-") || !/^[a-zA-Z0-9._/@{}^~:+-]+$/.test(revision)) {
    throw seatbeltError(
      "AGY_WORKTREE_REVISION_INVALID",
      "The worktree revision must be an explicit Git revision without whitespace or option syntax"
    );
  }

  let source;
  try {
    source = canonicalExisting(sourcePath);
  } catch {
    throw seatbeltError("AGY_WORKTREE_SOURCE_INVALID", "The worktree source does not exist");
  }
  const topLevel = canonicalExisting(
    gitOutput(source, ["rev-parse", "--show-toplevel"], "AGY_WORKTREE_SOURCE_NOT_GIT")
  );
  if (source !== topLevel) {
    throw seatbeltError(
      "AGY_WORKTREE_SOURCE_ROOT_REQUIRED",
      `Run worktree preparation from the repository root: ${topLevel}`
    );
  }

  const sourceStatus = gitOutput(
    source,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "AGY_WORKTREE_SOURCE_STATUS_UNAVAILABLE"
  );
  if (sourceStatus) {
    throw seatbeltError(
      "AGY_WORKTREE_SOURCE_DIRTY",
      "The source repository must be clean so the detached worktree has an attributable baseline"
    );
  }

  const commit = gitOutput(
    source,
    ["rev-parse", "--verify", `${revision}^{commit}`],
    "AGY_WORKTREE_REVISION_UNRESOLVED"
  );
  const parent = canonicalExisting(destinationParent);
  const container = fs.mkdtempSync(path.join(parent, "cc-suite-agy-worktree-"));
  const worktreePath = path.join(container, "worktree");
  const result = runGit(source, ["worktree", "add", "--detach", worktreePath, commit]);
  if (result.status !== 0) {
    fs.rmSync(container, { recursive: true, force: true });
    throw seatbeltError(
      "AGY_WORKTREE_CREATE_FAILED",
      (result.stderr || result.stdout || "git worktree add failed").trim()
    );
  }

  const workspace = assertDisposableWorktree(worktreePath);
  return {
    sourceRoot: source,
    worktreePath: workspace,
    revision: commit,
    cleanupRoot: canonicalExisting(container),
  };
}

export function createSeatbeltLaunch({
  workspacePath,
  executable,
  argv = [],
  env = process.env,
  scratchParent = os.tmpdir(),
  agyRuntime = null,
  onScratchPrepared = null,
}) {
  if (process.platform !== "darwin") {
    throw seatbeltError(
      "AGY_SEATBELT_PLATFORM_UNSUPPORTED",
      "The R5 AGY full-process boundary is currently implemented only for macOS Seatbelt"
    );
  }
  if (!resolveExecutableOnPath(MACOS_SANDBOX_EXEC, env)) {
    throw seatbeltError(
      "AGY_SEATBELT_UNAVAILABLE",
      `${MACOS_SANDBOX_EXEC} is unavailable`
    );
  }

  const egressProxy = agyRuntime ? resolveAgyEgressProxy(env) : null;

  const workspace = assertDisposableWorktree(workspacePath);
  const gitLink = path.join(workspace, ".git");
  const executablePath = resolveExecutableOnPath(executable, env);
  if (!executablePath) {
    throw seatbeltError(
      "AGY_NOT_FOUND",
      `${executable} not found on PATH — install Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash`
    );
  }

  const scratchRoot = canonicalExisting(scratchParent);
  const scratchDir = fs.mkdtempSync(path.join(scratchRoot, SCRATCH_PREFIX));
  fs.chmodSync(scratchDir, 0o700);
  const canonicalScratch = canonicalExisting(scratchDir);

  let isolatedRuntime = null;
  let childArgv = [...argv];
  try {
    if (onScratchPrepared) onScratchPrepared(canonicalScratch);
    if (agyRuntime) {
      isolatedRuntime = prepareIsolatedAgyRuntime({
        scratchDir: canonicalScratch,
        workspacePath: workspace,
        projectId: agyRuntime.projectId,
        projectName: agyRuntime.projectName,
        installationIdFile: agyRuntime.installationIdFile,
      });
      childArgv = [
        `--gemini_dir=${isolatedRuntime.geminiDir}`,
        `--app_data_dir=${isolatedRuntime.appDataDirName}`,
        "--log-file",
        isolatedRuntime.logFile,
        ...childArgv,
      ];
    }
  } catch (error) {
    cleanupSeatbeltScratch(canonicalScratch);
    throw error;
  }

  return {
    command: MACOS_SANDBOX_EXEC,
    args: [
      "-D",
      `CC_SUITE_WORKSPACE=${workspace}`,
      "-D",
      `CC_SUITE_SCRATCH=${canonicalScratch}`,
      "-D",
      `CC_SUITE_GIT_LINK=${gitLink}`,
      "-D",
      `CC_SUITE_AGY_HOOKS=${
        isolatedRuntime?.boundaryFiles.hooksConfigFile ?? path.join(canonicalScratch, ".no-hooks")
      }`,
      "-D",
      `CC_SUITE_AGY_TOOL_POLICY=${
        isolatedRuntime?.boundaryFiles.toolPolicyFile ?? path.join(canonicalScratch, ".no-policy")
      }`,
      "-D",
      `CC_SUITE_EGRESS_PROXY=${egressProxy?.seatbeltRemote ?? "localhost:1"}`,
      "-p",
      AGY_SEATBELT_PROFILE,
      executablePath,
      ...childArgv,
    ],
    env: buildSeatbeltEnvironment(env, canonicalScratch, egressProxy),
    scratchDir: canonicalScratch,
    workspace,
    isolatedRuntime,
  };
}

function writePrivateJson(file, value, mode = 0o600) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, source, {
    encoding: "utf8",
    mode,
  });
  fs.chmodSync(file, mode);
  return source;
}

export function prepareIsolatedAgyRuntime({
  scratchDir,
  workspacePath,
  projectId,
  projectName = null,
  installationIdFile = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "installation_id"
  ),
}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId || "")) {
    throw seatbeltError(
      "AGY_PROJECT_INVALID",
      "AGY project IDs may contain only letters, numbers, underscores, and hyphens"
    );
  }

  const workspace = canonicalExisting(workspacePath);
  const scratch = canonicalExisting(scratchDir);
  const geminiDir = path.join(scratch, "gemini");
  const appDataDirName = "antigravity-cli";
  const appDataDir = path.join(geminiDir, appDataDirName);
  const configDir = path.join(geminiDir, "config");
  const projectsDir = path.join(configDir, "projects");
  fs.mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });

  try {
    fs.copyFileSync(installationIdFile, path.join(appDataDir, "installation_id"));
    fs.chmodSync(path.join(appDataDir, "installation_id"), 0o600);
  } catch (error) {
    throw seatbeltError(
      "AGY_INSTALLATION_ID_UNAVAILABLE",
      `Cannot seed isolated AGY authentication identity: ${error.message}`
    );
  }

  const settings = {
    allowNonWorkspaceAccess: false,
    trustedWorkspaces: [workspace],
    permissions: {
      allow: [`write_file(${workspace})`],
      deny: [],
      ask: [],
    },
  };
  const sharedConfig = {
    userSettings: {
      nonWorkspaceFileAccessPolicy: "AGENT_SETTING_POLICY_DENY",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
      browserJsExecutionPolicy: "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK",
    },
  };
  const projectConfig = {
    id: projectId,
    name: projectName || `cc-suite isolated ${projectId}`,
    projectResources: {
      resources: [{ folderUri: pathToFileURL(workspace).href }],
    },
  };

  const settingsFile = path.join(appDataDir, "settings.json");
  const sharedConfigFile = path.join(configDir, "config.json");
  const projectFile = path.join(projectsDir, `${projectId}.json`);
  const mcpConfigFile = path.join(configDir, "mcp_config.json");
  const pluginsConfigFile = path.join(configDir, "plugins.json");
  const hooksConfigFile = path.join(configDir, "hooks.json");
  const toolPolicyFile = path.join(configDir, "agy-tool-policy.mjs");
  const nodeExecutable = canonicalExisting(process.execPath);
  const toolPolicySource = fs.readFileSync(AGY_TOOL_POLICY_SOURCE_FILE, "utf8");
  const hooksConfig = buildAgyToolPolicyHookConfig({
    nodeExecutable,
    policyFile: toolPolicyFile,
  });
  writePrivateJson(settingsFile, settings);
  writePrivateJson(sharedConfigFile, sharedConfig);
  writePrivateJson(projectFile, projectConfig);
  writePrivateJson(mcpConfigFile, { mcpServers: {} });
  writePrivateJson(pluginsConfigFile, { entries: [], inherits: [] });
  fs.writeFileSync(toolPolicyFile, toolPolicySource, { encoding: "utf8", mode: 0o400 });
  fs.chmodSync(toolPolicyFile, 0o400);
  const hooksConfigSource = writePrivateJson(hooksConfigFile, hooksConfig, 0o400);

  return {
    geminiDir,
    appDataDirName,
    logFile: path.join(scratch, "agy.log"),
    boundaryFiles: {
      settingsFile,
      sharedConfigFile,
      projectFile,
      mcpConfigFile,
      pluginsConfigFile,
      hooksConfigFile,
      hooksConfigSource,
      toolPolicyFile,
      toolPolicySource,
      nodeExecutable,
    },
  };
}

export function cleanupSeatbeltScratch(scratchPath) {
  if (!scratchPath) return;

  const scratchRoot = canonicalExisting(os.tmpdir());
  const absolute = path.resolve(scratchPath);
  const relative = path.relative(scratchRoot, absolute);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(absolute).startsWith(SCRATCH_PREFIX)
  ) {
    throw seatbeltError(
      "AGY_SEATBELT_SCRATCH_INVALID",
      `Refusing to remove unexpected Seatbelt scratch path: ${scratchPath}`
    );
  }

  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw seatbeltError(
      "AGY_SEATBELT_SCRATCH_INVALID",
      `Refusing to remove non-directory Seatbelt scratch path: ${scratchPath}`
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw seatbeltError(
      "AGY_SEATBELT_SCRATCH_OWNER_MISMATCH",
      `Refusing to remove Seatbelt scratch owned by uid ${stat.uid}`
    );
  }

  fs.rmSync(absolute, { recursive: true, force: true });
}

export function makeSeatbeltError(code, message) {
  return seatbeltError(code, message);
}
