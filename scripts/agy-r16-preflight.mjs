#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import process from "node:process";

import { buildAgyLoopbackProxyConfig } from "./lib/agy-host-gateway-bridge.mjs";
import {
  AGY_R16_AGY_VERSION,
  AGY_R16_IMAGE_DIGESTS,
  auditAgyR16Images,
  auditAgyR16OAuthVolume,
} from "./lib/agy-r16-workspace.mjs";

const OAUTH_VOLUME_PATTERN = /^cc-suite-agy-oauth-[a-f0-9]{16}$/;

function run(command, args, timeout = 15_000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      HOME: os.homedir(),
      LANG: "C.UTF-8",
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function add(findings, value) {
  if (!findings.includes(value)) findings.push(value);
}

export function inspectAgyR16ReleaseEnvironment() {
  const findings = [];
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    add(findings, "AGY_R16_HOST_UNSUPPORTED");
  }

  const version = run("agy", ["--version"], 5_000);
  const agyVersion = version.status === 0 ? version.stdout.trim() : null;
  if (agyVersion !== AGY_R16_AGY_VERSION) add(findings, "AGY_R16_HOST_VERSION_MISMATCH");

  const runtime = run("container", ["system", "status"], 5_000);
  if (runtime.status !== 0 || !/^status\s+running$/m.test(runtime.stdout)) {
    add(findings, "AGY_R16_RUNTIME_UNAVAILABLE");
  }

  const inventory = run("container", ["list", "--all", "--format", "json"], 5_000);
  try {
    const parsed = JSON.parse(inventory.stdout);
    if (inventory.status !== 0 || !Array.isArray(parsed) || parsed.length !== 0) {
      add(findings, "AGY_R16_RUNTIME_NOT_EMPTY");
    }
  } catch {
    add(findings, "AGY_R16_RUNTIME_INVENTORY_INVALID");
  }

  const images = run("container", [
    "image", "inspect", ...Object.keys(AGY_R16_IMAGE_DIGESTS),
  ], 10_000);
  const imageAudit = auditAgyR16Images(images.stdout);
  if (images.status !== 0 || !imageAudit.ready) {
    for (const finding of imageAudit.findings) add(findings, finding);
  }

  const volumes = run("container", ["volume", "list", "--format", "json"], 5_000);
  const readyVolumes = [];
  try {
    const parsed = JSON.parse(volumes.stdout);
    if (volumes.status !== 0 || !Array.isArray(parsed)) throw new Error("inventory");
    for (const descriptor of parsed) {
      const name = descriptor?.configuration?.name;
      if (!OAUTH_VOLUME_PATTERN.test(name || "")) continue;
      const audit = auditAgyR16OAuthVolume(JSON.stringify([descriptor]), {
        expectedName: name,
        homeDirectory: os.homedir(),
        now: new Date(),
      });
      if (audit.ready) readyVolumes.push(name);
    }
  } catch {
    add(findings, "AGY_R16_VOLUME_INVENTORY_INVALID");
  }
  if (readyVolumes.length !== 1) add(findings, "AGY_R16_OAUTH_VOLUME_SET_INVALID");

  const scutil = run("/usr/sbin/scutil", ["--proxy"], 5_000);
  let hostProxyContractSource = null;
  try {
    if (scutil.status !== 0) throw new Error("scutil");
    const proxy = buildAgyLoopbackProxyConfig({
      environment: process.env,
      scutilProxy: scutil.stdout,
    });
    hostProxyContractSource = proxy.contractSource;
  } catch (error) {
    add(findings, error?.code || "AGY_R16_HOST_PROXY_CONTRACT_INVALID");
  }

  const promotionReady = findings.length === 0;
  return {
    contract_version: 6,
    runtime: "apple-container",
    host_supported: process.platform === "darwin" && process.arch === "arm64",
    runtime_detected: runtime.status === 0,
    runtime_usable: runtime.status === 0 && /^status\s+running$/m.test(runtime.stdout),
    promotion_ready: promotionReady,
    reason: promotionReady
      ? "r16_external_workspace_write_verified"
      : findings[0] || "r16_preflight_failed",
    agy_version: agyVersion,
    oauth_volume: readyVolumes.length === 1 ? readyVolumes[0] : null,
    host_proxy_contract_source: hostProxyContractSource,
    image_digests: AGY_R16_IMAGE_DIGESTS,
    findings,
    capabilities: [
      "external_vm_boundary",
      "workspace_mount_boundary",
      "alternate_mutators_contained",
      "host_credential_isolation",
      "off_policy_egress_blocked",
      "destination_egress_allowlist",
      "workload_privilege_drop",
      "lifecycle_attribution",
      "crash_recovery",
      "tool_filesystem_binding",
    ].map((id) => ({ id, status: promotionReady ? "verified" : "blocked" })),
  };
}

function main() {
  const result = inspectAgyR16ReleaseEnvironment();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.promotion_ready) process.exitCode = 70;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main();

