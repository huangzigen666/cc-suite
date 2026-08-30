#!/bin/sh
set -eu

fail() {
  printf 'AGY_R13_INIT_FAILED: %s\n' "$1" >&2
  exit 70
}

proxy_host="${AGY_PROXY_HOST:-}"
proxy_port="${AGY_PROXY_PORT:-}"

case "$proxy_host" in
  ''|*[!0-9.]*) fail 'AGY_PROXY_HOST must be one IPv4 literal' ;;
esac

case "$proxy_port" in
  ''|*[!0-9]*) fail 'AGY_PROXY_PORT must be numeric' ;;
esac

if [ "$proxy_port" -lt 1 ] || [ "$proxy_port" -gt 65535 ]; then
  fail 'AGY_PROXY_PORT must be in range 1..65535'
fi

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

if ! valid_ipv4 "$proxy_host"; then
  fail 'AGY_PROXY_HOST is not a valid IPv4 literal'
fi

/usr/sbin/nft -f - <<EOF || fail 'cannot load nftables policy'
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
    ip daddr ${proxy_host} tcp dport ${proxy_port} ct state new accept
  }
}
EOF

/usr/sbin/nft list chain inet agy_guard input | grep -Fq 'policy drop' || fail 'input policy verification failed'
/usr/sbin/nft list chain inet agy_guard output | grep -Fq 'policy drop' || fail 'output policy verification failed'
/usr/sbin/nft list chain inet agy_guard output | grep -Fq "ip daddr ${proxy_host} tcp dport ${proxy_port}" || fail 'proxy allow rule verification failed'

exec /usr/local/bin/agy-supervisor "$@"
