#!/usr/bin/env bash
# hermes-preflight.sh — fast LOCAL readiness check for Hermes Agent (ACP server).
#
# Like the other cc-suite preflights, this performs NO network round-trip. Its
# job is to fail fast on the one thing that would otherwise make /cc-suite:hermes
# hang until the job deadline: hermes-acp not installed (or Hermes not set up).
# Authentication is a best-effort local check (presence of ~/.hermes/auth.json);
# a real auth failure surfaces at call time as a `failed` job.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh:
#   {"backend":"hermes","preflight_schema":1,"status":"ok",
#    "hermes_version":"...","auth_mode":"session|unknown",
#    "default_model":null,"models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'
HERMES_AUTH="$HOME/.hermes/auth.json"

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"hermes","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","hermes_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

# 1. binary present?
if ! command -v hermes-acp >/dev/null 2>&1; then
  emit_error "hermes_not_found" "hermes-acp not found on PATH. Install Hermes Agent so the 'hermes-acp' binary is available (run 'hermes --help')."
  exit 0
fi
HERMES_VERSION="$(hermes-acp --version 2>/dev/null | head -1 || echo unknown)"
HERMES_VERSION_JSON="\"$(json_str "$HERMES_VERSION")\""

# 2. authenticated? (best-effort local check: a non-empty auth.json)
AUTH_MODE="unknown"
if [ -s "$HERMES_AUTH" ]; then
  AUTH_MODE="session"
fi

# 3. success — models are unknown (Hermes picks its own configured model), so
#    we report empty lists. Callers that want a specific model set it in Hermes'
#    own config; --model is accepted by the runner but not forwarded to ACP.
HERMES_VERSION="$HERMES_VERSION" AUTH_MODE="$AUTH_MODE" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
version = os.environ.get("HERMES_VERSION", "unknown")
auth_mode = os.environ.get("AUTH_MODE", "unknown")
reasoning = json.loads(os.environ["REASONING_EFFORTS"])
sandboxes = json.loads(os.environ["SANDBOX_LEVELS"])

print(json.dumps({
    "backend": "hermes",
    "preflight_schema": schema,
    "status": "ok",
    "hermes_version": version,
    "auth_mode": auth_mode,
    "default_model": None,
    "models": [],
    "models_detail": [],
    "reasoning_efforts": reasoning,
    "sandbox_levels": sandboxes,
}))
PY
