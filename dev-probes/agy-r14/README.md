# AGY R14 credential-free capsule probe

Status: development evidence only. Nothing in this directory enables the
released `agy` runner, authenticates to Google, or contains OAuth credentials.

R14 splits the candidate into two VMs on one dedicated Apple NAT network:

- `proxy/` runs the exact-client, exact-host CONNECT broker as UID/GID 65532,
  with no capabilities, a read-only root, and tmpfs `/tmp`.
- `capsule/` requires one local ext4 named volume at `/home/agy`, starts under
  nftables quarantine, receives the exact proxy IPv4 through a host-loopback
  bootstrap port and one-time 128-bit nonce, removes bootstrap ingress, then
  runs AGY under the R13 PID 1 supervisor as UID/GID 65532 with zero
  capabilities and `no_new_privs=1`.

The ignored `capsule/input/antigravity` file must be the independently verified
Linux ARM64 AGY binary. Never place tokens, cookies, browser profiles, API keys,
or OAuth state in the repository or image build context.

The named volume is the only writable persistent mount. Its required labels,
driver, ext4 format, size, creation time, and runtime-managed source path are
audited by `scripts/agy-oauth-volume.mjs`. A missing mount, owner drift,
symlinked state directory, malformed proxy policy, failed bootstrap, or missing
terminal completion record must fail closed.

The host must generate a fresh bootstrap nonce and a separate lifecycle run
nonce for every run. The bootstrap port must publish only on `127.0.0.1`; the
proxy must not publish a host port. Treat the nonce handoff as an integrity
control against accidental or network-originated drift, not as a boundary from
other local processes running as the same macOS user.

R14 live evidence covered exact allow/deny behavior, pre-handoff quarantine,
post-handoff ingress removal, privilege drop, lifecycle attribution, named
volume metadata, persistence after remount, missing-mount failure, and exact
resource cleanup. OAuth authentication, token refresh, a real model request,
chaos teardown, and a complete one-run evidence manifest remain mandatory
before promotion.
