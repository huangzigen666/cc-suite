#!/usr/bin/env bash
# doubao-preflight.sh — fast LOCAL readiness check for Doubao (豆包 desktop app).
#
# Like the other cc-suite preflights, this sends no prompt. The doubao CLI
# drives the signed-in Doubao.app renderer over local CDP, so readiness means:
# `doubao` on PATH, Doubao.app installed, and its CDP endpoint answering on
# localhost. `doubao cdp status` only probes 127.0.0.1 — no remote round-trip.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh:
#   {"backend":"doubao","preflight_schema":1,"status":"ok",
#    "doubao_version":"...","auth_mode":"session",
#    "default_model":null,"models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'
DOUBAO="${DOUBAO_BIN:-doubao}"

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"doubao","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","doubao_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

# 1. CLI present?
if ! command -v "$DOUBAO" >/dev/null 2>&1; then
  emit_error "doubao_not_found" "doubao not found on PATH. Install the CLI: npm i -g doubao-cli (or set DOUBAO_BIN)."
  exit 0
fi
DOUBAO_VERSION="$(DOUBAO_CLI_DISABLE_AUTO_UPDATE=1 "$DOUBAO" --version </dev/null 2>/dev/null | head -1 || echo unknown)"
DOUBAO_VERSION_JSON="\"$(json_str "$DOUBAO_VERSION")\""

# 2. app installed and CDP reachable?
STATUS="$(DOUBAO_CLI_DISABLE_AUTO_UPDATE=1 "$DOUBAO" status --json </dev/null 2>/dev/null || true)"
if ! printf '%s' "$STATUS" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("installed") else 1)' 2>/dev/null; then
  emit_error "app_not_found" "Doubao.app not found. Install Doubao, or set DOUBAO_APP to its path." "$DOUBAO_VERSION_JSON"
  exit 0
fi
CDP="$(DOUBAO_CLI_DISABLE_AUTO_UPDATE=1 "$DOUBAO" cdp status --json </dev/null 2>/dev/null || true)"
if ! printf '%s' "$CDP" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("available") else 1)' 2>/dev/null; then
  emit_error "cdp_unavailable" "Doubao.app is not reachable over CDP. Run: doubao cdp launch (it restarts Doubao with automation enabled)." "$DOUBAO_VERSION_JSON"
  exit 0
fi

# 3. success — the app session is the login; model choice is Doubao's own.
DOUBAO_VERSION="$DOUBAO_VERSION" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
print(json.dumps({
    "backend": "doubao",
    "preflight_schema": schema,
    "status": "ok",
    "doubao_version": os.environ.get("DOUBAO_VERSION", "unknown"),
    "auth_mode": "session",
    "default_model": None,
    "models": [],
    "models_detail": [],
    "reasoning_efforts": json.loads(os.environ["REASONING_EFFORTS"]),
    "sandbox_levels": json.loads(os.environ["SANDBOX_LEVELS"]),
}))
PY
