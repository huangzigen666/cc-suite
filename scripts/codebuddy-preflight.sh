#!/usr/bin/env bash
# codebuddy-preflight.sh — fast LOCAL readiness check for CodeBuddy (Tencent).
#
# Like grok-preflight.sh, this performs NO network round-trip. Its job is to
# fail fast on the two things that would otherwise make /cc-suite:codebuddy
# hang until the job deadline: codebuddy not installed, or not logged in.
# Both are detectable locally (binary on PATH; CODEBUDDY_API_KEY env or a
# non-empty CodeBuddy auth directory), so a preflight here is a cheap pre-check
# rather than a full connectivity probe — which also respects the "no
# availability ping" philosophy the delegation runners follow.
#
# CodeBuddy's ACP server advertises authMethods but there is no portable
# models_cache file we can read without network, so models are reported as
# unknown (empty). Callers that want a pinned model pass --model explicitly.
#
# Output: a single JSON line whose keys mirror codex-preflight.sh / grok-preflight.sh:
#   {"backend":"codebuddy","preflight_schema":1,"status":"ok",
#    "codebuddy_version":"...","auth_mode":"api_key|session",
#    "default_model":null,"models":[],"models_detail":[],
#    "reasoning_efforts":[],"sandbox_levels":[...]}
# On failure: status="error" with error_code + an actionable error message.

set -euo pipefail

PREFLIGHT_SCHEMA=1
SANDBOX_LEVELS='["read-only","workspace-write","danger-full-access"]'
REASONING_EFFORTS='[]'
# CodeBuddy stores its auth under the extension Application Support dir. We only
# test that the directory exists and is non-empty — reading individual tokens
# is intentionally avoided (some environments sandbox that path).
CODEBUDDY_AUTH_DIR="${CODEBUDDY_AUTH_HOME:-$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth}"

# JSON forbids raw bytes below 0x20, and `codebuddy --version` can emit ANSI.
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

emit_error() { # error_code, message, [version-or-null]
  printf '{"backend":"codebuddy","preflight_schema":%s,"status":"error","error_code":"%s","error":"%s","codebuddy_version":%s,"auth_mode":"none","default_model":null,"models":[],"models_detail":[],"reasoning_efforts":%s,"sandbox_levels":%s}\n' \
    "$PREFLIGHT_SCHEMA" "$1" "$(json_str "$2")" "${3:-null}" "$REASONING_EFFORTS" "$SANDBOX_LEVELS"
}

# 1. binary present?
if ! command -v codebuddy >/dev/null 2>&1; then
  emit_error "codebuddy_not_found" "codebuddy not found on PATH. Install the CodeBuddy CLI and ensure \`codebuddy\` is on PATH."
  exit 0
fi
CODEBUDDY_VERSION="$(codebuddy --version 2>/dev/null | head -1 || echo unknown)"
CODEBUDDY_VERSION_JSON="\"$(json_str "$CODEBUDDY_VERSION")\""

# 2. authenticated? (local check only)
AUTH_MODE="none"
if [ -n "${CODEBUDDY_API_KEY:-}" ]; then
  AUTH_MODE="api_key"
elif [ -d "$CODEBUDDY_AUTH_DIR" ] && [ -n "$(ls -A "$CODEBUDDY_AUTH_DIR" 2>/dev/null)" ]; then
  AUTH_MODE="session"
fi
if [ "$AUTH_MODE" = "none" ]; then
  emit_error "not_authenticated" "CodeBuddy is not authenticated. Log in via the CodeBuddy CLI, or set CODEBUDDY_API_KEY." "$CODEBUDDY_VERSION_JSON"
  exit 0
fi

# 3. success — build the ok payload. Models are unknown (no offline cache), so
#    we report empty lists. Callers pin a model with --model if needed.
CODEBUDDY_VERSION="$CODEBUDDY_VERSION" AUTH_MODE="$AUTH_MODE" \
REASONING_EFFORTS="$REASONING_EFFORTS" SANDBOX_LEVELS="$SANDBOX_LEVELS" \
python3 - "$PREFLIGHT_SCHEMA" <<'PY'
import json, os, sys

schema = int(sys.argv[1])
version = os.environ.get("CODEBUDDY_VERSION", "unknown")
auth_mode = os.environ.get("AUTH_MODE", "none")
reasoning = json.loads(os.environ["REASONING_EFFORTS"])
sandboxes = json.loads(os.environ["SANDBOX_LEVELS"])

print(json.dumps({
    "backend": "codebuddy",
    "preflight_schema": schema,
    "status": "ok",
    "codebuddy_version": version,
    "auth_mode": auth_mode,
    "default_model": None,
    "models": [],
    "models_detail": [],
    "reasoning_efforts": reasoning,
    "sandbox_levels": sandboxes,
}))
PY
