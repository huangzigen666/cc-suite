# AGY R16 workspace-write capsule probe

Status: development evidence only. Nothing in this directory enables the
released `agy` runner, authenticates to Google, or contains OAuth credentials.

R16 is the host-scoped release of the workspace-write boundary. It reuses the
R13 PID 1 privilege-drop supervisor and the R14 OAuth-volume + sidecar-egress
design unchanged, and adds one new assertion: a workspace write-binding. The
Apple Container VM bind-mounts exactly `/workspace` (writable), keeps the
container root read-only, denies `/workspace/.git`, runs `--tmpfs /tmp`, and
drops to UID/GID 65532 with an empty capability set and `no_new_privs=1` under
the same lifecycle-attribution supervisor already reviewed in R13/R14.

## Reused, unchanged sources

- `dev-probes/agy-r13/agy-supervisor.c` — PID 1 supervisor; reaped via
  `CC_SUITE_AGY_COMPLETION` record. Copied verbatim into the image.
- `dev-probes/agy-r14/capsule/bootstrap-receiver.c` — one-time-nonce proxy IP
  handoff receiver. Copied verbatim into the image.
- `dev-probes/agy-r14/capsule/entrypoint.sh` — privilege-drop + quarantine +
  handoff + final egress policy. Reused verbatim as
  `dev-probes/agy-r16/capsule/entrypoint.sh` (no change claimed for R16).

## R16-specific additions

- `capsule/Dockerfile` — pins `AGY_VERSION=1.1.14` and assembles the above.
- `capsule/probe.sh` — post-run verification harness. Asserts the privilege
  drop, the OAuth state volume, the workspace `.git` read-only deny, and that
  the workspace write-proof target `/workspace/agy-ab-write-proof.txt` exists
  with the content hash recorded in `observation-summary.json`
  `toolWriteBinding.contentSha256`. A live R16 run wrote exactly that one file
  and produced diagnostic `AGY_AB_114_OK`.

## Build input

Copy the independently verified Linux ARM64 AGY 1.1.14 binary to
`dev-probes/agy-r16/capsule/input/antigravity`. The directory is ignored by
Git. Record the binary SHA-256 separately; do not commit credentials or OAuth
state.

Build from the repository root:

```sh
container build --progress plain \
  --tag cc-suite/agy-r16-probe:1.1.14 \
  --file dev-probes/agy-r16/capsule/Dockerfile .
```

The base image is digest-pinned and direct Debian dependencies are
version-pinned. Transitive APT resolution is not snapshot-pinned, so a rebuilt
image is not accepted by tag: bind evidence to the resulting OCI manifest
digest. The pinned `images` digests in `observation-summary.json`
(`capsuleIndex`, `capsuleArm64`) were produced host-side and are audited
against the running `container` daemon before every release run; this source
lets a reviewer trace those digests to reviewable build input.

## Capabilities

Start the capsule with all capabilities dropped, then add only `NET_ADMIN`,
`SETUID`, `SETGID`, `SETPCAP`, and `KILL`. The entrypoint uses `NET_ADMIN` to
load and verify the nftables policy. The workload receives UID/GID 65532, an
empty capability bounding set, empty effective/permitted/ambient sets, and
`no_new_privs=1`. The trusted supervisor retains only `CAP_KILL` so it can stop
and reap escaped descendants before writing the completion record.
