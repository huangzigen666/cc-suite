---
description: Check CodeBuddy (Tencent) readiness — binary on PATH, authentication, and supported options. Fast and local (no network round-trip).
allowed-tools:
  - Bash
---

# CodeBuddy Preflight

Verify CodeBuddy is ready before delegating to it. This is separate from
`/cc-suite:codex-preflight` (Codex), `/cc-suite:agy-preflight` (Antigravity),
and `/cc-suite:grok-preflight` (Grok).

Unlike Codex/agy, this check is **fast and local** — it does not round-trip to
Tencent. It confirms the `codebuddy` binary is installed and that you're
authenticated (via `CODEBUDDY_API_KEY` or a populated CodeBuddy auth directory),
so `/cc-suite:codebuddy` fails fast with an actionable hint instead of hanging
until the job deadline when CodeBuddy isn't set up. CodeBuddy reports no offline
model cache, so `models` is left empty; pin a model with `--model` at call time.

## Step 1: Run the preflight script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/codebuddy-preflight.sh"
```

Parse the single JSON object from stdout. Keys mirror `codex-preflight.sh`
(`status`, `codebuddy_version`, `auth_mode`, `default_model`, `models`,
`models_detail`, `reasoning_efforts`, `sandbox_levels`).

## Step 2: Display results

```markdown
## CodeBuddy Preflight Results

**Status**: {status}
**codebuddy version**: {codebuddy_version}
**Auth mode**: {auth_mode}   (api_key or session)
**Default model**: {default_model}

### Options

- **Sandbox levels**: read-only, workspace-write, danger-full-access
```

## Step 3: Handle errors

If `status` is `"error"`, show the message and the fix keyed on `error_code`:

- `codebuddy_not_found` → install the CodeBuddy CLI and put `codebuddy` on PATH.
- `not_authenticated` → log in via the CodeBuddy CLI, or set `CODEBUDDY_API_KEY`.

> This is a local readiness check: it confirms the binary and that credentials
> exist, not that the session is still valid. An expired session still surfaces
> at call time as a `failed`/`stalled` job.

## Step 4: Summary

- Ready: "CodeBuddy is ready."
- Error: "CodeBuddy is not ready — {error}. Fix above, then retry."
