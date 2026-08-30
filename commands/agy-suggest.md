---
name: agy-suggest
description: Suggest whether a task fits the verified AGY route without executing it
argument-hint: "<task>"
allowed-tools: []
---

# /cc-suite:agy-suggest

Analyze the task below and recommend a route. This command is advisory only:
it must not call AGY, run commands, use browser/MCP, write files, or dispatch a
background job.

## User Input

```text
$ARGUMENTS
```

## Output

Return exactly these sections:

1. `ROUTE`: `AGY_RECOMMENDED` or `AGY_NOT_RECOMMENDED`.
2. `MODEL`: recommend `gemini-3.7-flash-high` for complex implementation and
   review work; recommend `gemini-3.6-flash-low` for small bounded edits.
3. `REASON`: at most three concrete reasons tied to the task.
4. `BOUNDARY`: state that execution still requires explicit `/cc-suite:agy`
   invocation and that the verified route exposes only the current workspace.
5. `NEXT_COMMAND`: if recommended, provide one copyable command in this form:

```text
/cc-suite:agy --project default-cli-project --model <model> --wait <task>
```

Never claim that AGY was called or that the task succeeded. If the task needs
credentials, external publication, unrestricted access, background execution,
or destructive changes, return `AGY_NOT_RECOMMENDED` and say why.
