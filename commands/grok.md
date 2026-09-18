---
description: Delegate a prompt to Grok Build (xAI) over the Agent Client Protocol (ACP), with bounded execution and shared job tracking. The Claude → Grok delegation lane.
argument-hint: "[--model <id>] [--effort <level>] [--sandbox read-only|workspace-write|danger-full-access] [--background] [--resume <session-id>] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:grok

Send a prompt to **Grok Build** through the cc-suite runner. This is the direct
Claude → Grok delegation surface, alongside the Codex- and agy-backed lanes.

Under the hood the runner (`scripts/grok-runner.mjs`) drives `grok agent stdio`
as an **ACP (Agent Client Protocol) client** — it acts as the client, Grok is the
agent. It streams the answer from `session/update` notifications, is
deadline-bounded and killable, and registers every call as a job, so
`/cc-suite:status`, `/result`, `/cancel`, and `/continue` work identically to the
Codex and agy backends. Grok can call back into Claude through the `claude-code`
MCP server if it's bridged (`/cc-suite:bridge-tools` with grok enabled).

> **The delegation boundary is injected for you.** The runner prepends
> `lib/delegation-boundary.mjs` to every prompt so a delegated task is not handed
> straight back to its author. Do not restate it in the prompt; it is already there.
>
> Two limits are worth knowing. The boundary names specific *workspace skills*, so
> it does not by itself cover handing work back through an MCP tool such as
> `claude-code`. And those skills are only visible to grok where `.agents/skills`
> has been bridged (`bridge_skills.sh`) — in a repo without it, the boundary has
> nothing to suppress.

## User Input

```text
$ARGUMENTS
```

## Workflow

### Step 1: Parse the request

Extract these optional flags from `$ARGUMENTS`; the remaining text is the prompt:

- `--model <id>` — a Grok model id (e.g. `grok-build`). Omit to use Grok's
  configured default. Run `grok models` to list available ids.
- `--effort <level>` — reasoning effort: `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`. Omit for the default. (Unlike agy, Grok *does* take an
  effort flag.)
- `--sandbox <read-only|workspace-write|danger-full-access>` — default
  `read-only`.
- `--background` or `--wait` — default `--wait`.
- `--resume <session-id>` — continue a prior Grok session (the `threadId` a
  previous call returned).

If the prompt is empty, ask the user what they want Grok to do and stop if they
don't provide one.

### Step 2: Verify Grok is ready (fail fast)

Grok can stall until the deadline if it isn't installed or logged in, so gate on
a fast local readiness check before committing to a run:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/grok-preflight.sh"
```

Parse the JSON. If `status` is `"error"`, report the `error` and the fix keyed on
`error_code` (`grok_not_found` → install; `not_authenticated` → `grok login` or
set `XAI_API_KEY`) and **stop** — do not call the runner. This is a local check
(no network), so it's cheap; it does not replace the runner's own fail-fast. If
`status` is `"ok"`, continue.

### Step 3: Sandbox note

The runner maps cc-suite sandbox levels onto Grok's ACP permission behavior:

| cc-suite `--sandbox` | Grok behavior |
|---|---|
| `read-only` | The runner passes a top-level `--permission-mode default`, which overrides any global `permission_mode` in the user config; grok then asks before privileged actions and the client can deny them. Reads keep working. This covers MCP tools (for example `claude-code`), not just file writes. Not a kernel sandbox — the agent still reasons over whatever it can read. |
| `workspace-write` | `--always-approve`; Grok reads and writes files in the workspace. |
| `danger-full-access` | `--always-approve` (Grok has no stricter tier over ACP). |

Default to `read-only` unless the task genuinely needs to write. If the user
picks `danger-full-access`, confirm once before proceeding.

### Step 4: Run the request

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-runner.mjs" \
  --kind grok \
  {--model "{model}" if given} \
  {--effort {effort} if given} \
  --sandbox {chosen_sandbox} \
  --timeout-ms 900000 \
  {--background if selected} \
  {--resume "{session_id}" if selected} \
  --summary "grok: {short prompt summary}" \
  -- "{prompt}"
```

> **No availability ping.** Don't pre-probe Grok. The first real runner call
> either completes or fails fast — a missing `grok` binary errors in seconds with
> an install hint (`curl -fsSL https://x.ai/cli/install.sh | bash`).

### Step 5: Report

Parse the single JSON object from stdout.

- **Foreground**: display `rawOutput` (Grok's answer), plus `jobId`, `status`,
  and `threadId`. Tell the user they can continue with `--resume {threadId}` or
  `/cc-suite:continue {threadId}` — Grok's ACP session ids are reliable, so
  resume carries full context.
- **Background**: return the queued `jobId` and point to `/cc-suite:status`,
  `/cc-suite:result`, `/cc-suite:cancel`.

On `failed`, `stalled`, or `blocked`, report the `error` and `jobId` (inspect with
`/cc-suite:status {jobId}`). `blocked` is a policy denial, not a timeout: under
`--sandbox read-only` the runner denied a permission request — including an MCP
tool call — so re-run with `--sandbox workspace-write` only if the task genuinely
needs it. On `stalled` the deadline already cancelled and killed the Grok process.
Do not auto-retry.
