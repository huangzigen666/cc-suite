---
name: agy-preflight
description: Check Antigravity CLI (agy) availability, authentication, models, and workspace MCP parity
allowed-tools:
  - Bash
---

# Antigravity (agy) Preflight

Check the supported Google terminal backend: Antigravity CLI (`agy`). This is
separate from `/cc-suite:codex-preflight` (Codex) and `/cc-suite:grok-preflight`
(Grok Build).

## Step 1: Run the preflight script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-preflight.sh"
```

Parse the JSON output from stdout. The probe is deadline-bounded and does not
fall back to the deprecated consumer Gemini CLI.

## Step 2: Display results

```markdown
## Antigravity CLI Preflight Results

**Backend**: {backend}
**Status**: {status}
**agy version**: {agy_version}
**Default model**: {default_model}
**Explicit Project required**: {project_required}
**Workspace MCP bridge**: {workspace_mcp_registered}
**Claude reverse bridge**: {claude_mcp_registered}
**Native assurance scope**: {native_assurance_scope}
**Boundary audit**: {boundary_audit}
**External capsule**: {external_capsule.runtime} — {external_capsule.reason}
**External capsule promotion ready**: {external_capsule.promotion_ready}

### Available Models

{models_detail: slug, display_name, and model-specific reasoning_efforts, one per row}

### Access Modes

{access_modes: name, status, and reason}
```

Treat `models` as CLI slugs and `display_name` as presentation text. Do not
concatenate them when constructing `--model`. `sandbox_levels` and
`candidate_sandbox_levels` are currently empty. R5 launches the whole
AGY process under Seatbelt from a clean detached linked worktree and uses a
private ephemeral AGY runtime. Live probes allowed an in-worktree write, denied
a sibling write, and preserved the real AGY configuration. R6 additionally
protects `.git`, inventories mutations after all post-spawn exits, and closes
the cancellation/process-cleanup gap. R7 adds atomic run manifests, restart
scavenging, and an `aborted` terminal result that preserves mutation inventory.
R8 blocks the mode after a live init exposed MCP, browser, subagent, terminal,
notebook-execution, messaging, and scheduling tools without a supported tool
allowlist. `detached_worktree_required`,
`isolated_runtime`, and `seatbelt_available` make those constraints explicit.
R9 adds `egress_proxy_required`, `hook_failure_mode`, and
`local_bind_confined`. R10 labels the retained 500 ms re-audit as detective,
not preventive, and exposes an `external_capsule` contract. Every required
capsule capability begins as `unknown`. Detecting an Apple `container` binary
changes only `runtime_detected`; it never changes `promotion_ready` or adds a
sandbox mode. R11 additionally requires
`host_routable_listener_blocked`: live Apple host-only networking allowed the
host to reach a container listener even with empty publish metadata. R12 adds
`workload_privilege_drop`: a guest firewall is not durable evidence unless AGY
runs with every capability set empty, `no_new_privs=1`, and no ability to alter
that firewall. The R12 probe passed those two controls, but is not the released
runner and has no Linux OAuth/model evidence. R13 adds supervisor-enforced
`lifecycle_attribution`: the host accepts exactly one terminal, run/profile-
bound completion record after all workload descendants are reaped. The run
binding is a fresh 128-bit nonce that must not enter the workload prompt,
command, name, or environment. Contract
version 4 requires successful exit, non-zero exit, signal exit, forged-record
rejection, descendant drain, and missing-supervisor-capability probes. These
are live observations, not a complete scope-bound capsule evidence package.
R14 contract version 5 additionally requires exact-host allow, unlisted/IP/
wrong-client denial, DNS-to-public-IPv4 pinning, direct-egress denial, bounded
proxy teardown, loopback-only nonce handoff, pre-handoff quarantine, ingress
removal, a labeled ext4 UID-65532 state volume, host-path absence, remount
persistence, and missing-mount failure. The credential-free probe passed; OAuth
authentication, token refresh, a real model request, and a complete one-run
evidence set were not performed. A
`fail_open` hook,
`local_bind_confined:false`,
`destination_egress_confined:false`, stale evidence, scope drift, or any
`unknown`/`disproven` capability is a hard stop.

## Step 3: Handle errors

- `agy_not_found` → install with:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- `agy_not_authenticated` → run `agy` interactively and complete Google sign-in
- `agy_probe_timeout` → check network/authentication, then retry
- Empty `models` → do not continue with an agy delegation; run `agy` interactively

Do not silently substitute `gemini`. Enterprise users who intentionally retain
Gemini CLI should use that tool directly; cc-suite's project bridge targets agy.
