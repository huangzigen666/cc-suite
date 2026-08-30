#!/bin/sh
# Reused verbatim from agy-r14/capsule/entrypoint.sh (R13/R14 PID 1
# privilege-drop + bootstrap-handoff design). No change claimed for R16.
set -eu

fail() {
  printf 'AGY_R16_INIT_FAILED: %s\n' "$1" >&2
  exit 70
}

valid_ipv4() (
  set -f
  IFS=.
  set -- $1
  [ "$#" -eq 4 ] || exit 1
  for octet in "$@"; do
    [ -n "$octet" ] || exit 1
    [ "$octet" -ge 0 ] 2>/dev/null || exit 1
    [ "$octet" -le 255 ] || exit 1
  done
)

mount_fstype() {
  /usr/bin/findmnt -rn -o FSTYPE -T "$1"
}

mount_options() {
  /usr/bin/findmnt -rn -o OPTIONS -T "$1"
}

require_mount() {
  path="$1"
  expected_access="$2"
  /usr/bin/mountpoint -q "$path" || fail "$path is not a mountpoint"
  [ "$(mount_fstype "$path")" = "ext4" ] || fail "$path is not ext4"
  case ",$(mount_options "$path")," in
    *",${expected_access},"*) ;;
    *) fail "$path mount access is not ${expected_access}" ;;
  esac
}

[ "$#" -ge 1 ] || fail 'workload command is required'

proxy_port="${AGY_PROXY_PORT:-}"
network_prefix="${AGY_NETWORK_PREFIX:-}"
bootstrap_port="${AGY_BOOTSTRAP_PORT:-}"
bootstrap_nonce="${AGY_BOOTSTRAP_NONCE:-}"
case "$proxy_port" in
  ''|*[!0-9]*) fail 'AGY_PROXY_PORT must be numeric' ;;
esac
[ "$proxy_port" -ge 1024 ] && [ "$proxy_port" -le 65535 ] || \
  fail 'AGY_PROXY_PORT must be in range 1024..65535'
valid_ipv4 "${network_prefix}.1" || fail 'AGY_NETWORK_PREFIX must contain three IPv4 octets'
case "$bootstrap_port" in
  ''|*[!0-9]*) fail 'AGY_BOOTSTRAP_PORT must be numeric' ;;
esac
[ "$bootstrap_port" -ge 1024 ] && [ "$bootstrap_port" -le 65535 ] || \
  fail 'AGY_BOOTSTRAP_PORT must be in range 1024..65535'
[ "${#bootstrap_nonce}" -eq 32 ] || fail 'AGY_BOOTSTRAP_NONCE length is invalid'
case "$bootstrap_nonce" in
  *[!a-f0-9]*) fail 'AGY_BOOTSTRAP_NONCE format is invalid' ;;
esac

require_mount /home/agy rw

as_workload() {
  /usr/bin/setpriv --reuid=65532 --regid=65532 --clear-groups -- "$@"
}

state_root_owner=$(/usr/bin/stat -c '%u:%g' /home/agy)
case "$state_root_owner" in
  0:0)
    /bin/chmod 0700 /home/agy || fail 'cannot protect new OAuth state root'
    /bin/chown 65532:65532 /home/agy || fail 'cannot own new OAuth state root'
    ;;
  65532:65532) ;;
  *) fail "OAuth state root has unexpected owner ${state_root_owner}" ;;
esac

for state_directory in .cache .config .gemini; do
  state_path="/home/agy/${state_directory}"
  as_workload /usr/bin/test ! -L "$state_path" || \
    fail "${state_path} must not be a symlink"
  if as_workload /usr/bin/test -e "$state_path"; then
    as_workload /usr/bin/test -d "$state_path" || \
      fail "${state_path} must be a directory"
    state_owner=$(as_workload /usr/bin/stat -c '%u:%g' "$state_path")
    [ "$state_owner" = "65532:65532" ] || \
      fail "${state_path} has unexpected owner ${state_owner}"
  else
    as_workload /bin/mkdir -m 0700 "$state_path" || \
      fail "cannot create ${state_path}"
  fi
  as_workload /bin/chmod 0700 "$state_path" || fail "cannot protect ${state_path}"
done
as_workload /bin/chmod 0700 /home/agy || fail 'cannot protect OAuth state root'
[ "$(/usr/bin/stat -c '%u:%g:%a' /home/agy)" = "65532:65532:700" ] || \
  fail 'OAuth state root verification failed'

/usr/sbin/nft -f - <<EOF || fail 'cannot load quarantine network policy'
flush ruleset
table inet agy_quarantine {
  chain input {
    type filter hook input priority -100; policy drop;
    iifname "lo" accept
    ct state established,related accept
    tcp dport ${bootstrap_port} ct state new accept
  }
  chain output {
    type filter hook output priority -100; policy drop;
    oifname "lo" accept
    ct state established,related accept
  }
}
EOF

handoff_payload=$(/usr/local/bin/agy-bootstrap-receiver) || \
  fail 'proxy IP handoff timed out'
case "$handoff_payload" in
  *"
"*) fail 'proxy IP handoff contains multiple lines' ;;
esac
case "$handoff_payload" in
  *" "*)
    received_nonce=${handoff_payload%% *}
    proxy_ip=${handoff_payload#* }
    ;;
  *) fail 'proxy IP handoff field count is invalid' ;;
esac
[ -n "$received_nonce" ] && [ -n "$proxy_ip" ] || \
  fail 'proxy IP handoff contains an empty field'
case "$proxy_ip" in
  *" "*) fail 'proxy IP handoff has excess fields' ;;
esac
[ "$received_nonce" = "$bootstrap_nonce" ] || fail 'proxy IP handoff nonce mismatch'
valid_ipv4 "$proxy_ip" || fail 'proxy IP handoff is not IPv4'
case "$proxy_ip" in
  "${network_prefix}."*) ;;
  *) fail 'proxy IP is outside the dedicated network' ;;
esac
proxy_last_octet=${proxy_ip##*.}
[ "$proxy_last_octet" -ge 2 ] && [ "$proxy_last_octet" -le 254 ] || \
  fail 'proxy IP is not a usable network member'

/usr/sbin/nft -f - <<EOF || fail 'cannot load final network policy'
flush ruleset
table inet agy_guard {
  chain input {
    type filter hook input priority -100; policy drop;
    iifname "lo" accept
    ct state established,related accept
  }
  chain output {
    type filter hook output priority -100; policy drop;
    oifname "lo" accept
    ct state established,related accept
    ip daddr ${proxy_ip} tcp dport ${proxy_port} ct state new accept
  }
}
EOF

/usr/sbin/nft list chain inet agy_guard output | \
  /bin/grep -Fq "ip daddr ${proxy_ip} tcp dport ${proxy_port}" || \
  fail 'proxy allow rule verification failed'

export HOME=/home/agy
export HTTPS_PROXY="http://${proxy_ip}:${proxy_port}"
export HTTP_PROXY="http://${proxy_ip}:${proxy_port}"
export ALL_PROXY="http://${proxy_ip}:${proxy_port}"
export https_proxy="$HTTPS_PROXY"
export http_proxy="$HTTP_PROXY"
export all_proxy="$ALL_PROXY"
export NO_PROXY='127.0.0.1,localhost'
export no_proxy="$NO_PROXY"

exec /usr/local/bin/agy-supervisor "$@"
