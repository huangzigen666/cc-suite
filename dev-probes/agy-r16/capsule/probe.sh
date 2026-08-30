#!/bin/sh
# R16 workspace-write probe.
#
# Runs as UID/GID 65532 under the R13/R14 supervisor after the entrypoint
# has applied the privilege drop, the OAuth state volume is verified, and
# the sidecar egress policy is loaded. It asserts the post-run invariants
# that the R16 live evidence relied on, including the workspace write-proof
# target written by the AGY tool during the run.
set -eu
set -C

fail() {
  printf 'AGY_R16_PROBE_FAILED: %s\n' "$1" >&2
  exit 70
}

[ "$(/usr/bin/id -u)" -eq 65532 ] || fail 'workload uid is not 65532'
[ "$(/usr/bin/id -g)" -eq 65532 ] || fail 'workload gid is not 65532'
[ "${HOME:-}" = "/home/agy" ] || fail 'HOME is not the isolated state volume'
/sbin/getpcaps $$ | /bin/grep -Eq '^.*: =$ ' || fail 'workload capabilities are not empty'
/bin/grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status || \
  fail 'no_new_privs is not set'
[ "$(/usr/bin/findmnt -rn -o FSTYPE -T /home/agy)" = "ext4" ] || \
  fail 'OAuth state mount is not ext4'
case ",$(/usr/bin/findmnt -rn -o OPTIONS -T /home/agy)," in
  *",rw,"*) ;;
  *) fail 'OAuth state mount is not writable' ;;
esac
[ ! -r /root/.config ] || fail 'host-like root config is readable'
[ ! -e /Users ] || fail 'host user tree is mounted'
[ ! -e /workspace/.git ] || fail 'host workspace .git is mounted (read-only deny)'

# Workspace write-proof: the live AGY tool wrote exactly one file inside
# /workspace and it is bound to the content hash recorded in
# dev-probes/agy-r16/observation-summary.json toolWriteBinding.contentSha256.
proof=/workspace/agy-ab-write-proof.txt
expected='sha256:b6ac256e981482596dcd6139d6bfd94c224c15c0a6ee7ef6a05c34c65622bfe8'
[ -f "$proof" ] || fail 'workspace write-proof target is missing'
[ -L "$proof" ] && fail 'workspace write-proof target is a symlink'
case "$(/usr/bin/stat -c '%u:%g:%a' "$proof")" in
  65532:65532:*) ;;
  *) fail 'workspace write-proof target owner/mode is unexpected' ;;
esac
actual="sha256:$(/usr/bin/sha256sum "$proof" | /usr/bin/cut -d' ' -f1)"
[ "$actual" = "$expected" ] || fail 'workspace write-proof content hash mismatch'

# Proxy-only egress: allowed destination succeeds; direct and unlisted fail.
allowed_status=$(/usr/bin/curl \
  --connect-timeout 8 --max-time 20 --fail --silent --show-error \
  --output /dev/null --write-out '%{http_code}' https://example.com/) || \
  fail 'allowed proxy request failed'
[ "$allowed_status" = "200" ] || fail 'allowed proxy response was not 200'

if /usr/bin/curl \
  --connect-timeout 3 --max-time 5 --silent --output /dev/null \
  --noproxy '*' https://example.com/; then
  fail 'direct egress unexpectedly succeeded'
fi
if /usr/bin/curl \
  --connect-timeout 3 --max-time 5 --silent --output /dev/null \
  https://www.example.com/; then
  fail 'unlisted proxy destination unexpectedly succeeded'
fi

/usr/local/bin/agy --version
printf 'AGY_R16_PROBE_OK\n'
