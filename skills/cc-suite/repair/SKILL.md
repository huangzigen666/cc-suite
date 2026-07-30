---
name: repair
description: "Preview and, after explicit approval, re-run all cc-suite bridge and registration scripts. Idempotent escalation step after the diagnose skill finds issues it could not fix. Skill counterpart to /cc-suite:repair."
metadata:
  version: 0.2.7
---

# Repair

Preview every cc-suite setup script and its write scope, then re-run the approved sequence. All scripts are intended to be idempotent, but idempotency does not replace user approval for project or user-level configuration changes.

## When to Use

- `/cc-suite:diagnose` found issues and its auto-fix did not resolve them
- The cc-suite layer is in an inconsistent state (e.g. after a manual edit gone wrong)
- After reinstalling cc-suite to a project, to restore all artifacts at once

If repair still leaves issues, the next step is `/cc-suite:init` in a Claude Code session (full interactive re-initialization).

## Workflow

### Step 0: Preview scope and confirm

Before running any setup script, display this plan with resolved paths:

| Script | Potential write scope |
|--------|-----------------------|
| `init.sh` | Project `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.gitignore`, and cc-suite scaffolding |
| `bridge_skills.sh` | Project `.claude/skills/cc-suite/` and `.agents/skills` symlinks |
| `mcp_codex.sh` | Project `.mcp.json` |
| `mcp_claude.sh` | User-level `~/.codex/config.toml` |
| `bridge_mcp.sh` | User-level `~/.codex/config.toml` plus generated project `.agents/mcp_config.json` |
| `bridge_hooks.py` | Project `.codex/hooks.json` |
| `bridge_tools.py` | Enabled external coding-tool registries described by `.cc-suite.md` |

Show the exact commands listed in Steps 1–6b and ask:

`Run the full repair with these project and user-level changes? (yes / show commands only / cancel)`

Proceed only after an explicit `yes` to this displayed scope. The original repair request is not sufficient approval. If the user chooses `show commands only` or `cancel`, do not modify anything.

### Step 1: Bridge init

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/init.sh"
```

Creates `AGENTS.md`, `CLAUDE.md`, Codex scaffolding, the `.agents/` workspace
skills/MCP projections, and the `.gitignore` block. Antigravity CLI (`agy`)
reads `AGENTS.md` natively and no new Gemini-era project scaffolding is
created. Skips each artifact if it is already in place.

### Step 2: Expose skills

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_skills.sh"
```

Links plugin skills into `.claude/skills/cc-suite/` and ensures `.agents/skills → ../.claude/skills`.

### Step 3: Register codex-cli MCP server

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_codex.sh"
```

Adds `codex-cli` to `.mcp.json` so Claude can invoke Codex as a tool.

### Step 4: Register claude-code MCP server

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/mcp_claude.sh"
```

Adds `claude-code` (claude-octopus) to `.codex/config.toml` so Codex can invoke Claude as a tool.

### Step 5: Mirror MCP servers

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_mcp.sh"
```

Copies additional MCP servers from `.mcp.json` into `.codex/config.toml` and the
generated `.agents/mcp_config.json` projection for agy. User-managed agy
configuration without cc-suite provenance is preserved.

### Step 6: Bridge hooks

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_hooks.py"
```

Mirrors `.claude/settings.json` hooks into `.codex/hooks.json`. Skips gracefully if nothing to bridge.

### Step 6b: Bridge additional coding agents

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bridge_tools.py"
```

Mirrors the project MCP surface into any registry-bridged tools (Grok Build, opencode, Qwen Code, Kimi CLI) enabled in `.cc-suite.md`'s `## Enabled Tools` section. No-op when none are enabled.

### Step 7: Status check

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/status.sh"
```

Show the full status output. Then report:

- **All green**: "Repair complete — cc-suite is healthy."
- **Issues remain**: list remaining `·` and `!` items. Distinguish:
  - Items fixable only interactively (e.g. `AGENTS.md` missing when a non-importable `CLAUDE.md` exists): "Run `/cc-suite:init` in a Claude Code session."
  - Items requiring manual action (Codex trust prompt, Codex CLI not installed): give the exact manual step.
