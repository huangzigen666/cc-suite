---
description: Check Qoder (agentic coding CLI) readiness — binary on PATH and version. Fast and local (no network round-trip).
allowed-tools:
  - Bash
---

# Qoder Preflight

Verify Qoder is ready before delegating to it. This is separate from
`/cc-suite:codex-preflight` (Codex), `/cc-suite:agy-preflight` (Antigravity),
`/cc-suite:grok-preflight` (Grok), and `/cc-suite:codebuddy-preflight`
(CodeBuddy).

This check confirms the `qoder` binary is installed and reports its version. It
does NOT round-trip to any server and cannot reliably detect Qoder auth, so
`auth_mode` is reported as `unknown`; a real auth failure surfaces at call time
as a `failed` job. Qoder reports no offline model cache, so `models` is empty;
pin a model with `--model` at call time.

## Step 1: Run the preflight script

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/qoder-preflight.sh"
```

Parse the single JSON object from stdout. Keys mirror `codex-preflight.sh`
(`status`, `qoder_version`, `auth_mode`, `default_model`, `models`,
`models_detail`, `reasoning_efforts`, `sandbox_levels`).

## Step 2: Display results

```markdown
## Qoder Preflight Results

**Status**: {status}
**qoder version**: {qoder_version}
**Auth mode**: {auth_mode}   (unknown — real auth errors surface at call time)
**Default model**: {default_model}

### Options

- **Sandbox levels**: read-only, workspace-write, danger-full-access
```

## Step 3: Handle errors

If `status` is `"error"`, show the message and the fix keyed on `error_code`:

- `qoder_not_found` → install Qoder: https://qoder.com

## Step 4: Summary

- Ready: "Qoder is ready (v{qoder_version})."
- Error: "Qoder is not ready — {error}. Fix above, then retry."
