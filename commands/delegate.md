---
description: Route a prompt to any cc-suite backend (codex, agy, grok, qwen, codebuddy, qoder, hermes, zcode, doubao) through the universal delegator, with bounded execution and shared job tracking. The Claude → any-agent delegation lane.
argument-hint: "<backend> [--model <id>] [--effort <level>] [--sandbox read-only|workspace-write|danger-full-access] [--background] [--resume <session-id>] [--] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:delegate

Send a prompt to **any** backend in the cc-suite grid through the universal
delegator. This is the single Claude-facing surface for the whole agent mesh:
`codex`, `agy`, `grok`, `qwen`, `codebuddy`, `qoder`, `hermes`, `zcode`, and
`doubao`. The first
word of the request selects the backend; the rest is forwarded to that
backend's runner unchanged.

Under the hood the right runner
(`scripts/<backend>-runner.mjs`) is invoked with `--kind <backend>`, so every
call is registered as a job and `/cc-suite:status`, `/result`, `/cancel`, and
`/continue` work identically regardless of which agent you picked. Each backend
keeps its own transport and sandbox semantics — CodeBuddy and Hermes speak
**ACP**, while Qoder is print+scrape and Codex/agy/Grok/qwen use their own
non-interactive modes. The delegator hides that; you just name a backend.

> **The delegation boundary is injected for you.** Every runner prepends
> `lib/delegation-boundary.mjs` to the prompt so a delegated task is not handed
> straight back to its author. Do not restate it in the prompt; it is already
> there.

## User Input

```text
$ARGUMENTS
```

## Workflow

### Step 1: Parse the request

The first whitespace-delimited token is the **backend**. It must be one of:

```
codex   agy   grok   qwen   codebuddy   qoder   hermes   zcode   doubao
```

Strip a single leading `--` separator if present, then extract these optional
flags from the remainder; whatever is left is the **prompt**:

- `--model <id>` — a backend-specific model id. Omit to use the backend default.
- `--effort <level>` — reasoning effort (forwarded as `--reasoning-effort`;
  only meaningful for backends that accept it, e.g. `qoder`).
- `--sandbox <read-only|workspace-write|danger-full-access>` — default
  `read-only`.
- `--background` or `--wait` — default `--wait`.
- `--resume <session-id>` — continue a prior session (the `threadId` a previous
  call returned).

If the backend is missing or not in the list above, list the supported backends
and stop. If the prompt is empty, ask the user what they want the backend to do
and stop if they don't provide one.

### Step 2: Verify the backend is ready (fail fast)

Gate on a fast local readiness check before committing to a run. Each backend
ships a preflight script:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/{backend}-preflight.sh"
```

Replace `{backend}` with the parsed backend. Parse the JSON. If `status` is
`"error"`, report the `error` and the fix keyed on `error_code` (e.g.
`*_not_found` → install; `not_authenticated` → log in or set the relevant API
key) and **stop** — do not call the runner. This is a local check (no network),
so it's cheap. If `status` is `"ok"`, continue.

### Step 3: Sandbox note

The chosen `--sandbox` level is mapped by the selected backend's runner onto its
native enforcement (ACP client-side fs/permission callbacks for CodeBuddy and
Hermes; `--permission-mode` for Qoder; `--mode plan|edit|yolo` for ZCode; the
backend default otherwise). Doubao is a chat assistant with no workspace
access, so every level behaves the same there — only the prompt text leaves the
machine. The mapping is handled inside the runner — you only pick the level:

| `--sandbox` | Meaning |
|---|---|
| `read-only` | Reason/read only; writes and permission prompts are denied or best-effort blocked. Default. |
| `workspace-write` | The backend may write within the workspace. |
| `danger-full-access` | The backend gets full access. Confirm once before proceeding. |

Default to `read-only` unless the task genuinely needs to write.

### Step 4: Run the request

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/{backend}-runner.mjs" \
  --kind {backend} \
  {--model "{model}" if given} \
  {--effort {effort} if given} \
  --sandbox {chosen_sandbox} \
  --timeout-ms 900000 \
  {--background if selected} \
  {--resume "{session_id}" if selected} \
  --summary "{backend}: {short prompt summary}" \
  -- "{prompt}"
```

> **No availability ping.** Don't pre-probe the backend. The first real runner
> call either completes or fails fast — a missing binary errors in seconds with
> an install hint.

Some backends have environmental prerequisites the code can't fix for you:
`qoder` enforces a **no execution from the Home root** rule, so run this from
inside a project directory, not `~`; `hermes` requires its ACP extras
(`pip install -e '.[acp]'` in the Hermes venv); `zcode` runs the CLI bundled
in ZCode.app and needs a Z.AI login (sign in inside the app); `doubao` needs
the `doubao` CLI (`npm i -g doubao-cli`) and a running Doubao.app with CDP
enabled (`doubao cdp launch`, which restarts the app). `zcode` ignores
`--model`/`--effort`; `doubao` forwards them as `--model`/`--reasoning`, and
its `threadId` is a Doubao conversation id. If the runner returns a
`failed` job naming such a prerequisite, surface it verbatim.

### Step 5: Report

Parse the single JSON object from stdout.

- **Foreground**: display `rawOutput` (the backend's answer), plus `jobId`,
  `status`, and `threadId`. Tell the user they can continue with
  `--resume {threadId}` or `/cc-suite:continue {threadId}` when the backend
  supports reliable resume.
- **Background**: return the queued `jobId` and point to `/cc-suite:status`,
  `/cc-suite:result`, `/cc-suite:cancel`.

On `failed`, `stalled`, or `blocked`, report the `error` and `jobId` (inspect with
`/cc-suite:status {jobId}`). `blocked` is a policy denial, not a timeout: under
`--sandbox read-only` the runner denied a permission request — including an MCP
tool call — so re-run with `--sandbox workspace-write` only if the task genuinely
needs it. On `stalled` the deadline already cancelled and killed the backend
process. Do not auto-retry.
