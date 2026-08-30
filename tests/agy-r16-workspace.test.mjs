import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { AGY_SUPERVISOR_RECORD_PREFIX } from "../scripts/lib/agy-lifecycle.mjs";
import { parseAgyR16SessionArguments } from "../scripts/agy-r16-workspace-session.mjs";
import {
  AGY_R16_CAPSULE_IMAGE,
  AGY_R16_IMAGE_DIGESTS,
  AGY_R16_IMAGE_VARIANT_DIGESTS,
  AGY_R16_PROJECT,
  auditAgyR16Images,
  auditAgyR16OAuthVolume,
  auditAgyR16WorkspaceMutationBinding,
  auditAgyR16WorkspaceTranscript,
  buildAgyR16AuthPolicy,
  buildAgyR16CaptureSpec,
  buildAgyR16ClientCreateArgs,
  buildAgyR16Profile,
  buildAgyR16ProxyRunArgs,
  buildAgyR16ResourceNames,
  isAgyR16OwnedResourceName,
  parseAgyR16ContainerIPv4,
  parseAgyR16ProxyIPv4,
} from "../scripts/lib/agy-r16-workspace.mjs";

const VOLUME = "cc-suite-agy-oauth-0123456789abcdef";
const HOME = "/Users/ccsuite-test";
const SUFFIX = "0123456789ab";
const RUN_ID = "0123456789abcdef0123456789abcdef";
const BOOTSTRAP_NONCE = "abcdef0123456789abcdef0123456789";
const WORKSPACE_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const HOST_PROXY_CONTRACT = `sha256:${"c".repeat(64)}`;
const NOW = new Date("2026-08-18T00:00:00.000Z");

function workspaceFixture(t, name = "workspace") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r16-test-"));
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(workspace, ".git"),
    `gitdir: ${path.join(root, "git-dir")}\n`,
    "utf8"
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return workspace;
}

function linkedWorkspaceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-r16-binding-"));
  const source = path.join(root, "source");
  const workspace = path.join(root, "worktree");
  fs.mkdirSync(source);
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "cc-suite test",
        GIT_AUTHOR_EMAIL: "cc-suite@example.invalid",
        GIT_COMMITTER_NAME: "cc-suite test",
        GIT_COMMITTER_EMAIL: "cc-suite@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git(source, ["init", "-q"]);
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n", "utf8");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-qm", "fixture"]);
  git(source, ["worktree", "add", "--detach", workspace, "HEAD"]);
  t.after(() => {
    spawnSync("git", ["-C", source, "worktree", "remove", "--force", workspace]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return workspace;
}

function volumeDescriptor(overrides = {}) {
  return [{
    configuration: {
      creationDate: "2026-08-11T00:00:00Z",
      driver: "local",
      format: "ext4",
      labels: {
        "cc-suite.owner": "cc-suite",
        "cc-suite.purpose": "agy-oauth-state",
        "cc-suite.schema": "1",
        "cc-suite.sensitivity": "oauth",
      },
      name: VOLUME,
      options: { size: "256M" },
      sizeInBytes: 268435456,
      source:
        `${HOME}/Library/Application Support/com.apple.container/volumes/${VOLUME}/volume.img`,
      ...overrides,
    },
    id: VOLUME,
  }];
}

function completion(profileHash, overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    profileHash,
    supervisorPid: 1,
    workloadPid: 31,
    exitKind: "exit",
    exitCode: 0,
    signal: null,
    startedAt: "2026-08-17T23:59:59.000Z",
    finishedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function stream(profileHash, overrides = {}) {
  const conversationId = "conversation-r16";
  const events = [
    {
      event: "init",
      conversation_id: conversationId,
      init: {
        cwd: "/workspace",
        model: "gemini-3.6-flash-low",
        permission_mode: "bypassPermissions",
        tools: ["finish", "write_to_file", "run_command"],
      },
    },
    {
      event: "step_update",
      step_update: {
        state: "SUCCESS",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file" },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: conversationId,
        response: "done",
        status: "SUCCESS",
        usage: { total_tokens: 17 },
      },
    },
  ];
  if (overrides.toolState) events[1].step_update.state = overrides.toolState;
  if (overrides.model) events[0].init.model = overrides.model;
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n` +
    `${AGY_SUPERVISOR_RECORD_PREFIX}${JSON.stringify(completion(profileHash))}\n`;
}

test("R16 binds the profile to image, model, prompt hash, and workspace identity", () => {
  const first = buildAgyR16Profile({
    hostProxyContract: HOST_PROXY_CONTRACT,
    model: "gemini-3.6-flash-low",
    prompt: "write the sentinel",
    workspaceFingerprint: WORKSPACE_FINGERPRINT,
  });
  const second = buildAgyR16Profile({
    hostProxyContract: HOST_PROXY_CONTRACT,
    model: "gemini-3.6-flash-low",
    prompt: "write a different sentinel",
    workspaceFingerprint: WORKSPACE_FINGERPRINT,
  });
  assert.match(first.profileHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.promptSha256, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(first.profileHash, second.profileHash);
  assert.throws(
    () => buildAgyR16Profile({
      hostProxyContract: HOST_PROXY_CONTRACT,
      model: "Gemini 3.6 Flash (Low)",
      prompt: "x",
      workspaceFingerprint: WORKSPACE_FINGERPRINT,
    }),
    (error) => error.code === "AGY_R16_PROFILE_SCOPE_INVALID"
  );
});

test("R16 session parser requires one exact prompt and all fixed-scope arguments", () => {
  assert.deepEqual(parseAgyR16SessionArguments([
    "--workspace", "/tmp/worktree",
    "--oauth-volume", VOLUME,
    "--model", "gemini-3.6-flash-low",
    "--timeout-ms", "120000",
    "--resource-suffix", SUFFIX,
    "--run-id", RUN_ID,
    "--", "write proof.txt",
  ]), {
    workspacePath: "/tmp/worktree",
    oauthVolumeName: VOLUME,
    model: "gemini-3.6-flash-low",
    timeoutMs: 120000,
    resourceSuffix: SUFFIX,
    runId: RUN_ID,
    prompt: "write proof.txt",
  });
  for (const argv of [
    [],
    ["--workspace", "/tmp/worktree", "--", "prompt"],
    [
      "--workspace", "/tmp/worktree",
      "--oauth-volume", VOLUME,
      "--model", "gemini-3.6-flash-low",
      "--timeout-ms", "0",
      "--", "prompt",
    ],
    [
      "--workspace", "/tmp/worktree",
      "--oauth-volume", VOLUME,
      "--model", "gemini-3.6-flash-low",
      "--timeout-ms", "120000",
      "--", "prompt", "extra",
    ],
  ]) {
    assert.throws(
      () => parseAgyR16SessionArguments(argv),
      (error) => error.code === "AGY_R16_ARGUMENTS_INVALID"
    );
  }
});

test("R16 binds transcript targets to the exact filesystem mutations and hashes", (t) => {
  const workspace = linkedWorkspaceFixture(t);
  fs.writeFileSync(path.join(workspace, "proof.txt"), "BOUND_RESULT\n", "utf8");
  const accepted = auditAgyR16WorkspaceMutationBinding({
    runId: RUN_ID,
    toolTargets: ["/workspace/proof.txt"],
    workspacePath: workspace,
  });
  assert.equal(accepted.ready, true);
  assert.equal(accepted.bindings.length, 1);
  assert.equal(accepted.bindings[0].bytes, 13);
  assert.equal(accepted.bindings[0].runId, RUN_ID);
  assert.match(accepted.bindings[0].contentSha256, /^sha256:[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(workspace, "extra.txt"), "unexpected\n", "utf8");
  const extra = auditAgyR16WorkspaceMutationBinding({
    runId: RUN_ID,
    toolTargets: ["/workspace/proof.txt"],
    workspacePath: workspace,
  });
  assert.equal(extra.ready, false);
  assert.ok(extra.findings.includes("AGY_R16_TOOL_FILESYSTEM_TARGET_MISMATCH"));
});

test("R16 accepts a labeled retained OAuth volume only after refresh age", () => {
  const audit = auditAgyR16OAuthVolume(JSON.stringify(volumeDescriptor()), {
    expectedName: VOLUME,
    homeDirectory: HOME,
    now: NOW,
  });
  assert.equal(audit.ready, true);
  assert.equal(audit.refreshAgeProven, true);
  assert.ok(audit.ageMs >= 7 * 24 * 60 * 60 * 1000);

  const tooFresh = auditAgyR16OAuthVolume(JSON.stringify(volumeDescriptor({
    creationDate: "2026-08-17T23:30:00Z",
  })), {
    expectedName: VOLUME,
    homeDirectory: HOME,
    now: NOW,
  });
  assert.equal(tooFresh.ready, false);
  assert.ok(tooFresh.findings.includes("AGY_R16_REFRESH_AGE_NOT_PROVEN"));
});

test("R16 accepts only the exact capsule and sidecar image manifests", () => {
  const descriptors = Object.keys(AGY_R16_IMAGE_DIGESTS).map((name) => ({
    configuration: {
      name,
      descriptor: { digest: AGY_R16_IMAGE_DIGESTS[name] },
    },
    variants: [{
      digest: AGY_R16_IMAGE_VARIANT_DIGESTS[name],
      platform: { architecture: "arm64", os: "linux" },
    }],
  }));
  assert.deepEqual(auditAgyR16Images(JSON.stringify(descriptors)), {
    ready: true,
    findings: [],
  });
  descriptors[0].configuration.descriptor.digest = `sha256:${"0".repeat(64)}`;
  const replaced = auditAgyR16Images(JSON.stringify(descriptors));
  assert.equal(replaced.ready, false);
  assert.ok(replaced.findings.includes("AGY_R16_IMAGE_DIGEST_MISMATCH"));
});

test("R16 create args mount one workspace, protect .git, and retain no host credential path", (t) => {
  const workspace = workspaceFixture(t);
  const names = buildAgyR16ResourceNames(SUFFIX);
  const prompt = "create proof.txt";
  const { profileHash } = buildAgyR16Profile({
    hostProxyContract: HOST_PROXY_CONTRACT,
    model: "gemini-3.6-flash-low",
    prompt,
    workspaceFingerprint: WORKSPACE_FINGERPRINT,
  });
  const args = buildAgyR16ClientCreateArgs({
    bootstrapHostPort: 28083,
    bootstrapNonce: BOOTSTRAP_NONCE,
    clientName: names.client,
    model: "gemini-3.6-flash-low",
    networkName: names.network,
    networkPrefix: "172.30.251",
    homeVolumeName: names.home,
    profileHash,
    prompt,
    proxyPort: 18443,
    runId: RUN_ID,
    timeoutMs: 120000,
    workspacePath: workspace,
  });
  const flattened = args.join(" ");
  const canonicalWorkspace = fs.realpathSync.native(workspace);

  assert.equal(args[0], "create");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--no-dns"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes(`type=volume,source=${names.home},target=/home/agy`));
  assert.ok(args.includes(
    `type=bind,source=${canonicalWorkspace},target=/workspace`
  ));
  assert.ok(args.includes("/workspace/.git"));
  assert.equal(args.at(-1), prompt);
  assert.ok(args.includes(AGY_R16_CAPSULE_IMAGE));
  assert.ok(args.includes(AGY_R16_PROJECT));
  assert.equal(flattened.includes(`${HOME}/.gemini`), false);
  assert.equal(flattened.includes("--add-dir"), false);
  assert.equal(flattened.includes("--ssh"), false);

  const commaWorkspace = workspaceFixture(t, "bad,workspace");
  assert.throws(
    () => buildAgyR16ClientCreateArgs({
      bootstrapHostPort: 28083,
      bootstrapNonce: BOOTSTRAP_NONCE,
      clientName: names.client,
      model: "gemini-3.6-flash-low",
      networkName: names.network,
      networkPrefix: "172.30.251",
      homeVolumeName: names.home,
      profileHash,
      prompt,
      proxyPort: 18443,
      runId: RUN_ID,
      timeoutMs: 120000,
      workspacePath: commaWorkspace,
    }),
    (error) => error.code === "AGY_R16_WORKSPACE_INVALID"
  );
});

test("R16 resource, capture, and network identity are exact", () => {
  const names = buildAgyR16ResourceNames(SUFFIX);
  assert.deepEqual(names, {
    client: `cc-suite-agy-r16-workspace-${SUFFIX}`,
    home: `cc-suite-agy-r16-home-${SUFFIX}`,
    homeHelper: `cc-suite-agy-r16-home-helper-${SUFFIX}`,
    network: "default",
    proxy: `cc-suite-agy-r16-proxy-${SUFFIX}`,
  });
  assert.deepEqual(buildAgyR16CaptureSpec(names.client), {
    command: "container",
    args: ["start", "--attach", names.client],
    options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
  });
  const descriptor = [{
    id: names.client,
    status: {
      state: "running",
      networks: [{ network: "default", ipv4Address: "172.30.251.9/24" }],
    },
  }];
  assert.equal(
    parseAgyR16ContainerIPv4(JSON.stringify(descriptor), names.client, "default"),
    "172.30.251.9"
  );
  descriptor[0].id = names.proxy;
  assert.equal(
    parseAgyR16ProxyIPv4(JSON.stringify(descriptor), names.proxy, "default"),
    "172.30.251.9"
  );
  assert.equal(isAgyR16OwnedResourceName(names.client), true);
  assert.equal(isAgyR16OwnedResourceName(names.proxy), true);
  assert.equal(isAgyR16OwnedResourceName(names.home), true);
  assert.equal(isAgyR16OwnedResourceName(names.homeHelper), true);
  assert.equal(isAgyR16OwnedResourceName("unrelated"), false);
});

test("R16 proxy policy binds the client, gateway endpoint, and exact image", () => {
  const names = buildAgyR16ResourceNames(SUFFIX);
  const upstreamProxyUrl = "http://172.30.251.1:49152";
  const audit = buildAgyR16AuthPolicy({
    clientIPv4: "172.30.251.9",
    gatewayIPv4: "172.30.251.1",
    listenPort: 18443,
    upstreamProxyUrl,
  });
  assert.equal(audit.ready, true);
  assert.equal(audit.policy.upstream.url, upstreamProxyUrl);
  assert.match(audit.policyHash, /^sha256:[a-f0-9]{64}$/);

  const args = buildAgyR16ProxyRunArgs({
    gatewayIPv4: "172.30.251.1",
    networkName: names.network,
    policy: audit.policy,
    proxyName: names.proxy,
  });
  assert.ok(args.includes("cc-suite/agy-r16-egress:probe"));
  assert.ok(args.includes("--expected-gateway-ipv4"));
  assert.ok(args.includes("172.30.251.1"));
  assert.equal(args.join(" ").includes("cc-suite-agy-r15-proxy"), false);

  assert.throws(
    () => buildAgyR16ProxyRunArgs({
      gatewayIPv4: "172.30.252.1",
      networkName: names.network,
      policy: audit.policy,
      proxyName: names.proxy,
    }),
    (error) => error.code === "AGY_R16_PROXY_POLICY_INVALID"
  );
});

test("R16 accepts attributed successful tool streams and rejects tool errors", () => {
  const profileHash = `sha256:${"a".repeat(64)}`;
  const expected = {
    cliExitCode: 0,
    expectedModel: "gemini-3.6-flash-low",
    expectedProfileHash: profileHash,
    expectedRunId: RUN_ID,
    now: NOW,
  };
  const accepted = auditAgyR16WorkspaceTranscript(stream(profileHash), expected);
  assert.equal(accepted.ready, true);
  assert.equal(accepted.conversationId, "conversation-r16");
  assert.equal(accepted.rawOutput, "done");
  assert.equal(accepted.totalTokens, 17);
  assert.deepEqual(accepted.toolCounts, { write_to_file: 1 });
  assert.match(accepted.workloadSha256, /^sha256:[a-f0-9]{64}$/);

  const denied = auditAgyR16WorkspaceTranscript(
    stream(profileHash, { toolState: "DENIED" }),
    expected
  );
  assert.equal(denied.ready, false);
  assert.ok(denied.findings.includes("AGY_TOOL_ERROR"));

  const wrongModel = auditAgyR16WorkspaceTranscript(
    stream(profileHash, { model: "gemini-3.6-flash-high" }),
    expected
  );
  assert.equal(wrongModel.ready, false);
  assert.ok(wrongModel.findings.includes("AGY_R16_WORKSPACE_MODEL_MISMATCH"));
});
