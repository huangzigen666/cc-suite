---
description: Delegate a prompt to Hermes Agent (local ACP-capable agent) over the Agent Client Protocol (ACP), with bounded execution and shared job tracking. The Claude → Hermes delegation lane.
argument-hint: "[--model <id>] [--sandbox read-only|workspace-write|danger-full-access] [--background] [--resume <session-id>] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:hermes

Send a prompt to **Hermes Agent** through the cc-suite runner. This is the
direct Claude → Hermes delegation surface, alongside the Codex-, agy-, Grok-,
Qwen-, CodeBuddy-, and Qoder-backed lanes.

Hermes ships an ACP server binary (`hermes-acp`). The runner (`scripts/hermes-runner.mjs`)
drives `hermes-acp` as an **ACP (Agent Client Protocol) client** — it acts as
the client, Hermes is the agent. It streams the answer from `session/update`
notifications, is deadline-bounded and killable, and registers every call as a
job, so `/cc-suite:status`, `/result`, `/cancel`, and `/continue` work
identically to the other backends. Hermes can call back into the client for
file I/O and permission decisions over ACP (`delegateToolsSupport`).

> **The delegation boundary is injected for you.** Hermes reads `AGENTS.md`
> and the shared `.agents/skills/` tree natively, so it can see cc-suite's own
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

- `--model <id>` — accepted but **not forwarded**: Hermes ACP has no standard
  model parameter, so the model is whatever Hermes is configured with.
- `--sandbox <read-only|workspace-write|danger-full-access>` — default
  `read-only`.
- `--background` or `--wait` — default `--wait`.
- `--resume <session-id>` — continue a prior Hermes session (the `threadId` a
  previous call returned).

If the prompt is empty, ask the user what they want Hermes to do and stop if
they don't provide one.

### Step 2: Verify Hermes is ready (fail fast)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-preflight.sh"
```

Parse the JSON. If `status` is `"error"`, report the `error` and the fix keyed
on `error_code` (`hermes_not_found` → install Hermes Agent). If `status` is
`"ok"`, continue. `auth_mode` is a best-effort local check; a real auth failure
surfaces at call time as a `failed` job.

### Step 3: Sandbox note

The runner maps cc-suite sandbox levels onto client-side ACP enforcement:

| cc-suite `--sandbox` | Hermes behavior |
|---|---|
| `read-only` | The client rejects fs write requests and denies permission requests. Hermes reads and reasons. |
| `workspace-write` | The client serves fs read/write and approves permission requests, so Hermes can write in the workspace. |
| `danger-full-access` | The client approves everything (same file-I/O posture as `workspace-write`). |

Default to `read-only` unless the task genuinely needs to write.

### Step 4: Run the request

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hermes-runner.mjs" \
  --kind hermes \
  --sandbox {chosen_sandbox} \
  --timeout-ms 900000 \
  {--background if selected} \
  {--resume "{session_id}" if selected} \
  --summary "hermes: {short prompt summary}" \
  -- "{prompt}"
```

> **No availability ping.** Don't pre-probe Hermes. The first real runner call
> either completes or fails fast.

### Step 5: Report

Parse the single JSON object from stdout.

- **Foreground**: display `rawOutput` (Hermes's answer), plus `jobId`,
  `status`, and `threadId`. Tell the user they can continue with
  `--resume {threadId}` or `/cc-suite:continue {threadId}` — Hermes's ACP
  session ids are reliable, so resume carries full context.
- **Background**: return the queued `jobId` and point to `/cc-suite:status`,
  `/cc-suite:result`, `/cc-suite:cancel`.

On `failed` or `stalled`, report the `error` and `jobId` (inspect with
`/cc-suite:status {jobId}`). Do not auto-retry — the runner already recorded the
diagnostic log and, on timeout, already cancelled and killed the Hermes process.
