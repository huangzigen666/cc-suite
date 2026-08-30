---
name: agy
description: Run one verified Antigravity workspace-write task through the R16 external capsule
argument-hint: "--project default-cli-project [--model <slug>] [--effort low|medium|high] [--wait] <prompt>"
allowed-tools:
  - Bash
  - AskUserQuestion
---

# /cc-suite:agy

Run one Antigravity CLI task through the verified R16 Apple Container boundary.
This command exposes only `workspace-write`; `read-only`, unrestricted access,
resume, additional directories, and background execution remain blocked.

## User Input

```text
$ARGUMENTS
```

## Workflow

### 1. Parse exact public arguments

Accept only:

- `--project default-cli-project` — required and must be this exact value.
- `--model <slug>` — optional; it must exactly match a model slug returned by preflight.
- `--effort low|medium|high` — optional; reject a value that conflicts with a
  model suffix already ending in `-low`, `-medium`, or `-high`.
- `--wait` — optional and the only execution form. Reject `--background`.
- the remaining non-empty text is the prompt.

Reject resume, `--mode`, `--add-dir`, `read-only`, and
`danger-full-access`. Do not infer another project or workspace.

### 2. Require current R16 preflight

Run without cache:

```bash
AGY_PREFLIGHT_NO_CACHE=1 bash "${CLAUDE_PLUGIN_ROOT}/scripts/agy-preflight.sh"
```

Stop unless all of these fields are present in the single JSON result:

- `status` is `ok`;
- `agy_version` is `1.1.14`;
- `sandbox_levels` contains `workspace-write`;
- the `workspace-write` access mode has status `verified` and reason
  `r16_external_workspace_write_verified`;
- `external_capsule.promotion_ready` is `true`;
- `~/.config/cc-suite/agy-r16-serving-evidence.json` exists, contains
  `"serving_path_verified":true`, and is for AGY `1.1.14`;
- `oauth_volume` matches `cc-suite-agy-oauth-[a-f0-9]{16}`.

If no model was supplied, use `default_model`. Never use a display label as the
model argument.

### 3. Execute only the released wrapper

Run the following in the current workspace, preserving the prompt as one exact
argument and adding `--effort` only when supplied:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-public-runner.mjs" \
  --project default-cli-project \
  --model <exact-model-slug> \
  --timeout-ms 900000 \
  -- <exact-prompt>
```

Do not call `agy` directly. Do not call the runner's candidate flags. Do not
substitute a host path for a container tool target; AGY sees the current
worktree as `/workspace`.

### 4. Report the evidence boundary

Treat the wrapper's JSON as authoritative. A successful result must include:

- `status: completed` and a non-null `threadId`;
- one or more `workspaceChanges`;
- `r16Evidence.runtimeResourcesCleaned: true`;
- `r16Evidence.mutationBinding.ready: true`;
- transcript tool targets, content hashes, and the same `runId` in mutation
  bindings;
- a bounded OAuth token merge result.

Any missing field, failed cleanup, extra mutation, or non-zero exit is a failed
task. Report the exact `errorCode`; never reinterpret it as success.
