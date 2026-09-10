---
description: Check Hermes Agent (ACP server) readiness — binary on PATH, authentication, and supported options. Fast and local (no network round-trip).
allowed-tools:
  - Bash
---

# Hermes Preflight

Verify Hermes Agent is ready before delegating to it. This is separate from
`/cc-suite:codex-preflight` (Codex), `/cc-suite:agy-preflight` (Antigravity),
`/cc-suite:grok-preflight` (Grok), `/cc-suite:codebuddy-preflight` (CodeBuddy),
and `/cc-suite:qoder-preflight` (Qoder).

This check confirms the `hermes-acp` binary is installed and reports a
best-effort auth state (presence of `~/.hermes/auth.json`). It does NOT
round-trip to any provider. Hermes reports no offline model cache, so `models`
is empty; the model is whatever Hermes is configured with.

## Step 1: Run the preflight script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-preflight.sh"
```

Parse the single JSON object from stdout. Keys mirror `codex-preflight.sh`
(`status`, `hermes_version`, `auth_mode`, `default_model`, `models`,
`models_detail`, `reasoning_efforts`, `sandbox_levels`).

## Step 2: Display results

```markdown
## Hermes Preflight Results

**Status**: {status}
**hermes version**: {hermes_version}
**Auth mode**: {auth_mode}   (session or unknown)
**Default model**: {default_model}

### Options

- **Sandbox levels**: read-only, workspace-write, danger-full-access
```

## Step 3: Handle errors

If `status` is `"error"`, show the message and the fix keyed on `error_code`:

- `hermes_not_found` → install Hermes Agent so the `hermes-acp` binary is on PATH.

## Step 4: Summary

- Ready: "Hermes is ready (v{hermes_version})."
- Error: "Hermes is not ready — {error}. Fix above, then retry."
