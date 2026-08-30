# AGY workspace-write promotion gate

Status: **R16 RELEASED, HOST-SCOPED / THREE OPEN CONDITIONS** on Antigravity (build source committed; see item 5 note)
CLI 1.1.14 with Apple `container` 1.2.2.

`workspace-write` appears in released `sandbox_levels` only on the exact
host where `agy-r16-preflight.mjs` reports `promotion_ready:true` and the
local serving-evidence canary is current for AGY 1.1.14; every other host
keeps both `sandbox_levels` and `candidate_sandbox_levels` empty. The
user-facing `/agy` command always goes through this gated path
(`scripts/agy-public-runner.mjs`) and never accepts `--candidate-workspace-write`
or `--candidate-external-workspace-write`; those switches remain only for
internal fail-closed evidence gathering.

## R16 decision record

R16 replaces AGY's own permission engine as the workspace-write boundary
with the Apple Container VM proven in R11-R14 and the OAuth persistence
proven in R15. It is released host-scoped, not fully promoted:
`dev-probes/agy-r16/observation-summary.json` explicitly records
`status:"released-host-scoped"` and `promotionEligible:false`.

1. R15 item 10 is retracted as it applies to R16, and only as it applies to
   R16. It stated that `default-cli-project` "remains rejected by the
   released runner and cannot satisfy the project/workspace promotion
   contract." That statement was written about the Seatbelt candidate path
   (`executeAgySeatbelt` / `assertExecutionBoundary` in `agy-runner.mjs`),
   where AGY's own project-scoped permission grants are the tested
   boundary and a silent fallback to `default-cli-project` means the
   isolation did not take effect — the exact defect R4 documented. R16
   does not use that code path or that boundary. The R16 candidate invokes
   AGY with `--dangerously-skip-permissions`, so AGY's own grant engine is
   not the enforcement layer at all; the write boundary is the Apple
   Container VM's bind mount limited to the workspace, a read-only-path
   deny on `/workspace/.git`, a read-only container root, `--tmpfs /tmp`,
   and the R13/R14 PID 1 privilege-drop supervisor. `default-cli-project`
   is AGY's own label for "no dedicated project configured," which is
   correct and expected inside a fresh, disposable capsule that has never
   had a project created in it. It carries no filesystem permission in
   R16 and is pinned only as an audited literal folded into the run
   profile hash. Item 10 remains true, unchanged, and in force for the
   Seatbelt candidate path it was written about; only its application to
   the external-capsule path is withdrawn.
2. The R16 client reuses the R15-proven OAuth volume (one labeled,
   size- and age-audited named volume mounted at `/home/agy`) and the
   R15-proven exact-host allowlist proxy on the same audited builtin
   `default` NAT network, so authentication and destination egress are
   not re-derived from scratch. Both client and proxy run with the R13/R14
   privilege-drop and lifecycle-attribution supervisor; the client's root
   is read-only with no DNS and only the workspace bind mount is writable.
3. A completed run's filesystem effect is bound, not merely observed:
   `git status --porcelain` on the host worktree after the run is compared
   against the tool targets the transcript reports, renames/deletes are
   rejected, and every claimed target is re-resolved on the host to
   confirm it is a real file inside the workspace with link count 1 before
   its content hash is recorded. A live run wrote exactly one file inside
   `/workspace`, matched by this binding, and produced diagnostic
   `AGY_AB_114_OK`.
4. Preflight schema 14 only reports `sandbox_levels:["workspace-write"]`
   when four independent signals hold on the exact release host: `agy
   --version` is `1.1.14`, `container` resolves to the audited binary
   path, `agy-r16-preflight.mjs` returns `promotion_ready:true` (empty
   runtime, pinned image index/ARM64 digests, exactly one ready OAuth
   volume, a valid host proxy contract), and a separate, out-of-band
   `~/.config/cc-suite/agy-r16-serving-evidence.json` reports
   `serving_path_verified:true` for `1.1.14`. Any other host, or any
   missing signal, keeps `sandbox_levels` empty with an explicit blocked
   reason. The serving-evidence file is a host-local canary, not run-bound
   evidence; it does not expire and must be revalidated by a human before
   it is trusted.
5. The R16 capsule image and its ARM64 manifest are pinned by digest and
   audited against the running `container` daemon before every release
   run. Unlike R13 and R14, no Dockerfile, entrypoint script, or
   supervisor/entrypoint source SHA-256 for this image is committed to
   this repository; the pinned digest can be host-verified against what
   is currently loaded but not traced to reviewable source here. This is
   recorded as a known limitation, not a disproven control: the same
   external PID 1 supervisor and privilege-drop design already reviewed
   in R13/R14 is reused, and no code change to that supervisor is claimed
   for R16.

   Build-source follow-up: the R16 capsule build source is now committed under
   `dev-probes/agy-r16/capsule/` (Dockerfile, entrypoint.sh, probe.sh, README.md,
   input/.gitignore) with per-file SHA-256 recorded in `observation-summary.json`
   `buildSource`. The R13 `agy-supervisor.c` and R14 `bootstrap-receiver.c` /
   `entrypoint.sh` are referenced unchanged. This closes the fourth open condition
   originally recorded here.
6. Egress during the live run was `consumer-mobile-nat`; the resolved
   address was not retained in any repository artifact.
7. Open conditions carried forward from `observation-summary.json`, none
   of which is closed by this record:
   - the serving canary is neither run-bound nor expiring;
   - no independent security review has been counted since before R11;
   - region/account independence is untested;
   - the R16 capsule's build source — CLOSED: committed and hashed under
     `dev-probes/agy-r16/capsule/` (build-source follow-up above); the same
     R13/R14 supervisor is reused unchanged.

Promotion remains a host-scoped, conditional release, not a general
availability claim. `sandbox_levels` reverts to empty the moment any of
the four preflight signals stops holding, and the four open conditions
above must be closed, or explicitly re-accepted with a stated reason,
before this record can claim more than `released-host-scoped`.

## R15 decision record

R15 completed Google authorization and verified the resulting state in two
fresh capsules without inspecting token contents. It has not refreshed an
expired token and remains ineligible for promotion.

1. Static inspection and one manually initiated, uncompleted OAuth flow found
   the requested scopes `cloud-platform`, `userinfo.email`,
   `userinfo.profile`, `cclog`, `experimentsandconfigs`, `aicode`, and
   `openid`. `cloud-platform` is broad Google Cloud access, not an AGY-only
   narrow permission. The ephemeral PKCE URL and state were not retained. No
   authorization code was retained. A later user-only flow submitted a fresh
   code and completed token exchange; the verifier handled only the resulting
   labeled volume and never read token-file contents.
2. `scripts/agy-r15-auth-session.mjs` refuses non-TTY use, unknown arguments,
   or omission of the exact ordered scope and host-bridge acknowledgement
   flags. Before
   creating resources it re-audits the accepted R14 capsule and proxy OCI index
   and ARM64 manifest digests.
3. Each accepted session creates one randomly named, labeled 256 MiB ext4 OAuth
   volume and uses the exact audited builtin `default` NAT network. The AGY client has a
   read-only root, no DNS, no host path, no agent socket, one loopback-only
   bootstrap publication, and the R14 privilege-drop/lifecycle supervisor.
4. The sidecar policy is bound after launch to the client's exact private IPv4.
   Its canonical allowlist is limited to `antigravity-unleash.goog`,
   `businessaicode.googleapis.com`, `cloudcode-pa.googleapis.com`,
   `daily-cloudcode-pa.googleapis.com`, `lh3.googleusercontent.com`,
   `oauth2.googleapis.com`, and `www.googleapis.com`. The exact Google profile
   image host is required by AGY 1.1.11's print-mode eligibility check.
   Accepted residual risk: `lh3.googleusercontent.com` is a multi-tenant CDN,
   and a CONNECT proxy can constrain the exact host but cannot constrain the
   encrypted request path. This exception must be revalidated on AGY upgrades.
   Wildcards, direct client egress, host-published proxy
   ports, private/reserved resolutions, and all other destinations remain
   denied.
5. The attached AGY process uses the user's terminal directly with inherited
   stdio. The launcher does not capture or print the OAuth URL, authorization
   code, browser state, or token. The Linux remote-flow hint prevents the
   capsule from launching a host browser. Google consent and code entry remain
   user-only actions.
6. Earlier credential-free and failed token-exchange runs were retained as
   negative evidence. The successful flow left one labeled OAuth volume for
   verification; every client, proxy, and diagnostic container was removed.
7. Unit tests cover the observed scope set, exact-host policy, named-volume-only
   mount, loopback handoff, direct-TTY stdio, per-session resource names,
   network/client identity, pinned images, and fail-closed consent. Session
   closure is deliberately emitted as `authenticationVerified:false`.
8. `scripts/agy-r15-verify-session.mjs` now implements the post-consent gate
   without reading token-file contents. It first audits one exact, recently
   created, labeled local ext4 volume and the pinned R14 image identities. It
   then creates two independent client/proxy/network sets: the first runs
   `agy models`; only an attributed exit-0 model list without authentication
   diagnostics can continue to the second phase.
9. The second fresh capsule pins `gemini-3.6-flash-low` and sends one fixed,
   non-sensitive prompt in `stream-json` mode with terminal sandboxing and
   slash expansion disabled.
   It does not use `--mode plan`, because R4 proved that mode is not a read-only
   boundary. Only a `finish` tool step and the exact `AGY_R15_MODEL_OK` marker
   are acceptable. The verifier emits counts, booleans, and SHA-256 values;
   raw model output, conversation IDs, OAuth diagnostics, and sidecar logs are
   never written to an artifact or returned in its public event.
10. `default-cli-project` is permitted only in this host-workspace-free
    credential probe. It remains rejected by the released runner and cannot
    satisfy the project/workspace promotion contract. Each phase requires an
    exact private client IP, at least one successful sidecar tunnel, one bound
    PID 1 completion record, and exact resource cleanup.
11. On 2026-08-12 a fresh models capsule authenticated from the retained volume,
    reported eight models, and confirmed the pinned model. A second fresh
    capsule returned `AGY_R15_MODEL_OK` with a successful result and usage
    record through the exact sidecar. The verifier reported
    `authenticationPersistedAcrossFreshCapsule:true` and
    `realModelCallProven:true`; token refresh remains untested.
12. The final local regression passed 207 unit tests and 424 integration
    assertions. `git diff --check` passed. A context-aware executable security
    scan found no unresolved Critical or High issue and no secret-pattern
    match. The reviewed expected surfaces are shell-free `container` subprocess
    calls, PATH-only host environment inheritance, exact-host sidecar traffic,
    and bounded in-memory output capture. The machine-readable partial record
    is `dev-probes/agy-r15/observation-summary.json`.

### R15 host-proxy remediation record

The first user-completed consent flow reached the authorization-code exchange,
then AGY reported a POST failure for Google's token endpoint. No code, URL,
token, or OAuth-volume contents were retained. The exact sidecar log contained
`AGY_PROXY_CONNECT_TIMEOUT`; a credential-free TCP probe from the sidecar VM to
the resolved Google IPv4 also timed out. macOS was configured to use one local
HTTP(S) proxy at `127.0.0.1`, which an Apple container VM cannot treat as the
host loopback.

The remediation remains `PROBE_ONLY` and adds no released sandbox mode:

1. R14 policy source and image identity remain frozen. R15 has a separate
   policy adapter, executable entrypoint, Dockerfile, image tag, and pinned OCI
   index/ARM64 manifest digests.
2. Each auth or verification phase audits and reuses Apple's builtin `default`
   NAT network; no custom network is created. The AGY client and sidecar have
   distinct, exact private IPv4 addresses. Before bootstrap the client has a
   default-drop nftables quarantine and no DNS; after handoff it can open new
   connections only to the exact sidecar IPv4 and port.
3. The user must explicitly install Apple's documented localhost mapping for
   `cc-suite-agy-host.internal -> 203.0.113.113`. The launcher never executes
   `sudo`, never changes system proxy settings, and refuses a missing mapping.
4. Because the mapping is system-wide, the launcher requires an otherwise empty
   Apple Container runtime. A host bridge listens on a random `127.0.0.1` port,
   locks once to the sidecar's exact default-network IPv4, and forwards bytes only to the single
   loopback HTTP(S) proxy reported by `scutil`; payloads are never logged.
5. Before releasing AGY from its bootstrap quarantine, the sidecar VM performs
   one fixed, credential-free CONNECT probe through the bridge using an
   asynchronous, output-bounded host subprocess. The first implementation used
   synchronous `container exec`, which blocked the bridge event loop. The next
   host-only/dual-network attempt passed in isolation but failed in the full
   two-VM topology: DNS was cancelled and the mapped IP returned
   `EHOSTUNREACH`. Both assumptions were falsified live. The corrected full
   topology on the exact builtin `default` network resolved one public IPv4,
   opened the exact host bridge tunnel, returned exit 0, retained no raw
   output, and cleaned all temporary resources. A missing PF
   route, rewritten source address, unavailable local proxy, or non-200 upstream
   response fails before the OAuth interface appears.
6. The Apple mapping disables Private Relay while present and is removed on
   restart. Privileged deletion remains a user-only action and must be verified
   after the OAuth/verification sequence.

The official mechanism and side effects are documented in Apple's
[`container` host-service guide](https://github.com/apple/container/blob/main/docs/how-to.md#access-a-host-service-from-a-container).

The next evidence action is a later verifier run after access-token expiry;
an immediate second request is not refresh evidence. The temporary Apple
localhost mapping may now be removed to restore Private Relay and reinstalled
only for that later run. Until token refresh and the remaining R14 promotion
conditions pass, neither sandbox list may change.

## R14 decision record

R14 closes the credential-free state and destination-egress foundation in a
live Apple Container probe. It does not authenticate, refresh a token, call a
model, wire the capsule into the released runner, or create promotion evidence.

1. A dedicated NAT network replaced the rejected host-proxy assumption.
   Binding a host listener to the container gateway failed because that address
   is not a host interface. Apple's documented host-service path would require
   system DNS/PF changes, so R14 made no host DNS, packet-filter, or Private
   Relay change.
2. The sidecar accepts CONNECT only from one exact private client IPv4 and to
   one canonical hostname on port 443. It resolves once, rejects mixed,
   private, reserved, or IPv6 answers, pins one public IPv4, caps concurrency
   and tunnel lifetime, runs as UID/GID 65532 with no capabilities, a read-only
   root, and tmpfs `/tmp`, and logs only bounded event/reason records. Live
   probes allowed `example.com`, denied `www.example.com`, an IP literal, a
   wrong client, and direct client egress. Controlled stop emitted
   `agy_proxy_stopped`.
3. The AGY VM begins under nftables default-drop input/output quarantine.
   Only a host-loopback-published bootstrap port is temporarily accepted. A
   host-held 128-bit nonce transfers the sidecar's exact private IPv4; the
   entrypoint then replaces quarantine with one output rule for that IP and
   port and removes the bootstrap ingress rule before the workload starts.
   Wrong payloads fail closed. A local process that can recover the container
   configuration could deny service during this short initialization window;
   the nonce is not a local-user confidentiality boundary.
4. OAuth-compatible state used one 256 MiB labeled Apple named volume. Apple
   exposed it as local ext4. The capsule required the mount at `/home/agy`,
   rejected missing mounts and unexpected owners/symlinks, initialized state as
   UID/GID 65532 with mode 0700, wrote only a known non-secret marker, and
   verified mode 0600 persistence after deleting the first VM and remounting
   the same volume. `/Users` and the host workspace `.git` were absent;
   host-like root configuration was unreadable. No credential or OAuth
   material entered the volume.
5. The final workload observed UID/GID 65532, empty capabilities,
   `no_new_privs=1`, a read-only root, and the ext4 state mount. It returned AGY
   `1.1.11`, printed `AGY_R14_PROBE_OK`, and produced one attributed completion
   record with exit 0 for run `<run-id-withheld>` and profile
   `sha256:4fcc785574f9dc0c4ac6a200eaa7e699740b215aa8579add8a3a3de728475cb2`.
   The lifecycle verifier returned `attributed:true` with no findings.
6. Two live defects were caught rather than normalized: final-UID-owned 0700
   state cannot be traversed by a capability-minimized root initializer, so
   directory work now executes as UID 65532; and `set --` had overwritten the
   workload command while parsing handoff fields, so parsing now preserves
   positional arguments. Both received regression assertions.
7. The final capsule OCI index digest is
   `sha256:97f32d395735445e4157793d8258d5e84787e9dd4d60c637da05ff0ad36bb815`;
   its ARM64 manifest is
   `sha256:ed0e9126c7ebef384a98cb9cde55ee7957b27fd20ce5350bffd7960537da5d71`.
   The sidecar index is
   `sha256:d82c9d3a6758bfe105b85e57c1eec8c7e29c39444cfd2b877c77623d4b716ca4`;
   its ARM64 manifest is
   `sha256:8b03382fa6fba7e98861ae227e51a2c21b7de117b340367e1e16ac6b6f52f604`.
   Tags are not evidence; any accepted run must bind these identities or fresh
   host-calculated digests.
8. Contract version 5 requires the exact R14 proxy, bootstrap, state-volume,
   and lifecycle probe classes. Preflight schema 13 keeps both sandbox lists
   empty and reports
   `r14_oauth_authentication_and_real_model_call_not_run`. The public state
   remains `destination_egress_confined:false`, `oauth_state_isolated:false`,
   and `bootstrap_handoff_confined:false` because this probe is not the runner.
9. All exact R14 containers, the named volume, and the custom network were
   removed after verification. BuildKit was stopped and its disposable cache
   deleted. Earlier in the run, a disk-full failure was traced to build cache;
   11.71 GB of rebuildable cache and the newly pulled Node base-image reference
   were removed without pruning unrelated images.

Promotion remains blocked until interactive Linux OAuth and token refresh work
inside the isolated named volume, a real AGY model request completes through an
audited production allowlist, the complete capability set is emitted in one
scope-bound run, failure/timeout/kill teardown is exercised, the image and
proxy supply chain receive independent security review, and the released
runner consumes the capsule evidence.

## R13 decision record

R13 closes the R12 crash-attribution defect in a reproducible probe. It does
not wire the probe into the public runner and does not create a promotion
decision.

1. Apple `container run` still returned 0 for a workload that exited 7 and for
   a workload terminated by `SIGKILL`. The new PID 1 supervisor recorded the
   actual outcomes as exit 7 and signal 9; the host verifier mapped the latter
   to 137. The container CLI status is now treated only as transport state.
2. The compiled supervisor forks a separate workload session, changes the
   child to UID/GID 65532, clears supplementary groups and every capability
   set including the bounding set, enables `no_new_privs`, disables dumpability
   and core dumps, and then execs AGY. The trusted parent disables dumpability,
   enables `no_new_privs`, and retains only `CAP_KILL` so it can terminate and
   reap escaped descendants. The child observed all-zero capabilities and
   could not `SIGKILL` PID 1.
3. The supervisor becomes a child subreaper and emits one
   `CC_SUITE_AGY_COMPLETION` JSON record only after the direct child and all
   descendants are gone. A descendant that created a new session, ignored
   `SIGTERM`, and wrote late output was still reaped before the terminal
   record. Omitting `CAP_KILL` caused exit 70 with no record.
4. The host verifier requires exactly one terminal record with an exact schema,
   PID 1 supervisor, valid exit/signal tuple, canonical timestamps, a 250 ms
   maximum host/guest clock skew, an exact non-disclosed host-generated 128-bit
   lowercase-hex run nonce, and the profile hash. The workload environment did
   not contain the nonce and the workload could not read PID 1's environment.
   Missing, duplicated, malformed, stale, future, non-terminal, or
   mismatched records fail closed. A workload-emitted fake record produced two
   markers and was rejected; a weak predictable nonce was rejected before the
   workload ran. The nonce must never appear in the container name, workload
   command, prompt, or child environment. A workload can cause failure but
   cannot forge success without guessing the 128-bit value or breaking the
   documented process-isolation boundary.
5. The R13 OCI image index digest is
   `sha256:9fe0550595a2ae2c8a27c11a189f67227f0d1cfc7d75e8b3d57252b15de2dd0b`;
   its ARM64 manifest digest is
   `sha256:412414f047e2e186ea655436d93f7e70e73dbf7abf25b5bf2ec405a4522faf1a`.
   The supervisor source SHA-256 is
   `77470a40176d2bd31056e436691cb5bed4e021025855999c6954505e403cd93a`;
   the entrypoint SHA-256 is
   `d3920a2c047515e587bef586dbe6aba080daf08821aab6ab57e9554207147cf0`.
   The image retains the R12 Debian base digest and verified AGY binary. Direct
   APT dependencies are pinned, but transitive resolution is not tied to a
   Debian snapshot; promotion must bind the built image digest rather than the
   mutable tag or assume reproducible rebuilds.
   The six lifecycle cases were rerun against canonical probe profile SHA-256
   `dd25760644697bfe782e09b0f713ab95ae06f36c99a23af08fbbd8ec17d7fa81`.
   The partial manifest SHA-256 is
   `d939b1e4ae1955f01c3b3ed5b499f679a1cd59791f5580ef22836f4d5b405eea`;
   it explicitly records `promotionEligible:false` and
   `oneBoundCapsuleRun:false`. This is lifecycle evidence, not a complete
   capsule evidence package.
6. The real Linux AGY binary returned `1.1.11` after firewall setup and
   supervisor privilege separation. No OAuth flow was started, no credential
   was copied into the VM, and no authenticated model request was made.
7. Capsule contract version 4 keeps the ten capabilities and strengthens
   `lifecycle_attribution`: evidence must cover successful exit, non-zero exit,
   signal exit, forged-record rejection, descendant drain, and missing
   supervisor capability. Preflight schema 12 exposes the blocked reason
   `r13_linux_capsule_auth_and_evidence_incomplete`; both sandbox lists remain
   empty.
8. Claude Code 2.1.226 was asked for a read-only security review of the
   then-current supervisor, verifier, contract, tests, and decision record. It
   returned no text before the 75-second hard timeout. The subsequent nonce
   hardening also has no independent review. No verdict is counted.

The supervisor, entrypoint, build recipe, host validator, and unit tests are
now cc-suite artifacts. Promotion remains blocked until all ten capabilities
are generated in one scope-bound run with host-calculated artifact digests;
Linux OAuth and token refresh work without host credential mounts; a real
authenticated model call completes; the proxy and image supply chain are
independently reviewed; and the released runner consumes the validated
completion record rather than the Apple CLI status.

## R12 decision record

R12 falsifies the R11 assumption that host-side PF is required to close the
host-routable listener. It does not wire the probe into the public runner and
does not create promotion evidence.

1. Apple `container` 1.2.2 was restarted with the installed Linux 6.18.15
   kernel. The official network interface exposes no host-deny mode:
   `--internal` creates a host-only network, while distinct networks isolate
   containers from one another. The current session also lacked non-interactive
   administrator access for macOS PF, so no host firewall was modified.
2. A Linux/glibc probe image used the digest-pinned Debian Bookworm Slim index
   `sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241`
   and the previously verified AGY binary SHA-256
   `e9202092a2a1150a5b74c20a0bd1ec4ef006f93461f61cdc8c7302e4213e1168`.
   The final probe image digest was
   `sha256:8163f2770fefa80e5d9d8784bea9c2fd23043893898c6a12a2e7fd6a25924543`.
   `agy --version` returned `1.1.11` after the firewall and privilege transition.
3. The entrypoint starts with only `NET_ADMIN`, `SETUID`, `SETGID`, and
   `SETPCAP`. It atomically installs an nftables `inet` table with default-drop
   input and output, allows loopback and established traffic, and permits new
   output only to one exact supervisor proxy IPv4 address and TCP port. It then
   switches to UID/GID 65532, clears supplementary groups and every capability
   set including the bounding set, enables `no_new_privs`, and executes the
   workload. The workload observed zero `CapInh`, `CapPrm`, `CapEff`, `CapBnd`,
   and `CapAmb`, and could no longer list the nftables ruleset.
4. The untreated baseline listener on `192.168.129.3:19090` was reachable from
   macOS. The same wildcard listener behind the R12 guest firewall was not
   reachable over IPv4. The host could not reach the IPv6 baseline either, so
   IPv6 is recorded as non-routable in this topology rather than credited to
   R12. Empty published-port and published-socket arrays remain necessary but
   insufficient evidence.
5. The output matrix passed after privilege drop: the exact host proxy port was
   reachable; `https://example.com` succeeded through the allowlist proxy;
   `www.google.com`, an IP-literal CONNECT, direct `1.1.1.1:443`, and the host's
   unrelated loopback-upstream port all failed. DNS remained disabled inside
   the VM. The supervisor proxy was still the R11 ad hoc prototype, so this is
   observed destination-policy behavior, not a shipped control.
6. The Debian probe retained the R11 mount boundary: one explicit workspace
   mount was writable; the read-only root, a host-absolute symlink escape, and
   host credential paths were blocked or absent; the outside sentinel hash was
   unchanged. Omitting `NET_ADMIN` or supplying an invalid proxy address made
   the entrypoint exit 70 before the workload ran, and the fail-closed marker
   remained absent.
7. A forced `SIGKILL` of the post-drop workload removed its `--rm` container,
   but Apple `container run` returned exit code 0. Resource cleanup succeeded;
   crash attribution by CLI status did not. A production supervisor must bind
   container state and an in-guest completion record rather than treating a
   zero CLI exit as proof of normal completion.
8. Claude Code 2.1.226 produced no review text for more than three minutes. The
   request was interrupted and returned `aborted_streaming`; no verdict is
   counted. The R12 design therefore has no independent architecture approval.
9. Contract version 3 adds `workload_privilege_drop` independently of
   `host_routable_listener_blocked`. A firewall probe cannot pass promotion if
   AGY retains a capability that can remove it. Preflight schema 11 exposes ten
   required capabilities and the blocked reason
   `r12_linux_capsule_auth_and_evidence_incomplete`.

### R12 live capability gate

| Capability | R12 observation | Promotion state |
|---|---|---|
| External VM boundary | Apple container VM ran Linux 6.18.15 | observed, not bound evidence |
| Workspace mount boundary | exact mount writable; rootfs and symlink escape blocked | observed, not bound evidence |
| Alternate mutators contained | shell probe stayed within mount and network policy | observed, not bound evidence |
| Host credential isolation | host paths absent | partial; isolated Linux OAuth volume unproven |
| Off-policy egress blocked | direct public IP and unrelated host port failed | observed, not bound evidence |
| Destination egress allowlist | allowed hostname passed; denied hostname and IP literal failed | partial; supervisor remains a prototype |
| Inbound unpublished | publish and socket arrays were empty | observed but insufficient alone |
| Host-routable listener blocked | untreated IPv4 listener reachable; R12 listener blocked | observed, not bound evidence |
| Workload privilege drop | UID/GID 65532, all capability sets zero, `no_new_privs=1` | observed, not bound evidence |
| Lifecycle attribution and teardown | bounded resources can be named and removed | incomplete; no scope-bound crash evidence |

At R12 close, promotion remained blocked until these controls became
reproducible artifacts, every probe was generated in one bound run, Linux OAuth
and token refresh succeeded without a host credential mount, a real
authenticated model call completed, and the production toolchain and image
supply chain were reviewed. `sandbox_levels` and `candidate_sandbox_levels`
stayed empty.

## R11 decision record

R11 installs the authorized VM runtime and performs bounded live probes. It
does not reopen the public lane and does not convert observations into capsule
evidence without the contract's run binding and artifact digests.

1. The official signed Apple installer for `container` 1.2.2 was downloaded
   from the Apple GitHub release. Its SHA-256 matched the release API
   (`f4c7e73f7203725a3512676dfd9ec6c6a98a37093b6fd4a1b0fdcfcb227e2118`),
   the package was notarized, and its Developer ID Installer team was
   `UPBK2H6LZM`. The installed CLI and API server report the same 1.2.2 release
   commit. The system is running with kernel 6.18.15 and the runtime-recorded
   kernel digest.
2. The Linux ARM64 AGY 1.1.11 archive matched the vendor manifest SHA-512. Its
   binary was placed in a digest-pinned Distroless Debian 12 nonroot probe
   image. The image exposes no shell, mounts no host path, runs as UID/GID
   65532, and receives no SSH agent. `agy --version` succeeds. A clean
   `agy models` returns `Please sign in`, which proves Linux compatibility but
   not Linux authentication.
3. A host-only container with a read-only root, no DNS, `capDrop=ALL`, an
   ephemeral `/tmp`, and one explicit read/write workspace mount could write
   only that mount. Rootfs writes, a host-absolute symlink escape, and host
   credential paths were blocked or absent. This contains alternate mutators
   even when no AGY hook is present.
4. Direct external traffic from the host-only network failed. An exact-host
   CONNECT proxy bound only to the macOS host-only bridge allowed an approved
   HTTPS destination, denied an unapproved hostname and IP literal, and left
   direct DNS unavailable. Chaining that supervisor proxy to the existing
   credential-free loopback upstream allowed a real authenticated macOS
   `agy models` call while optional Playwright and avatar hosts remained
   denied. This is destination-policy evidence for the proxy design, not proof
   of the independent Linux OAuth flow.
5. The container-side proxy design is rejected. Apple 1.2.2 cannot attach a
   network after container creation, and a container created with both NAT and
   host-only networks could not use the NAT DNS/route. Source-address binding
   did not repair the route selection. The viable prototype is a supervisor
   proxy bound to the host-only bridge, which exists only while the client VM
   is alive.
6. Empty publish metadata is not an inbound boundary. The probe container had
   `publishedPorts:[]` and `publishedSockets:[]`, yet a process listening on
   `0.0.0.0:19090` was reachable from macOS at the VM's host-only address.
   Contract version 2 therefore keeps `inbound_unpublished` and adds the
   separate kernel-enforced `host_routable_listener_blocked` capability.
   Preflight schema 10 exposes nine required capabilities. The new listener
   capability is currently disproven in the live design.
7. A real generation probe requested a fresh Google OAuth authorization. It
   was interrupted without accepting or recording an authorization code.
   Linux authentication, token storage in an isolated writable volume, token
   refresh through the allowlist, and post-auth model execution remain
   unproven. No macOS Keychain path may be mounted into the VM.
8. Teardown was exact: all R11 probe containers, custom networks, the
   host-only bridge, and the supervisor listener disappeared. The authorized
   Apple runtime remains installed and running; its built-in `buildkit`
   container is not attributed to an AGY probe. Exact obsolete image names
   were removed, reclaiming 17.59 GB, while the verified AGY probe image and
   small baselines remain for the next authorized run.
9. Claude Code 2.1.226 was reachable, but the independent architecture review
   returned a session-limit error before producing a verdict. It is not counted
   as review evidence.

### R11 live capability gate

| Capability | R11 observation | Promotion state |
|---|---|---|
| External VM boundary | Apple container VM ran Linux 6.18.15 | observed, not bound evidence |
| Workspace mount boundary | rootfs and symlink escape blocked; exact mount writable | observed, not bound evidence |
| Alternate mutators contained after hook failure | shell without an AGY hook could not write outside the mount | observed, not bound evidence |
| Host credential isolation | host paths and SSH agent absent | partial; Linux OAuth volume unproven |
| Off-policy egress blocked | host-only direct DNS/TCP failed | observed, not bound evidence |
| Destination egress allowlist | supervisor CONNECT allow/deny matrix passed | partial; Linux auth/model path unproven |
| Inbound unpublished | publish and socket arrays were empty | observed but insufficient |
| Host-routable listener blocked | macOS reached the VM listener | **disproven / hard blocker** |
| Lifecycle attribution and teardown | named resources removed; built-in buildkit distinguished | observed, not bound evidence |

The next valid run requires user-completed OAuth inside an isolated Linux auth
volume, a supervisor proxy profile covering only observed auth/model hosts, and
a kernel or network-plugin control that makes a container listener unreachable
from the host bridge. If Apple 1.2.2 cannot provide the last control without
privileged guest routing changes, R11 remains permanently blocked on this
runtime. Only after all nine probes pass in one scope-bound run may the evidence
validator be invoked. Released and candidate sandbox lists remain empty.

## R10 decision record

R10 does not install a VM runtime or reopen the public lane. It turns the next
promotion step into a fail-closed, scope-bound evidence contract:

1. The apparent native escape hatch was rejected. The `FailOpenOnError` string
   in the AGY binary belongs to `policyguardian` tool/dependency vetting, not
   lifecycle hooks. The bundled hook schema exposes no fail-closed setting, so
   R9's observed hook-crash write remains authoritative.
2. The current Apple-silicon macOS 26 host satisfies Apple `container`'s host
   prerequisite, but no Apple container, Docker, Podman, Colima, Lima, or other
   container/VM runtime is installed. `pfctl` is not available to the
   unprivileged runner. Installing a signed package with administrator rights
   is a separate user-authorized system change and was not performed.
3. Preflight schema 9 reports `external_capsule` separately from native
   controls. Runtime discovery only resolves and fingerprints the executable;
   it does not execute an untrusted PATH entry. `runtime_usable` and
   `promotion_ready` remain false, no evidence is populated, and no sandbox
   mode is added. A fake `container` fixture proves both that distinction and
   that discovery never launches the binary.
4. The reusable contract requires eight capabilities: external VM boundary,
   workspace mount boundary, alternate-mutator containment, host-credential
   isolation, off-policy egress denial, destination egress allowlisting,
   unpublished inbound networking, and lifecycle attribution. Each capability
   must be `proven`, use its accepted kernel/supervisor assurance tier, and
   carry a `pass` probe artifact bound to the supervisor-known run ID. Each
   artifact SHA-256 must match the digest map calculated by the host supervisor;
   arbitrary evidence labels are rejected.
5. Evidence is valid only for one exact runtime fingerprint, AGY fingerprint,
   host fingerprint, capsule profile hash, and probe run ID. Timestamps use one
   canonical UTC form and evidence expires within 24 hours.
   Missing, malformed, unexpected, duplicated, unknown, disproven,
   advisory/detective-only, future-dated, expired, or drifted evidence fails
   `assertAgyCapsuleEvidence` with `AGY_CAPSULE_EVIDENCE_INVALID`.
6. The existing 500 ms runtime/config re-audit is now labeled
   `detective_500ms`, with an exposure window, rather than described as
   preventive enforcement. The native assurance scope is explicitly
   `integrity_only`; destination egress and local bind remain unconfined.
7. Claude Code 2.1.226 independently recommended defining and testing the
   fail-closed contract before requesting runtime installation. Its suggestion
   that a launcher could make a crashed per-tool hook fail closed was rejected:
   the launcher cannot synchronously mediate AGY's internal tool calls. The VM
   gate instead requires kernel containment of every alternate mutator.

### R10 capability gate

| Capability | Minimum accepted assurance | Current state |
|---|---|---|
| External VM boundary | Kernel | `unknown` — runtime absent |
| Workspace mount boundary | Kernel | `unknown` — no VM probe |
| Alternate mutators contained after hook failure | Kernel | `unknown` — no VM probe |
| Host credential isolation | Kernel | `unknown` — Linux auth/keyring unproven |
| Off-policy egress blocked | Kernel | `unknown` — no VM route probe |
| Destination egress allowlist | Kernel or supervisor | `unknown` — no allowlisting proxy probe |
| Inbound unpublished | Kernel | `unknown` — no VM publish/bind probe |
| Lifecycle attribution and teardown | Supervisor | `unknown` — no VM recovery probe |

Promotion now requires: install authorization; runtime fingerprinting; a
Linux AGY authentication flow that never mounts or exports the host Keychain;
a read-only root with one explicit read/write worktree mount; an internal
network with no direct Internet route; a destination-allowlisting proxy;
unpublished inbound ports; hook-crash, outside-write, off-policy TCP/UDP/DNS,
listener, credential, and teardown probes; then exact-scope evidence validation.
Until all gates pass in one current run, `sandbox_levels` and
`candidate_sandbox_levels` stay empty.

## R9 decision record

R9 implements the viable defense-in-depth parts of the supervising capsule and
then tests their failure semantics:

1. The isolated runtime now contains one exact catch-all `PreToolUse` command
   hook. Its standalone policy returns `deny` for every known or future tool
   name and malformed input. Both files are mode 0400, compared byte-for-byte
   and semantically before spawn, at init, every 500 ms, and after exit, and are
   exact Seatbelt `file-write*` deny targets.
2. A real AGY call attempted `run_command`; the hook returned
   `CC_SUITE_R9_POLICY_DENY:run_command` and no sentinel appeared. Separate real
   calls denied `invoke_subagent` and `search_web`. Browser and MCP wrapper names
   remained in the init inventory, but those two calls were not exposed in the
   model's effective declaration set with empty isolated MCP/browser state, so
   that coverage is partial rather than a pass.
3. R9 requires `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase
   forms to identify the same credential-free loopback HTTP endpoint with an
   explicit port. The child receives only the normalized values and no
   `NO_PROXY`. Seatbelt permits that endpoint and denies every other outbound
   TCP/UDP destination. A real authenticated AGY call still reached init under
   this profile; off-proxy TCP, UDP, and DNS probes failed.
4. The release blocker is deterministic: when the policy process was forced to
   exit 23, AGY continued the call and `write_to_file` created a real file in
   the detached worktree. AGY's hook manager is fail-open. File immutability
   prevents AGY from editing a healthy policy, but cannot convert process crash,
   timeout, resource exhaustion, or launch failure into a deny decision.
5. Inbound confinement also remains unavailable. The R9 profile allowed a Node
   listener on `0.0.0.0`; the earlier blanket inbound deny prevented AGY from
   reaching init. The loopback proxy is an endpoint constraint, not an
   authenticated external-destination allowlist.
6. The authoritative init inventory check therefore remains active and still
   terminates on alternate mutators. A real patched runner failed as
   `AGY_RUNTIME_TOOL_SURFACE_UNSAFE`, preserved an empty `workspaceChanges`,
   left the real settings/config hashes unchanged, and removed scratch.
7. Preflight schema 8 keeps `sandbox_levels` and
   `candidate_sandbox_levels` empty with reason
   `r9_hook_fail_open_network_confinement_incomplete`. It explicitly reports
   `hook_failure_mode:"fail_open"` and `local_bind_confined:false`.

### R9 threat matrix

| Surface | R9 control | Result |
|---|---|---|
| Healthy tool dispatch | Immutable catch-all deny hook | Denied in real terminal, subagent, and web probes |
| Hook crash/timeout/launch failure | No AGY fail-closed primitive | **Open; real worktree write observed** |
| Hook/config tamper by AGY | Mode 0400 + exact Seatbelt write deny + periodic audit | Closed in deterministic tamper probes |
| Outbound TCP/UDP | One declared loopback proxy endpoint | Direct off-proxy paths closed |
| Proxy destinations | No authenticated destination policy | Open through the proxy |
| Inbound TCP bind | No effective loopback-only filter | **Open; `0.0.0.0` bind observed** |
| MCP/browser declarations | Empty configs + deny hook + init inventory abort | Partial; not removed from init inventory |
| Public execution | Empty released and candidate sandbox lists | Closed / NO-GO |

The next valid promotion path requires an AGY release whose tool mediation
fails closed, or an external kernel/container boundary that removes alternate
mutators and constrains inbound plus destination-level egress independently of
AGY. Another command hook cannot repair the observed failure mode.

## R8 decision record

R8 closes the configuration surfaces that can be closed precisely and proves a
fundamental runtime blocker:

1. A live isolated AGY 1.1.11 init exposed 56 tools. The inventory included
   `call_mcp_tool`, the complete browser family, `browser_subagent`,
   `define_subagent`, `invoke_subagent`, `manage_subagents`, `run_command`,
   notebook execution, resource/network readers, messaging, scheduling, and
   knowledge mutation. The prompt explicitly said not to use tools; prompt
   compliance therefore cannot establish tool isolation.
2. The CLI has no supported tool allowlist or disable-browser/MCP/subagent
   option. `--agent` selects an installed agent but no installed agent profile
   was available, and the official customization surface documents rules,
   skills, plugins, hooks, and MCP rather than an agent tool manifest.
3. The runner now adds `--disable-slash-commands`, rejects workspace
   `mcp_config.json`, `hooks.json`, `plugins.json`, and plugin-bundled MCP/hooks
   under all four AGY customization-root aliases, and writes explicitly empty
   MCP/plugin/hook files into the isolated global config. Those files are
   semantically re-audited before spawn, at init, every 500 ms, and after exit.
4. The authoritative init inventory is checked against a narrow direct-file
   allowlist. Any MCP, browser, subagent, terminal, notebook, network,
   messaging, scheduling, or unknown future tool returns
   `AGY_RUNTIME_TOOL_SURFACE_UNSAFE` and terminates the process group. A real
   patched runner reached authenticated init under the tightened Seatbelt
   profile and failed with that exact code; no workspace change survived.
5. Seatbelt now denies `appleevent-send` and outbound Unix sockets. A control
   AppleScript could query System Events outside Seatbelt and failed inside it.
   A Unix-domain socket connection failed under the profile. Separate real AGY
   calls with each deny still reached init and completed a model response, so
   neither rule breaks the observed authentication/model path.
6. Local TCP cannot be claimed closed. A blanket inbound deny made AGY exit
   before init, proving that the CLI needs a listener. A filtered localhost
   rule allowed AGY to run but also allowed a `0.0.0.0` Node listener, so it was
   rejected and removed. Outbound localhost TCP is also required by this
   machine's credential-free model proxy. Broad Mach denial was not attempted
   because the existing Keychain-authenticated path depends on macOS services.
7. Preflight schema 7 therefore reports `workspace-write` as `blocked` with
   reason `r8_runtime_tool_isolation_unavailable` and exposes no candidate
   sandbox mode. This is a stricter result than R7 `PROBE_ONLY`; it is not a
   promotion or a claim that the retained internal harness is safe for work.

### R8 threat matrix

| Surface | R8 control | Result |
|---|---|---|
| Workspace MCP/hooks/plugin executors | Pre-spawn recursive rejection | Closed for the internal harness |
| Isolated global MCP/plugins/hooks | Explicit empty configs + periodic semantic audit | Closed for the internal harness |
| Slash/skill expansion | `--disable-slash-commands` | Closed for print-mode expansion |
| Browser, MCP, subagent, terminal, notebook, messaging tools | Authoritative init allowlist + process-group termination | Detected and blocked; not removed from AGY |
| Apple Events | Seatbelt `deny appleevent-send` | Closed in deterministic probe |
| Unix-domain sockets | Seatbelt outbound Unix-socket deny | Closed in deterministic probe |
| Local TCP listener | Full deny breaks AGY; filtered deny was ineffective | Open; R9 blocker |
| Local TCP proxy and remote model egress | Required for the authenticated model call | Open; R9 blocker |
| Mach services and Keychain path | No precise service allowlist | Open; R9 blocker |
| File reads outside the worktree | Not constrained by the integrity profile | Open; no confidentiality claim |
| Init-to-parent-termination interval | Parent reacts after receiving init | Race remains; R9 blocker |

The next viable design is R9: an external supervising capsule with a declared
egress proxy, explicit local-service policy, and pre-execution tool mediation,
or a future AGY release that supplies a verifiable tool allowlist. More prompt
text, a mutable hook, or another polling loop cannot close this gap.

## R7 decision record

R7 closes the bounded restart-recovery gap without promoting the candidate:

1. Each run atomically persists a mode-0600 manifest below the workspace state
   directory. It records the runner PID/start identity, AGY PID/process group/
   start identity, scratch directory, canonical worktree, baseline commit,
   linked-worktree `.git` hash, job ID, and a per-run recovery token mirrored
   into private scratch.
2. Every valid runner start scans stale manifests before launching AGY. It
   skips a manifest whose original runner identity is still live. For a dead
   runner, it validates the worktree, baseline, `.git` pointer, scratch marker,
   and AGY process identity before sending SIGTERM and a bounded SIGKILL
   fallback. Any identity or path mismatch returns a blocked recovery and
   leaves both the process and directory untouched.
3. Successful recovery inventories the current Git status, removes only the
   verified Seatbelt scratch directory, and persists the interrupted job as
   `aborted` / `AGY_RUNNER_ABORTED`. Existing terminal jobs keep their status
   while a missing result payload is repaired with `workspaceChanges`.
4. Real runner subprocess tests inject SIGKILL after scratch-manifest commit,
   AGY process recording, first streamed event, and child close. Restart
   recovery removed every recorded scratch directory, left no live recorded
   process group, retained workspace mutations, and produced a readable
   terminal job.
5. Recovery is deliberately fail-closed. It does not scan and delete arbitrary
   temp directories, trust PID numbers without process start identity, or
   recover across a changed HEAD/`.git` pointer. Tests prove a tampered scratch
   path and a reused/mismatched process identity cannot trigger deletion or a
   signal.

This does not close alternate mutators, network/IPC side effects,
confidentiality, macOS-only Seatbelt dependence, or independent review. There
are also syscall-sized gaps before a newly created scratch path or spawned
process is durably recorded; removing those requires a supervising execution
capsule rather than more in-process cleanup code. The R7 preflight reason is
therefore `r7_restart_recovery_passed_independent_review_blocked`, not a
promotion marker.

## R6 decision record

R6 closed three concrete lifecycle gaps without widening the release claim:

1. The linked-worktree `.git` pointer is now an exact Seatbelt deny target.
   AGY may write ordinary workspace files, but it cannot overwrite or unlink
   the pointer needed for post-run attribution.
2. Every runner-controlled post-spawn exit inventories
   `git status --porcelain=v1 --untracked-files=all`. The result and persisted
   job payload expose `workspaceChanges`; an inventory failure changes the job
   to `AGY_WORKSPACE_INVENTORY_FAILED`. Failed, stalled, and cancelled jobs no
   longer imply that the workspace stayed unchanged.
3. SIGTERM/SIGINT received by the foreground runner or detached background
   worker is forwarded to AGY's independent process group, followed by a
   SIGKILL grace timer. The runner returns `cancelled` / `AGY_CANCELLED`, waits
   for process close, inventories surviving changes, and removes scratch before
   publishing the terminal result.
4. macOS tests proved the `.git` deny, timeout-after-mutation inventory, normal
   descendant cleanup, and cancellation of AGY plus its descendant. The full
   local suite passed 110 unit tests and 409 integration assertions.
5. A fresh real AGY 1.1.11 probe wrote an intended workspace file and returned
   it as `workspaceChanges`. A terminal escape attempt failed as
   `AGY_TOOL_ERROR`; the outside target remained absent. The global settings
   hashes stayed unchanged and runner-created scratch was removed. The direct
   `.git` mutation was exercised against the real macOS Seatbelt profile with a
   deterministic shell child because the model refused to attempt repository
   metadata corruption.
6. Neither independent review counts as complete. Three bounded Claude Code
   review calls through the pinned cc-suite MCP server produced no response and
   were terminated, including a two-file/four-turn reduction. A one-turn
   `OCTOPUS_OK` diagnostic and a direct Claude Code `CLAUDE_OK` diagnostic both
   succeeded, so login, Pro quota, and the basic MCP path were healthy; only the
   review completion remains unverified. A fresh ChatGPT Pro browser tab timed
   out during navigation, so no prompt or verdict was verified there either.

The candidate remains `PROBE_ONLY`. Seatbelt is macOS-only and deprecated, the
profile does not protect read confidentiality, and `(allow default)` cannot
support a broad system-integrity claim when network/IPC can ask an external
service to mutate state. MCP and other alternate mutator coverage also remains
incomplete. The historical R6 preflight reason was
`r6_local_chaos_passed_independent_review_blocked`, not a promotion marker.

## R5 decision record

R5 replaced AGY's permission grants as the primary filesystem boundary:

1. The candidate now runs only from the exact root of a clean, detached linked
   worktree. It rejects ordinary checkouts, dirty state, external or dangling
   symlinks, and regular files with multiple hardlinks.
2. The runner launches the complete AGY process tree through macOS
   `/usr/bin/sandbox-exec`. The Seatbelt profile denies `file-write*` outside
   the canonical worktree and one random mode-0700 scratch directory.
3. The scratch directory contains a private `--gemini_dir`, relative
   `--app_data_dir`, settings, Project, cache/state, log, and conversation
   database. Only `installation_id` is copied from the real profile so AGY can
   use the existing Keychain credential. The child does not load the real
   settings or Project files and receives only a small locale/terminal/TLS/
   network-proxy environment allowlist. Proxy URLs with embedded credentials,
   ambient API keys, arbitrary custom variables, and agent sockets are dropped.
   A runner-controlled cleanup failure changes the job to
   `AGY_SEATBELT_CLEANUP_FAILED` instead of being logged as a successful run.
4. Direct, descendant-process, symlink-traversal, `osascript do shell script`,
   and new cross-boundary hardlink writes were denied in local Seatbelt probes.
   An in-worktree write succeeded. A pre-existing hardlink could still mutate
   the external inode, which is why the clean-worktree link audit is mandatory.
5. A live isolated AGY call authenticated, kept all runtime state in scratch,
   allowed an intended in-worktree write, and denied a sibling write. The real
   CLI and shared-settings hashes were unchanged.
6. A live call through `agy-runner.mjs` completed the allowed write and returned
   `AGY_TOOL_ERROR` for the denied sibling write even though AGY's terminal
   result said `SUCCESS`. The denied target remained absent and runner scratch
   was removed.

This is enough to retain a mechanically enforced macOS candidate, not enough to
release it. Seatbelt is platform-specific and deprecated. The current profile
is an integrity boundary: it permits reads, network, and other non-write
operations. Independent Claude Code and ChatGPT Pro review could not be
completed in R5, and the live chaos matrix still lacks timeout after mutation,
boundary-file self-tamper, MCP/alternate mutator, cancellation, and restart
coverage. `sandbox_levels` therefore remains empty.

## R4 decision record

R4 tested the new Project and hook surfaces directly instead of inferring their
security properties from the documentation:

1. AGY logged `ApplyProjectPermissionGrants: stored 1 allow` for an exact
   Project-scoped `write_file(<workspace>)` grant. The intended in-workspace
   write succeeded.
2. The same Project then wrote a sibling target outside its sole Project
   resource. Project-scoped grant storage therefore did not provide the tested
   filesystem boundary.
3. A generic `deny_unless_prior_grant` `PreToolUse` hook also allowed the sibling
   write. A path-aware hook that canonicalized `TargetFile` did block the tested
   direct escape and left the target absent.
4. That hook result is defense-in-depth, not a promotion boundary. The complete
   mutating-tool set, terminal and MCP paths, hardlinks, hook self-tampering,
   path-swap races, and next-run persistence remain unproven.
5. An allowed write completed before AGY later timed out waiting for the final
   response. The runner reports this as failure, but failure does not imply the
   workspace was unchanged and the runner does not roll back user edits.
6. A private `HOME` triggered a new OAuth flow. Reusing only the installation
   identity did not recover keyring authentication. Keeping the real `HOME`
   while setting `XDG_CONFIG_HOME` authenticated, but AGY silently selected
   `default-cli-project` instead of the requested isolated Project. AGY 1.1.11
   exposes no supported config-directory flag.
7. The pre-existing AGY process tree remained alive and the real CLI/shared
   settings hashes remained unchanged throughout the probes.

The selected decision is `PROBE_ONLY`: keep `sandbox_levels` empty, retain the
explicit candidate harness for bounded evidence gathering, and reject Project
auto-approval grants in the runner audit. Project-grant-only promotion, a hook
as the sole production boundary, and credential-dependent private-HOME
isolation are rejected. A fresh disposable worktree plus an independently
verified external enforcement boundary remains the next viable direction.

Claude Code independently returned `PROBE_ONLY` after reviewing this contract
and the runner. The ChatGPT Pro browser review could not be verified because
the page-control read/submit path timed out repeatedly; it is not counted as an
independent verdict.

## Why R2 does not authorize promotion

R2 proved two effects under a temporary narrow profile: an exact file was
created inside the Project workspace, and an attempted write outside that
workspace was denied. It also proved complete restoration of the two user-level
configuration files and the pre-existing AGY process tree.

That evidence does not establish a production-safe grant:

1. `write_file(<workspace>)` is stored in the user-level AGY settings and is
   inherited by other AGY sessions. It is not bound to the selected Project,
   runner PID, conversation, or job.
2. The positive probe produced the intended file effect, but the runtime logs
   did not emit an attributable `approved=true` permission decision for the
   exact rule. The effect must not be described as proof of which rule granted
   it.
3. R2 suspended the pre-existing AGY process tree. It did not prove safe
   coexistence with ordinary concurrent AGY sessions.
4. AGY sparsely persisted the semantically safe default
   `allowNonWorkspaceAccess:false`. Raw hash stability is therefore not a valid
   runtime boundary test; semantic re-audit is required.

Periodic semantic re-audit is defense in depth. It cannot make a process-wide
grant session-scoped and cannot eliminate the interval between a concurrent
change and its detection.

## Minimum promotion contract

Promotion requires all of the following evidence:

1. A write grant is scoped to one runner execution and every mutating tool is
   covered, or writes are constrained by an independently tested external OS
   boundary. No persistent user-level `write_file(<workspace>)` grant may be
   the production precondition.
2. Project ID, Project resource root, runtime cwd, and canonical existing
   workspace path are identical.
3. Every allowed file target exists and resolves inside the workspace before
   spawn; glob, home-expansion, missing-target, ancestor, and symlink escapes
   fail closed.
4. CLI and shared settings pass the semantic audit before spawn, at the
   authoritative init event, during execution, and after process exit.
5. A positive in-workspace write emits attributable permission-engine evidence
   naming the exact scoped grant; file creation alone is insufficient.
6. An outside-workspace write is attempted, denied by the permission engine,
   absent from all bounded escape locations, and reported as a failed tool even
   if the terminal result says `SUCCESS`.
7. Concurrent sessions cannot inherit the job's grant. A polling detector or
   advisory lock alone does not satisfy this requirement.
8. Timeout, cancellation, protocol failure, boundary drift, and normal exit all
   terminate descendants and restore runner-created temporary configuration
   byte-for-byte with original modes. Any workspace mutation that can survive a
   failed run must be inventoried and reported; do not imply automatic rollback.

R6 supplies the independently tested direct-filesystem integrity boundary and
runner lifecycle coverage required to keep evaluation open. Promotion still
requires a completed independent security review, alternate-mutator evidence,
a deliberate decision on the deprecated macOS-only dependency, and an explicit
statement that the lane does not protect read confidentiality or general
network/IPC side effects. Prompt rules, path hooks, polling, or runner flags
remain defense in depth rather than substitutes for that boundary.
