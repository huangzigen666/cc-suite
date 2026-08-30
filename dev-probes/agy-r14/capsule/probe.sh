#!/bin/sh
set -eu
set -C

fail() {
  printf 'AGY_R14_PROBE_FAILED: %s\n' "$1" >&2
  exit 70
}

[ "$(/usr/bin/id -u)" -eq 65532 ] || fail 'workload uid is not 65532'
[ "$(/usr/bin/id -g)" -eq 65532 ] || fail 'workload gid is not 65532'
[ "${HOME:-}" = "/home/agy" ] || fail 'HOME is not the isolated state volume'
/sbin/getpcaps $$ | /bin/grep -Eq '^.*: =$' || fail 'workload capabilities are not empty'
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
[ ! -e /workspace/.git ] || fail 'host workspace is mounted'

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

marker=/home/agy/.cc-suite-r14-persistence-probe
[ ! -e "$marker" ] && [ ! -L "$marker" ] || fail 'persistence marker already exists'
umask 077
printf 'cc-suite-r14-persistence-v1\n' > "$marker" || fail 'cannot write marker'
/bin/chmod 0600 "$marker" || fail 'cannot protect marker'
[ "$(/usr/bin/stat -c '%u:%g:%a' "$marker")" = "65532:65532:600" ] || \
  fail 'marker metadata is invalid'

/usr/local/bin/agy --version
printf 'AGY_R14_PROBE_OK\n'
