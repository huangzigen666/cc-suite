---
description: "Shared: preserve original tasks and bridge Chinese prompts before Claude MCP delegation"
user-invocable: false
---

# Claude MCP prompt bridge

For every fresh or reply Claude MCP call, first prepare the complete intended
task with `cc-suite-prepare`. Supply stdin JSON with `prompt` and optional `cwd`.
Use a structured tool argument or a JSON file written by a file tool; do not
interpolate arbitrary task text into shell code. This command translates text,
never executes the delegated task. Read its stdout JSON and pass the returned
`prompt` to the original MCP tool. Preserve all other tool arguments.

On this machine `cc-suite-prepare` points to `scripts/prepare-delegation.mjs`.
If unavailable, use `node <cc-suite-root>/scripts/prepare-delegation.mjs`.
If neither is reachable, report `BRIDGE_UNAVAILABLE` and pass the unchanged
original task. Do not broaden permissions or change providers to repair it.

New cc-suite-generated Claude MCP registrations use `claude-mcp-bridge.mjs`
and perform the same step automatically. The marker makes preparation
idempotent, so explicit preparation remains safe with old or new registrations.
Internal delegation never requests an extra Chinese summary that would corrupt
a structured response. The calling agent handles the final user's language.
