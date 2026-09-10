---
description: Delegate a prompt to Qoder (agentic coding CLI) in non-interactive print mode, with bounded execution and shared job tracking. The Claude → Qoder delegation lane.
argument-hint: "[--model <id>] [--effort <level>] [--sandbox read-only|workspace-write|danger-full-access] [--background] [--resume <session-id>] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:qoder

Send a prompt to **Qoder** through the cc-suite runner. This is the direct
Claude → Qoder delegation surface, alongside the Codex-, agy-, Grok-, and
CodeBuddy-backed lanes.

Qoder is a Claude-Code-style coding agent CLI. It has no ACP server mode, so the
runner shells out in non-interactive print mode (`qoder -p --output-format
stream-json`) and scrapes the streamed answer, exactly like the Codex/agy lanes.
Every call is registered as a job, so `/cc-suite:status`, `/result`, `/cancel`,
and `/continue` work identically to the other backends.

> **The delegation boundary is injected for you.** Qoder reads `AGENTS.md` and
> the shared `.agents/skills/` tree natively, so it can see cc-suite's own
> skills for delegating *to* Claude Code. The runner prepends
> `lib/delegation-boundary.mjs` to every prompt so a delegated task is not
> handed straight back to its author. Do not restate it in the prompt; it is
> already there.

## User Input

```text
$ARGUMENTS
```

## Workflow

### Step 1: Parse the request

Extract these optional flags from `$ARGUMENTS`; the remaining text is the prompt:

- `--model <id>` — a Qoder model id. Omit to use Qoder's configured default.
- `--effort <level>` — reasoning effort (forwarded as `--reasoning-effort`).
- `--sandbox <read-only|workspace-write|danger-full-access>` — default
  `read-only`. Mapped to Qoder `--permission-mode` (`auto` / `accept_edits` /
  `bypass_permissions`).
- `--background` or `--wait` — default `--wait`.
- `--resume <session-id>` — continue a prior Qoder session (the `threadId` a
  previous call returned).

If the prompt is empty, ask the user what they want Qoder to do and stop if they
don't provide one.

### Step 2: Verify Qoder is ready (fail fast)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/qoder-preflight.sh"
```

Parse the JSON. If `status` is `"error"`, report the `error` and the fix keyed
on `error_code` (`qoder_not_found` → install). If `status` is `"ok"`, continue.
Qoder auth is reported as `unknown` here; a real auth failure surfaces at call
time as a `failed` job.

### Step 3: Run from a project directory

Qoder's launcher enforces a fail-closed governance rule: **no task execution
from the Home navigation root**. The runner always passes `--cwd` to the
resolved project directory, but you (or the calling agent) must invoke this
from inside a project, not from `~`.

### Step 4: Sandbox note

| cc-suite `--sandbox` | Qoder `--permission-mode` |
|---|---|
| `read-only` | `auto` (best-effort; Qoder has no hard read-only tier) |
| `workspace-write` | `accept_edits` |
| `danger-full-access` | `bypass_permissions` |

Default to `read-only` unless the task genuinely needs to write.

### Step 5: Run the request

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/qoder-runner.mjs" \
  --kind qoder \
  {--model "{model}" if given} \
  {--effort {effort} if given} \
  --sandbox {chosen_sandbox} \
  --timeout-ms 900000 \
  {--background if selected} \
  {--resume "{session_id}" if selected} \
  --summary "qoder: {short prompt summary}" \
  -- "{prompt}"
```

> **No availability ping.** Don't pre-probe Qoder. The first real runner call
> either completes or fails fast.

### Step 6: Report

Parse the single JSON object from stdout.

- **Foreground**: display `rawOutput` (Qoder's answer), plus `jobId`, `status`,
  and `threadId`. Tell the user they can continue with `--resume {threadId}` or
  `/cc-suite:continue {threadId}` (Qoder session ids are reliable for resume).
- **Background**: return the queued `jobId` and point to `/cc-suite:status`,
  `/cc-suite:result`, `/cc-suite:cancel`.

On `failed` or `stalled`, report the `error` and `jobId` (inspect with
`/cc-suite:status {jobId}`). Do not auto-retry.
