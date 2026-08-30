---
description: "Shared: Antigravity CLI (agy) call pattern via the CLI runner — model selection, sandbox mapping, conversation resume, and the limits that differ from Codex"
user-invocable: false
---
<!-- Shared partial: agy call pattern. Referenced by any command delegating to Antigravity CLI. Do not use standalone. -->

## agy Call Pattern

All Antigravity CLI calls go through `scripts/agy-runner.mjs`. The runner is
deadline-bounded, records jobs, and parses AGY's `stream-json` protocol. It takes
the conversation ID only from the `init` event and the final answer/usage only
from the `result` event. It never scans conversation SQLite files.

### Hard gates

- A fresh call requires an exact, non-default `--project <id>`.
- `default-cli-project`, cwd/name guessing, `--add-dir`, and resume are blocked.
- `read-only` is blocked: AGY 1.1.11 executed `write_to_file` during a real
  `--mode plan --sandbox` probe.
- `danger-full-access` and `--dangerously-skip-permissions` are blocked.
- R2-R4 rejected user- and Project-scoped grants as filesystem boundaries. R5
  adds a macOS-only candidate: a clean detached linked worktree, a private
  ephemeral AGY runtime, and full-process Seatbelt enforcement. Live probes
  allowed a workspace write and denied a sibling write at the OS boundary.
  The normal `/agy` command never invokes it; the runner accepts it only with
  `--candidate-workspace-write`.
- R6 keeps that candidate probe-only and adds immutable `.git`, post-run
  mutation inventory, and cancellation-to-process-group cleanup.
- R7 adds atomic run manifests and restart scavenging. An attributable runner
  crash becomes `aborted` / `AGY_RUNNER_ABORTED`; surviving mutations remain in
  `workspaceChanges`. Identity or path mismatches block recovery without
  signaling a process or deleting scratch.
- R8 removes `workspace-write` from the public candidate list. A live 1.1.11
  init exposed MCP, browser, subagent, terminal, notebook-execution, messaging,
  and scheduling tools without a supported runtime allowlist. The internal
  harness rejects executable workspace customizations, seeds empty isolated
  MCP/plugin/hook configs, disables slash expansion, and fails on any init tool
  outside the direct-file allowlist.
- R9 installs an exact catch-all `PreToolUse` deny hook in the private runtime,
  makes both hook files immutable under Seatbelt, and allows outbound TCP/UDP
  only to one declared credential-free loopback HTTP proxy. This is defense in
  depth only: a crashing hook was observed to fail open and create a worktree
  file, the proxy is not a destination allowlist, and a `0.0.0.0` listener is
  still permitted.
- R10 keeps the public and candidate lists empty and defines the external-VM
  evidence contract. Merely finding an Apple `container` executable is not
  evidence. Every required capability must be `proven`, carry acceptable
  kernel/supervisor assurance, match the exact runtime/AGY/host/profile
  fingerprints and supervisor-known probe run, match the host-calculated
  artifact SHA-256 map, and remain unexpired. Unknown, disproven, stale,
  duplicated, forged, or advisory-only evidence fails closed.
- R11 installs and live-probes Apple `container` without opening a public mode.
  It separates empty publish metadata from host-routable listeners: a process
  bound inside the host-only network was reachable from the macOS bridge even
  with no published port. The capsule contract therefore requires a separate
  kernel-enforced `host_routable_listener_blocked` capability. Linux AGY OAuth
  and that listener boundary remain unproven, so promotion is still blocked.
- R12 demonstrates that an nftables policy inside the Linux VM can block the
  host-routable listener while preserving one exact supervisor-proxy endpoint.
  The entrypoint then drops to UID/GID 65532 with all capability sets empty and
  `no_new_privs=1`. Contract version 3 treats this irreversible
  `workload_privilege_drop` as a separate hard gate. The probe is not wired into
  the runner and Linux OAuth/model execution remains unproven.
- R13 stops trusting the Apple CLI exit code. A PID 1 supervisor retains only
  `CAP_KILL`, runs AGY as UID/GID 65532 with no capabilities, reaps every
  descendant, and emits one terminal completion record. The host verifier
  rejects missing, duplicate, forged, non-terminal, stale, or scope-mismatched
  records and requires a fresh non-disclosed 128-bit run nonce. Contract
  version 4 requires six lifecycle probe classes; this path
  is still an internal probe and has no Linux OAuth/model evidence.
- R14 adds an exact-client, exact-host egress sidecar, a default-drop bootstrap
  quarantine with one-time loopback handoff, and one labeled ext4 AGY-state
  volume. The credential-free live probe passed allow/deny, remount, privilege,
  and completion checks. Contract version 5 requires those probe classes; OAuth,
  token refresh, and a real model call remain unrun.
- Direct `--mode` overrides are blocked. `plan` is not a hard read-only gate;
  `accept-edits` was not reliable in print-mode probes.

Before AGY starts, the runner verifies that cwd is the exact root of a clean,
detached linked worktree and rejects external/dangling symlinks and every
regular file with multiple hardlinks. It then creates private settings,
Project, cache, state, log, and conversation paths below a random mode-0700
scratch directory. Only `installation_id` is copied from the real AGY profile;
the child does not load the real settings or Project files. It receives only a
small locale/terminal/TLS/network-proxy environment allowlist; proxy URLs with
embedded credentials, ambient API keys, tokens, agent sockets, and arbitrary
custom variables are not inherited. The generated
boundary is checked before spawn, at authoritative init, every 500 ms, and
after exit. The periodic check is detective and has an exposure window; it is
not a preventive boundary. The linked-worktree `.git` pointer is an exact deny target. Scratch
is removed on every runner-controlled exit.
Failure to remove it returns `AGY_SEATBELT_CLEANUP_FAILED`; cleanup warnings
cannot coexist with a successful job result.

After every post-spawn exit, the runner records
`git status --porcelain=v1 --untracked-files=all` as `workspaceChanges` in the
foreground response and persisted job payload. Inventory failure returns
`AGY_WORKSPACE_INVENTORY_FAILED`. SIGTERM/SIGINT is forwarded to AGY's detached
process group with a SIGKILL fallback; an acknowledged cancellation returns
`status:"cancelled"` and `errorCode:"AGY_CANCELLED"` after inventory and
scratch cleanup.

At startup, the runner scans private manifests left by interrupted calls. It
requires the same canonical worktree, baseline commit, `.git` fingerprint,
process start identity, and scratch recovery token before cleanup. A recovered
job is terminal with `status:"aborted"` and
`errorCode:"AGY_RUNNER_ABORTED"`. Treat `aborted` as evidence that changes may
survive, not as rollback.

`sandbox-exec` wraps the entire AGY process tree and denies writes outside the
exact worktree and scratch directory. It also denies Apple Events and outbound
Unix sockets. R9 additionally denies every non-proxy TCP/UDP destination and
normalizes all six proxy variables to one loopback endpoint. `--sandbox`
remains mandatory as a second layer for terminal commands. Reads, inbound TCP,
Mach IPC, and arbitrary destinations reachable through the proxy remain
available, so this is not a confidentiality or general external-side-effect boundary. A
failed semantic check returns `AGY_PERMISSION_BOUNDARY_UNSAFE`; an unsafe
worktree returns `AGY_SEATBELT_WORKTREE_UNSAFE`.

### Model contract

`agy models` emits `slug<TAB>display_name`. Pass only the slug to `--model`.
When a slug ends in `-low`, `-medium`, or `-high`, that suffix is authoritative:
a matching `--effort` is redundant and omitted; a conflicting effort fails
before spawn. For a slug without an effort suffix, an explicit supported effort
may be passed.

### R9 internal fail-closed probe (not a production command)

Create a clean detached worktree from a clean source repository first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-worktree.mjs" \
  --source "{source_repository_root}"
```

Run the candidate from the returned `worktreePath`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runner.mjs" \
  --kind agy \
  --project "{exact_project_id}" \
  --model "{model_slug}" \
  --sandbox workspace-write \
  --candidate-workspace-write \
  --timeout-ms {deadline_ms} \
  --summary "{brief description}" \
  -- "{prompt}"
```

Returns one JSON object. On AGY 1.1.11 the expected result is a blocked runtime
tool surface, with the authoritative init inventory preserved as evidence:

```json
{"jobId":"agy-…","status":"failed","threadId":"<uuid>","rawOutput":"","runtime":{"model":"…","cwd":"…","tools":["call_mcp_tool","browser_subagent","invoke_subagent","run_command"],"permissionMode":"request-review"},"workspaceChanges":[],"errorCode":"AGY_RUNTIME_TOOL_SURFACE_UNSAFE","error":"AGY exposed tools outside the R9 direct-workspace-file allowlist: …"}
```

Failures include an `errorCode`. A typed `step_update` tool error makes the job
fail even when AGY's terminal result says `SUCCESS`; cancelled, denied, and
rejected tool terminal states also fail. Do not retry boundary,
protocol, or tool-permission failures as transient errors. `status` remains
`completed` | `failed` | `stalled` | `cancelled` | `aborted` for job tracking.

### Background

Add `--background`. It returns a queued job ID; collect it with
`/cc-suite:status` and `/cc-suite:result`. The background worker applies the same
Project and boundary gates.

### Prompt boundary

The runner still injects the delegation and constitution reminders. They govern
task semantics and handoff behavior; they are not permission enforcement.

### Model discovery

`scripts/agy-preflight.sh` emits schema 12 with model slugs separated from labels
and no released sandbox mode:

```json
{"backend":"agy","preflight_schema":14,"status":"ok","default_model":"gemini-3.6-flash-high","models":["gemini-3.6-flash-high"],"models_detail":[{"slug":"gemini-3.6-flash-high","display_name":"Gemini 3.6 Flash (High)","reasoning_efforts":["high"]}],"reasoning_efforts":["low","medium","high"],"sandbox_levels":[],"candidate_sandbox_levels":[],"project_required":true,"detached_worktree_required":true,"isolated_runtime":true,"seatbelt_available":true,"egress_proxy_required":true,"oauth_state_isolated":false,"bootstrap_handoff_confined":false,"tool_mediation":"r9_deny_all_hook_advisory","hook_failure_mode":"fail_open","local_bind_confined":false,"destination_egress_confined":false,"boundary_audit":"detective_500ms","native_assurance_scope":"integrity_only","external_capsule":{"contract_version":5,"runtime":"apple-container","runtime_detected":false,"runtime_usable":false,"promotion_ready":false,"reason":"r14_apple_container_not_installed","capabilities":[{"id":"external_vm_boundary","status":"unknown","assurance":null},{"id":"workspace_mount_boundary","status":"unknown","assurance":null},{"id":"alternate_mutators_contained","status":"unknown","assurance":null},{"id":"host_credential_isolation","status":"unknown","assurance":null},{"id":"off_policy_egress_blocked","status":"unknown","assurance":null},{"id":"destination_egress_allowlist","status":"unknown","assurance":null},{"id":"inbound_unpublished","status":"unknown","assurance":null},{"id":"host_routable_listener_blocked","status":"unknown","assurance":null},{"id":"workload_privilege_drop","status":"unknown","assurance":null},{"id":"lifecycle_attribution","status":"unknown","assurance":null}]},"access_modes":[{"name":"read-only","status":"blocked","reason":"not_enforceable_in_agy_1_1_11"},{"name":"workspace-write","status":"blocked","reason":"r14_oauth_authentication_and_real_model_call_not_run"},{"name":"danger-full-access","status":"blocked","reason":"unsafe_mode_disabled"}]}
```

`access_modes` explains the blocked states. The preflight probes
binary/auth/model capability and reports whether the macOS Seatbelt prerequisite
exists. R9 records the observed fail-open mediation and incomplete network
confinement. R10 adds the unproven external-capsule state and scope-bound
promotion contract. R11 adds host-routable listener isolation as a separate
required capability. R12 adds irreversible post-firewall privilege drop as
another separate capability; the retained internal harness is evidence
collection, not a production candidate. R13 defines strict lifecycle
attribution and its adversarial probe matrix; it does not promote the harness
or fabricate the still-missing OAuth and complete capsule evidence.
