#!/usr/bin/env bash
# mimo-preflight.sh — fast LOCAL readiness check for Xiaomi MiMo Code (`mimo`).
#
# Like the other cc-suite preflights, this sends no prompt. It fails fast when
# the `mimo` binary is missing. Resolution matches mimo-runner.mjs: $MIMO_BIN,
# the installer location ~/.mimocode/bin/mimo, then `mimo` on PATH.
#
# Auth is reported as "unknown": the default model (deepseek/deepseek-flash)
# runs on MiMo's free endpoint with no stored credential, while xiaomi/* models
# need `mimo providers login`; a missing key surfaces at call time as a failed
# job carrying MiMo's error message.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh:
#   {"backend":"mimo","preflight_schema":1,"status":"ok",
#    "mimo_version":"...","auth_mode":"unknown",
#    "default_model":"deepseek/deepseek-flash","models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'
DEFAULT_MODEL="${MIMO_MODEL:-deepseek/deepseek-flash}"

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"mimo","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","mimo_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

MIMO="${MIMO_BIN:-}"
if [ -z "$MIMO" ] && [ -x "$HOME/.mimocode/bin/mimo" ]; then
  MIMO="$HOME/.mimocode/bin/mimo"
fi
if [ -z "$MIMO" ]; then
  MIMO="$(command -v mimo 2>/dev/null || true)"
fi
if [ -z "$MIMO" ] || [ ! -x "$MIMO" ]; then
  emit_error "mimo_not_found" "mimo not found. Install MiMo Code (it installs to ~/.mimocode/bin/mimo) or set MIMO_BIN."
  exit 0
fi
MIMO_VERSION="$("$MIMO" --version </dev/null 2>/dev/null | head -1 || echo unknown)"

MIMO_VERSION="$MIMO_VERSION" DEFAULT_MODEL="$DEFAULT_MODEL" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
print(json.dumps({
    "backend": "mimo",
    "preflight_schema": schema,
    "status": "ok",
    "mimo_version": os.environ.get("MIMO_VERSION", "unknown"),
    "auth_mode": "unknown",
    "default_model": os.environ["DEFAULT_MODEL"],
    "models": [],
    "models_detail": [],
    "reasoning_efforts": json.loads(os.environ["REASONING_EFFORTS"]),
    "sandbox_levels": json.loads(os.environ["SANDBOX_LEVELS"]),
}))
PY
