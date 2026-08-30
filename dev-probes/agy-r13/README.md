# AGY R13 lifecycle probe

Status: development probe only. This directory is not wired into the released
`agy` runner.

The PID 1 supervisor separates container-runtime completion from workload
completion. It emits exactly one terminal `CC_SUITE_AGY_COMPLETION` record only
after the direct workload and every descendant have been reaped. The host must
validate that record with `scripts/agy-lifecycle-verify.mjs`; the exit status of
Apple `container run` is not workload evidence.

`AGY_RUN_ID` is a completion nonce, not a label. Generate 16 random bytes on
the host and encode them as exactly 32 lowercase hexadecimal characters. Never
reuse it or include it in the container name, workload command, prompt, or
workload environment. The supervisor removes it before `exec`; the verifier
requires the same host-held nonce. If this value is disclosed to the workload,
the anti-forgery claim does not hold.

## Build input

Copy the already verified Linux ARM64 AGY binary to
`dev-probes/agy-r13/input/antigravity`. The directory is ignored by Git. Record
the binary SHA-256 separately; do not commit credentials or OAuth state.

Build from the repository root:

```sh
container build --progress plain \
  --tag cc-suite/agy-r13-probe:1.1.11 \
  --file dev-probes/agy-r13/Dockerfile .
```

The base image is digest-pinned and direct Debian dependencies are
version-pinned. Transitive APT resolution is not snapshot-pinned, so a rebuilt
image is not accepted by tag: bind evidence to the resulting OCI manifest
digest.

## Required container capabilities

Start the probe with all capabilities dropped, then add only `NET_ADMIN`,
`SETUID`, `SETGID`, `SETPCAP`, and `KILL`. The entrypoint uses `NET_ADMIN` to
load and verify the nftables policy. The workload receives UID/GID 65532, an
empty capability bounding set, empty effective/permitted/ambient sets, and
`no_new_privs=1`. The trusted supervisor retains only `CAP_KILL` so it can stop
and reap escaped descendants before writing the completion record.

Missing initialization capabilities, an invalid proxy target, a missing or
ambiguous completion record, a CLI transport failure, or a scope mismatch must
fail closed. No Linux OAuth material is part of this probe.
