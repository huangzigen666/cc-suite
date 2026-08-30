#!/usr/bin/env bash
# agy-preflight.sh — Check Antigravity CLI (`agy`) availability, auth, and models.
#
# Emits a stable JSON shape for /cc-suite:google-preflight and agy-aware callers:
#   {"backend":"agy","preflight_schema":14,"status":"ok","agy_version":"1.1.14",
#    "default_model":"...","models":[...],"models_detail":[...],
#    "reasoning_efforts":["low","medium","high"],
#    "sandbox_levels":[],"candidate_sandbox_levels":[],
#    "access_modes":[{"name":"workspace-write","status":"blocked",
#      "reason":"r14_oauth_authentication_and_real_model_call_not_run"}],
#    "egress_proxy_required":true,"hook_failure_mode":"fail_open",
#    "local_bind_confined":false,"destination_egress_confined":false,
#    "external_capsule":{"runtime":"apple-container",
#      "promotion_ready":false,"capabilities":[...]},
#    "project_required":true,"detached_worktree_required":true,
#    "isolated_runtime":true,"seatbelt_available":true,
#    "workspace_mcp_registered":true}
#
# Caching: results cached for 5 minutes in $XDG_CACHE_HOME/codex-toolkit/agy-preflight-cache.json.
#          Set AGY_PREFLIGHT_NO_CACHE=1 to skip reading the cache.
#
# Three facts about agy 1.1.x shape this file:
#
#   * `agy models` returns slug<TAB>display. The slug is the value passed to
#     --model; the display label is presentation-only.
#
#   * `--effort` exists, but current Gemini slugs already encode low/medium/high.
#     The runner rejects conflicts and omits a redundant matching flag.
#
#   * There is no non-interactive auth-status command (`agy auth status` opens a
#     TUI and dies without a TTY). `agy models` is used as the connectivity/auth
#     probe instead: it round-trips to Google and fails when unauthenticated.

set -uo pipefail

CACHE_TTL=300
PREFLIGHT_SCHEMA=14
MODELS_TIMEOUT_SECONDS="${AGY_MODELS_TIMEOUT_SECONDS:-10}"
if ! [[ "$MODELS_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  MODELS_TIMEOUT_SECONDS=10
fi
SANDBOX_LEVELS='[]'
REASONING_EFFORTS='[]'
SEATBELT_AVAILABLE=false
if [[ "$(uname -s 2>/dev/null || true)" == "Darwin" && -x /usr/bin/sandbox-exec ]]; then
  SEATBELT_AVAILABLE=true
  CANDIDATE_SANDBOX_LEVELS='[]'
  WORKSPACE_WRITE_STATUS='blocked'
  WORKSPACE_WRITE_REASON='r14_oauth_authentication_and_real_model_call_not_run'
else
  CANDIDATE_SANDBOX_LEVELS='[]'
  WORKSPACE_WRITE_STATUS='blocked'
  WORKSPACE_WRITE_REASON='r14_oauth_authentication_and_real_model_call_not_run'
fi
ACCESS_MODES="[{\"name\":\"read-only\",\"status\":\"blocked\",\"reason\":\"not_enforceable_in_agy_1_1_11\"},{\"name\":\"workspace-write\",\"status\":\"$WORKSPACE_WRITE_STATUS\",\"reason\":\"$WORKSPACE_WRITE_REASON\"},{\"name\":\"danger-full-access\",\"status\":\"blocked\",\"reason\":\"unsafe_mode_disabled\"}]"
R14_SECURITY_STATE='"egress_proxy_required":true,"oauth_state_isolated":false,"bootstrap_handoff_confined":false,"tool_mediation":"r9_deny_all_hook_advisory","hook_failure_mode":"fail_open","local_bind_confined":false,"destination_egress_confined":false,"boundary_audit":"detective_500ms","native_assurance_scope":"integrity_only"'
CAPSULE_CAPABILITIES='[{"id":"external_vm_boundary","status":"unknown","assurance":null},{"id":"workspace_mount_boundary","status":"unknown","assurance":null},{"id":"alternate_mutators_contained","status":"unknown","assurance":null},{"id":"host_credential_isolation","status":"unknown","assurance":null},{"id":"off_policy_egress_blocked","status":"unknown","assurance":null},{"id":"destination_egress_allowlist","status":"unknown","assurance":null},{"id":"inbound_unpublished","status":"unknown","assurance":null},{"id":"host_routable_listener_blocked","status":"unknown","assurance":null},{"id":"workload_privilege_drop","status":"unknown","assurance":null},{"id":"lifecycle_attribution","status":"unknown","assurance":null}]'
OAUTH_VOLUME_JSON=null

info() { [[ -n "${AGY_PREFLIGHT_VERBOSE:-}" ]] && printf '· %s\n' "$*" >&2; return 0; }

json_escape() {
  local s="$1"
  # Shell variables cannot contain NUL. Remove every other JSON-forbidden ASCII
  # control except tab/newline/CR, which are normalized below.
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  printf '%s' "$s"
}

file_age_seconds() {
  local f="$1" now mtime
  now=$(date +%s)
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  echo $(( now - mtime ))
}

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}s" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${seconds}s" "$@"
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

seconds = float(sys.argv[1])
command = sys.argv[2:]
try:
    child = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
except OSError as error:
    sys.stdout.write(f"{error}\n")
    raise SystemExit(127)

try:
    output, _ = child.communicate(timeout=seconds)
except subprocess.TimeoutExpired:
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        output, _ = child.communicate(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        output, _ = child.communicate()
    sys.stdout.buffer.write(output)
    raise SystemExit(124)

sys.stdout.buffer.write(output or b"")
raise SystemExit(child.returncode)
PY
    return $?
  fi

  # No safe process-group supervisor is available. Fail closed without spawning
  # an unbounded child or leaving terminal descendants behind.
  return 124
}

probe_external_capsule() {
  CAPSULE_RUNTIME_DETECTED=false
  CAPSULE_RUNTIME_USABLE=false
  CAPSULE_HOST_SUPPORTED=false
  CAPSULE_RUNTIME_VERSION_JSON=null
  CAPSULE_RUNTIME_DISCOVERY_FINGERPRINT_SAFE='missing'
  CAPSULE_REASON='r14_apple_container_not_installed'

  local os_name machine os_version os_major runtime_bin
  local runtime_mtime runtime_size
  os_name="$(uname -s 2>/dev/null || true)"
  machine="$(uname -m 2>/dev/null || true)"
  os_version="$(sw_vers -productVersion 2>/dev/null || true)"
  os_major="${os_version%%.*}"
  if [[ "$os_name" == "Darwin" && "$machine" == "arm64" && "$os_major" =~ ^[0-9]+$ && "$os_major" -ge 26 ]]; then
    CAPSULE_HOST_SUPPORTED=true
  fi

  runtime_bin="$(type -P container 2>/dev/null || true)"
  if [[ -z "$runtime_bin" ]]; then
    EXTERNAL_CAPSULE_STATE="{\"contract_version\":5,\"runtime\":\"apple-container\",\"host_supported\":$CAPSULE_HOST_SUPPORTED,\"runtime_detected\":false,\"runtime_usable\":false,\"runtime_version\":null,\"runtime_discovery_fingerprint\":\"missing\",\"promotion_ready\":false,\"reason\":\"$CAPSULE_REASON\",\"capabilities\":$CAPSULE_CAPABILITIES}"
    return 0
  fi

  CAPSULE_RUNTIME_DETECTED=true
  runtime_mtime="$(stat -f %m "$runtime_bin" 2>/dev/null || stat -c %Y "$runtime_bin" 2>/dev/null || echo 0)"
  runtime_size="$(stat -f %z "$runtime_bin" 2>/dev/null || stat -c %s "$runtime_bin" 2>/dev/null || echo 0)"
  CAPSULE_RUNTIME_DISCOVERY_FINGERPRINT_SAFE="$(json_escape "$runtime_bin|unexecuted|$runtime_mtime|$runtime_size")"
  if [[ "$CAPSULE_HOST_SUPPORTED" == true ]]; then
    CAPSULE_REASON='r14_capsule_evidence_missing'
  else
    CAPSULE_REASON='r14_apple_container_host_unsupported'
  fi

  EXTERNAL_CAPSULE_STATE="{\"contract_version\":5,\"runtime\":\"apple-container\",\"host_supported\":$CAPSULE_HOST_SUPPORTED,\"runtime_detected\":$CAPSULE_RUNTIME_DETECTED,\"runtime_usable\":$CAPSULE_RUNTIME_USABLE,\"runtime_version\":$CAPSULE_RUNTIME_VERSION_JSON,\"runtime_discovery_fingerprint\":\"$CAPSULE_RUNTIME_DISCOVERY_FINGERPRINT_SAFE\",\"promotion_ready\":false,\"reason\":\"$CAPSULE_REASON\",\"capabilities\":$CAPSULE_CAPABILITIES}"
}

probe_external_capsule

# ── Step 1: binary identity + cache ─────────────────────────────────────────
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-toolkit"
mkdir -p "$CACHE_DIR"
CACHE_FILE="$CACHE_DIR/agy-preflight-cache.json"

if ! command -v agy >/dev/null 2>&1; then
  cat <<JSON
{"backend":"agy","preflight_schema":$PREFLIGHT_SCHEMA,"status":"error","error_code":"agy_not_found","error":"agy not found on PATH. Install Antigravity CLI (antigravity-cli): curl -fsSL https://antigravity.google/cli/install.sh | bash","agy_version":null,"default_model":null,"models":[],"models_detail":[],"reasoning_efforts":$REASONING_EFFORTS,"sandbox_levels":$SANDBOX_LEVELS,"candidate_sandbox_levels":$CANDIDATE_SANDBOX_LEVELS,"project_required":true,"detached_worktree_required":true,"isolated_runtime":true,"seatbelt_available":$SEATBELT_AVAILABLE,$R14_SECURITY_STATE,"external_capsule":$EXTERNAL_CAPSULE_STATE,"access_modes":$ACCESS_MODES,"workspace_mcp_registered":false,"claude_mcp_registered":false}
JSON
  exit 0
fi

AGY_BIN="$(command -v agy)"
AGY_VERSION="$(agy --version 2>/dev/null | head -1 | tr -d '\r')"
AGY_VERSION_SAFE="$(json_escape "${AGY_VERSION:-unknown}")"
R16_RELEASE_HOST=false
if [[ "$AGY_VERSION" == "1.1.14" && "$(type -P container 2>/dev/null || true)" == "/usr/local/bin/container" ]]; then
  R16_RELEASE_HOST=true
fi
AGY_MTIME="$(stat -f %m "$AGY_BIN" 2>/dev/null || stat -c %Y "$AGY_BIN" 2>/dev/null || echo 0)"
AGY_SIZE="$(stat -f %z "$AGY_BIN" 2>/dev/null || stat -c %s "$AGY_BIN" 2>/dev/null || echo 0)"
AGY_FINGERPRINT_SAFE="$(json_escape "$AGY_BIN|${AGY_VERSION:-unknown}|$AGY_MTIME|$AGY_SIZE")"

if [[ "$R16_RELEASE_HOST" != true && -z "${AGY_PREFLIGHT_NO_CACHE:-}" && -f "$CACHE_FILE" \
      && "$(grep -c '"preflight_schema":'$PREFLIGHT_SCHEMA "$CACHE_FILE" 2>/dev/null || true)" -gt 0 \
      && "$(grep -Fc '"reason":"'"$WORKSPACE_WRITE_REASON"'"' "$CACHE_FILE" 2>/dev/null || true)" -gt 0 \
      && "$(grep -Fc '"agy_fingerprint":"'"$AGY_FINGERPRINT_SAFE"'"' "$CACHE_FILE" 2>/dev/null || true)" -gt 0 \
      && "$(grep -Fc '"runtime_discovery_fingerprint":"'"$CAPSULE_RUNTIME_DISCOVERY_FINGERPRINT_SAFE"'"' "$CACHE_FILE" 2>/dev/null || true)" -gt 0 ]]; then
  cache_age=$(file_age_seconds "$CACHE_FILE")
  if [[ $cache_age -lt $CACHE_TTL ]]; then
    info "Using cached results (${cache_age}s old, TTL ${CACHE_TTL}s)"
    cat "$CACHE_FILE"
    exit 0
  fi
fi

info "agy version: ${AGY_VERSION:-unknown}"

AGY_HELP="$(agy --help 2>&1 || true)"
if grep -q -- '--effort' <<< "$AGY_HELP"; then
  REASONING_EFFORTS='["low","medium","high"]'
fi

# ── Step 3: models (doubles as the auth/connectivity probe) ──────────────────
# `agy models` prints slug<TAB>display. It requires a live authenticated session,
# so a non-zero exit or empty list means "not signed in". The timeout is essential:
# an auth/network problem must not hang /cc-suite:google-preflight.
MODELS_RAW="$(run_with_timeout "$MODELS_TIMEOUT_SECONDS" agy models 2>/dev/null | sed -e 's/[[:space:]]*$//' -e '/^$/d' -e '/^Available/d' -e '/^Fetching available models/d')"
MODELS_RC=$?

# Some agy builds have emitted authentication failures on stdout with exit 0.
# Never expose those diagnostic lines as selectable model names.
if printf '%s\n' "$MODELS_RAW" | grep -qiE '(^|[[:space:]])(error:|please sign in|not signed in|not authenticated)'; then
  MODELS_RC=1
fi

if [[ "$MODELS_RC" -ne 0 || -z "$MODELS_RAW" ]]; then
  if [[ "$MODELS_RC" -eq 124 ]]; then
    ERROR="agy model discovery timed out after ${MODELS_TIMEOUT_SECONDS}s — run agy interactively to sign in, then retry"
    ERROR_CODE="agy_probe_timeout"
  else
    ERROR="agy is installed but model discovery failed — run agy interactively to sign in"
    ERROR_CODE="agy_not_authenticated"
  fi
  cat <<JSON
{"backend":"agy","preflight_schema":$PREFLIGHT_SCHEMA,"status":"error","error_code":"$ERROR_CODE","error":"$(json_escape "$ERROR")","agy_version":"$AGY_VERSION_SAFE","agy_fingerprint":"$AGY_FINGERPRINT_SAFE","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":$REASONING_EFFORTS,"sandbox_levels":$SANDBOX_LEVELS,"candidate_sandbox_levels":$CANDIDATE_SANDBOX_LEVELS,"project_required":true,"detached_worktree_required":true,"isolated_runtime":true,"seatbelt_available":$SEATBELT_AVAILABLE,$R14_SECURITY_STATE,"external_capsule":$EXTERNAL_CAPSULE_STATE,"access_modes":$ACCESS_MODES,"workspace_mcp_registered":false,"claude_mcp_registered":false}
JSON
  exit 0
fi

MODELS_JSON="["
MODELS_DETAIL="["
first=1
DEFAULT_MODEL=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ "$line" == *$'\t'* ]]; then
    slug="${line%%$'\t'*}"
    display="${line#*$'\t'}"
  else
    slug="$line"
    display="$line"
  fi
  [[ -z "$slug" ]] && continue
  [[ -z "$DEFAULT_MODEL" ]] && DEFAULT_MODEL="$slug"

  slug_esc="$(json_escape "$slug")"
  display_esc="$(json_escape "$display")"
  case "$slug" in
    *-low) model_efforts='["low"]' ;;
    *-medium) model_efforts='["medium"]' ;;
    *-high) model_efforts='["high"]' ;;
    *) model_efforts='[]' ;;
  esac
  if [[ $first -eq 1 ]]; then
    MODELS_JSON+="\"$slug_esc\""
    MODELS_DETAIL+="{\"slug\":\"$slug_esc\",\"display_name\":\"$display_esc\",\"reasoning_efforts\":$model_efforts}"
    first=0
  else
    MODELS_JSON+=",\"$slug_esc\""
    MODELS_DETAIL+=",{\"slug\":\"$slug_esc\",\"display_name\":\"$display_esc\",\"reasoning_efforts\":$model_efforts}"
  fi
done <<< "$MODELS_RAW"
MODELS_JSON+="]"
MODELS_DETAIL+="]"

model_count="$(printf '%s\n' "$MODELS_RAW" | wc -l | tr -d ' ')"
info "models: $model_count"

# R16 release evidence is current only for the exact host binary, Apple
# Container entrypoint, and a separately recorded serving-path canary. The
# Node preflight executes read-only descriptor audits; it cannot prove that
# the upstream AGY planner will accept the current account/region. Keep the
# public write gate blocked until that independent canary is present.
R16_SERVING_EVIDENCE_FILE="${AGY_R16_SERVING_EVIDENCE_FILE:-$HOME/.config/cc-suite/agy-r16-serving-evidence.json}"
R16_SERVING_PATH_VERIFIED=false
if [[ -f "$R16_SERVING_EVIDENCE_FILE" ]] \
  && grep -Eq '"serving_path_verified"[[:space:]]*:[[:space:]]*true' "$R16_SERVING_EVIDENCE_FILE" \
  && grep -Eq '"agy_version"[[:space:]]*:[[:space:]]*"1.1.14"' "$R16_SERVING_EVIDENCE_FILE"; then
  R16_SERVING_PATH_VERIFIED=true
fi
if [[ "$R16_RELEASE_HOST" == true ]]; then
  R16_OUTPUT="$(node "$(dirname "$0")/agy-r16-preflight.mjs" 2>/dev/null)"
  R16_RC=$?
  if [[ "$R16_RC" -eq 0 ]] \
    && printf '%s' "$R16_OUTPUT" | grep -Fq '"promotion_ready":true' \
    && [[ "$R16_SERVING_PATH_VERIFIED" == true ]]; then
    SANDBOX_LEVELS='["workspace-write"]'
    WORKSPACE_WRITE_STATUS='verified'
    WORKSPACE_WRITE_REASON='r16_external_workspace_write_verified'
    ACCESS_MODES="[{\"name\":\"read-only\",\"status\":\"blocked\",\"reason\":\"not_enforceable_in_agy_1_1_x\"},{\"name\":\"workspace-write\",\"status\":\"verified\",\"reason\":\"$WORKSPACE_WRITE_REASON\"},{\"name\":\"danger-full-access\",\"status\":\"blocked\",\"reason\":\"unsafe_mode_disabled\"}]"
    R14_SECURITY_STATE='"egress_proxy_required":true,"oauth_state_isolated":true,"bootstrap_handoff_confined":true,"tool_mediation":"external_capsule_and_transcript_binding","hook_failure_mode":"not_security_boundary","local_bind_confined":true,"destination_egress_confined":true,"boundary_audit":"per_run_fail_closed","native_assurance_scope":"external_capsule"'
    EXTERNAL_CAPSULE_STATE="$R16_OUTPUT"
    R16_OAUTH_VOLUME="$(printf '%s' "$R16_OUTPUT" | sed -n 's/.*"oauth_volume":"\(cc-suite-agy-oauth-[a-f0-9]\{16\}\)".*/\1/p')"
    if [[ "$R16_OAUTH_VOLUME" =~ ^cc-suite-agy-oauth-[a-f0-9]{16}$ ]]; then
      OAUTH_VOLUME_JSON="\"$R16_OAUTH_VOLUME\""
    else
      SANDBOX_LEVELS='[]'
      WORKSPACE_WRITE_STATUS='blocked'
      WORKSPACE_WRITE_REASON='r16_oauth_volume_identity_missing'
    fi
  fi
fi

if [[ "$R16_RELEASE_HOST" == true ]] && [[ "$R16_SERVING_PATH_VERIFIED" != true ]]; then
  WORKSPACE_WRITE_STATUS='blocked'
  WORKSPACE_WRITE_REASON='r16_serving_path_not_verified'
fi

# ── Step 4: is the reverse bridge (agy → Claude Code) registered? ────────────
# Agy supports workspace and global MCP profiles. Prefer the workspace profile
# generated by cc-suite, while also reporting a global registration.
AGY_WORKSPACE_MCP_CONFIG="$PWD/.agents/mcp_config.json"
AGY_GLOBAL_MCP_CONFIG="$HOME/.gemini/config/mcp_config.json"
WORKSPACE_MCP_REGISTERED=false
CLAUDE_MCP_REGISTERED=false
if [[ -s "$AGY_WORKSPACE_MCP_CONFIG" ]] && grep -q "claude-octopus" "$AGY_WORKSPACE_MCP_CONFIG" 2>/dev/null; then
  WORKSPACE_MCP_REGISTERED=true
  CLAUDE_MCP_REGISTERED=true
fi
if [[ -s "$AGY_GLOBAL_MCP_CONFIG" ]] && grep -q "claude-octopus" "$AGY_GLOBAL_MCP_CONFIG" 2>/dev/null; then
  CLAUDE_MCP_REGISTERED=true
fi
info "claude-code MCP registered in agy workspace: $WORKSPACE_MCP_REGISTERED"
info "claude-code MCP registered in agy global config: $CLAUDE_MCP_REGISTERED"

# ── Step 5: emit + cache ─────────────────────────────────────────────────────
DEFAULT_MODEL_SAFE="$(json_escape "$DEFAULT_MODEL")"
RESULT="{\"backend\":\"agy\",\"preflight_schema\":$PREFLIGHT_SCHEMA,\"status\":\"ok\",\"agy_version\":\"$AGY_VERSION_SAFE\",\"agy_fingerprint\":\"$AGY_FINGERPRINT_SAFE\",\"default_model\":\"$DEFAULT_MODEL_SAFE\",\"models\":$MODELS_JSON,\"models_detail\":$MODELS_DETAIL,\"reasoning_efforts\":$REASONING_EFFORTS,\"sandbox_levels\":$SANDBOX_LEVELS,\"candidate_sandbox_levels\":$CANDIDATE_SANDBOX_LEVELS,\"oauth_volume\":$OAUTH_VOLUME_JSON,\"project_required\":true,\"detached_worktree_required\":true,\"isolated_runtime\":true,\"seatbelt_available\":$SEATBELT_AVAILABLE,$R14_SECURITY_STATE,\"external_capsule\":$EXTERNAL_CAPSULE_STATE,\"access_modes\":$ACCESS_MODES,\"workspace_mcp_registered\":$WORKSPACE_MCP_REGISTERED,\"claude_mcp_registered\":$CLAUDE_MCP_REGISTERED}"

printf '%s\n' "$RESULT" > "$CACHE_FILE"
printf '%s\n' "$RESULT"
