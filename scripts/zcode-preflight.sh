#!/usr/bin/env bash
# zcode-preflight.sh — fast LOCAL readiness check for ZCode (Z.AI GLM coding agent).
#
# Like the other cc-suite preflights, this performs NO network round-trip. Its
# job is to fail fast on the things that would otherwise make a zcode delegation
# fail at call time: no ZCode CLI found, or no Z.AI login. The CLI lives inside
# the desktop app (ZCode.app/Contents/Resources/glm/zcode.cjs) and is not on
# PATH; resolution order matches zcode-runner.mjs: $ZCODE_BIN, `zcode` on PATH,
# then the app bundle.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh:
#   {"backend":"zcode","preflight_schema":1,"status":"ok",
#    "zcode_version":"...","auth_mode":"session|unknown",
#    "default_model":null,"models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'
APP_ENTRY="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
ZCODE_CREDENTIALS="$HOME/.zcode/v2/credentials.json"

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"zcode","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","zcode_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

# 1. CLI present?
ENTRY="${ZCODE_BIN:-}"
if [ -z "$ENTRY" ]; then
  ENTRY="$(command -v zcode 2>/dev/null || true)"
fi
if [ -z "$ENTRY" ] && [ -f "$APP_ENTRY" ]; then
  ENTRY="$APP_ENTRY"
fi
if [ -z "$ENTRY" ]; then
  emit_error "zcode_not_found" "ZCode CLI not found. Install ZCode (https://zcode.z.ai) or set ZCODE_BIN to its CLI."
  exit 0
fi
case "$ENTRY" in
  *.cjs|*.js)
    if ! command -v node >/dev/null 2>&1; then
      emit_error "node_not_found" "node not found on PATH; it is required to run $ENTRY."
      exit 0
    fi
    ZCODE_VERSION="$(node "$ENTRY" --version </dev/null 2>/dev/null | head -1 || echo unknown)" ;;
  *)
    ZCODE_VERSION="$("$ENTRY" --version </dev/null 2>/dev/null | head -1 || echo unknown)" ;;
esac
ZCODE_VERSION_JSON="\"$(json_str "$ZCODE_VERSION")\""

# 2. authenticated? The desktop app and CLI share ~/.zcode/v2/credentials.json.
if [ ! -s "$ZCODE_CREDENTIALS" ]; then
  emit_error "not_authenticated" "No ZCode login found. Sign in inside ZCode.app, or run: node \"$ENTRY\" login" "$ZCODE_VERSION_JSON"
  exit 0
fi

# 3. success — zcode -p has no model flag; it uses the model configured in ZCode.
ZCODE_VERSION="$ZCODE_VERSION" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
print(json.dumps({
    "backend": "zcode",
    "preflight_schema": schema,
    "status": "ok",
    "zcode_version": os.environ.get("ZCODE_VERSION", "unknown"),
    "auth_mode": "session",
    "default_model": None,
    "models": [],
    "models_detail": [],
    "reasoning_efforts": json.loads(os.environ["REASONING_EFFORTS"]),
    "sandbox_levels": json.loads(os.environ["SANDBOX_LEVELS"]),
}))
PY
