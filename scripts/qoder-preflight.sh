#!/usr/bin/env bash
# qoder-preflight.sh — fast LOCAL readiness check for Qoder (agentic coding CLI).
#
# Like the other cc-suite preflights, this performs NO network round-trip. Its
# job is to fail fast on the one thing that would otherwise make /cc-suite:qoder
# hang until the job deadline: qoder not installed. Authentication is reported
# as "unknown" (Qoder's auth is not reliably detectable from a local check),
# so the runner surfaces real auth errors at call time instead.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh:
#   {"backend":"qoder","preflight_schema":1,"status":"ok",
#    "qoder_version":"...","auth_mode":"unknown",
#    "default_model":null,"models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'

json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"qoder","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","qoder_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

# 1. binary present?
if ! command -v qoder >/dev/null 2>&1; then
  emit_error "qoder_not_found" "qoder not found on PATH. Install Qoder: https://qoder.com"
  exit 0
fi
QODER_VERSION="$(qoder --version 2>/dev/null | head -1 || echo unknown)"
QODER_VERSION_JSON="\"$(json_str "$QODER_VERSION")\""

# 2. success — we cannot reliably detect Qoder auth locally, so report unknown
#    and let the runner surface real auth errors. `qoder --version` is in the
#    launcher's safe-invocation set, so it runs even from the Home root.
QODER_VERSION="$QODER_VERSION" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
version = os.environ.get("QODER_VERSION", "unknown")
reasoning = json.loads(os.environ["REASONING_EFFORTS"])
sandboxes = json.loads(os.environ["SANDBOX_LEVELS"])

print(json.dumps({
    "backend": "qoder",
    "preflight_schema": schema,
    "status": "ok",
    "qoder_version": version,
    "auth_mode": "unknown",
    "default_model": None,
    "models": [],
    "models_detail": [],
    "reasoning_efforts": reasoning,
    "sandbox_levels": sandboxes,
}))
PY
