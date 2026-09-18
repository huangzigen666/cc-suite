---
description: Delegate a prompt to CodeBuddy (Tencent) over the Agent Client Protocol (ACP), with bounded execution and shared job tracking. The Claude → CodeBuddy delegation lane.
argument-hint: "[--model <id>] [--sandbox read-only|workspace-write|danger-full-access] [--background] [--resume <session-id>] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:codebuddy

Send a prompt to **CodeBuddy** through the cc-suite runner. This is the direct
Claude → CodeBuddy delegation surface, alongside the Codex-, agy-, and Grok-backed
lanes.

Under the hood the runner (`scripts/codebuddy-runner.mjs`) drives `codebuddy
--acp` as an **ACP (Agent Client Protocol) client** — it acts as the client,
CodeBuddy is the agent. It streams the answer from `session/update`
notifications, is deadline-bounded and killable, and registers every call as a
job, so `/cc-suite:status`, `/result`, `/cancel`, and `/continue` work
identically to the other backends. CodeBuddy can call back into the client for
file I/O and permission decisions over ACP (`delegateToolsSupport`).

> **The delegation boundary is injected for you.** CodeBuddy reads `AGENTS.md`
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

- `--model <id>` — a CodeBuddy model id. Omit to use CodeBuddy's configured
  default. Pass the exact model slug CodeBuddy expects.
- `--sandbox <read-only|workspace-write|danger-full-access>` — default
  `read-only`.
- `--background` or `--wait` — default `--wait`.
- `--resume <session-id>` — continue a prior CodeBuddy session (the `threadId`
  a previous call returned).

If the prompt is empty, ask the user what they want CodeBuddy to do and stop if
they don't provide one.

### Step 2: Verify CodeBuddy is ready (fail fast)

CodeBuddy can stall until the deadline if it isn't installed or logged in, so
gate on a fast local readiness check before committing to a run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/codebuddy-preflight.sh"
```

Parse the JSON. If `status` is `"error"`, report the `error` and the fix keyed
on `error_code` (`codebuddy_not_found` → install; `not_authenticated` → log in
or set `CODEBUDDY_API_KEY`) and **stop** — do not call the runner. This is a
local check (no network), so it's cheap; it does not replace the runner's own
fail-fast. If `status` is `"ok"`, continue.

### Step 3: Sandbox note

The runner maps cc-suite sandbox levels onto client-side ACP enforcement:

| cc-suite `--sandbox` | CodeBuddy behavior |
|---|---|
| `read-only` | The client rejects fs write requests and denies permission requests. CodeBuddy reads and reasons. Best-effort — CodeBuddy can still use its own tools, so it is not a hard kernel sandbox. |
| `workspace-write` | The client serves fs read/write and approves permission requests, so CodeBuddy can write in the workspace. |
| `danger-full-access` | The client approves everything (same file-I/O posture as `workspace-write`). |

Default to `read-only` unless the task genuinely needs to write. If the user
picks `danger-full-access`, confirm once before proceeding.

### Step 4: Run the request

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codebuddy-runner.mjs" \
  --kind codebuddy \
  {--model "{model}" if given} \
  --sandbox {chosen_sandbox} \
  --timeout-ms 900000 \
  {--background if selected} \
  {--resume "{session_id}" if selected} \
  --summary "codebuddy: {short prompt summary}" \
  -- "{prompt}"
```

> **No availability ping.** Don't pre-probe CodeBuddy. The first real runner
> call either completes or fails fast — a missing `codebuddy` binary errors in
> seconds with an install hint.

### Step 5: Report

Parse the single JSON object from stdout.

- **Foreground**: display `rawOutput` (CodeBuddy's answer), plus `jobId`,
  `status`, and `threadId`. Tell the user they can continue with
  `--resume {threadId}` or `/cc-suite:continue {threadId}` — CodeBuddy's ACP
  session ids are reliable, so resume carries full context.
- **Background**: return the queued `jobId` and point to `/cc-suite:status`,
  `/cc-suite:result`, `/cc-suite:cancel`.

On `failed`, `stalled`, or `blocked`, report the `error` and `jobId` (inspect with
`/cc-suite:status {jobId}`). `blocked` is a policy denial, not a timeout: under
`--sandbox read-only` the runner denied a permission request — including an MCP
tool call — so re-run with `--sandbox workspace-write` only if the task genuinely
needs it. On `stalled` the deadline already cancelled and killed the CodeBuddy
process. Do not auto-retry.
