# cc-suite vs. comparable agent-tooling projects

> This is not a skill file fed to an AI agent — it's a document for a human evaluator deciding whether cc-suite fits their setup. No agent should load this at runtime.

## TL;DR

cc-suite's job is **bidirectional delegation across multiple AI coding CLIs** (Claude, Codex, Antigravity, Grok, Qwen, opencode, Kimi) plus keeping their config in sync. It does not enforce quality gates and it does not run as a hot-pluggable runtime extension engine — those are different projects' jobs, and this doc says so plainly instead of pretending cc-suite covers everything.

## Comparison table

| | **cc-suite** | **addyosmani/agent-skills** | **steipete/agent-scripts + CodexBar** | **nlpm** |
|---|---|---|---|---|
| Positioning | Cross-CLI delegation + config bridge | Single-ecosystem SDLC skill pack (Claude Code only) | Personal multi-machine skill sync + standalone usage-monitor app | Rule/scoring system for NL artifacts |
| Distribution | Claude Code plugin marketplace (xiaolai + community mirror) | Git clone / skill install | agent-scripts: manual clone + run; CodexBar: packaged macOS app | Plugin marketplace |
| Quality-gate timing | On-demand (`/cc-suite:audit*` — user-triggered, not enforced) | CI-enforced (gate runs at commit/PR time) | None formal — personal-discipline tool, no gate | On-demand (`/nlpm:score` etc. — user-triggered) |
| Delegation breadth | 8-way: Claude↔Codex↔Antigravity↔Grok↔Qwen↔opencode↔Kimi, with circular-delegation guards | None — single-agent skill routing only | None — agent-scripts syncs skills across machines, doesn't route tasks between agents | None — it scores/audits, doesn't delegate |
| Dependency complexity | High — needs every bridged CLI binary installed + authenticated; `claude-octopus` fetched via `npx` at runtime; multiple MCP registrations | Low — skill files + a handful of scripts, no external CLI dependency | agent-scripts: low (shell scripts); CodexBar: medium (embeds a QuickJS runtime, but scoped to its own app) | Low–medium — stdlib-based; `bin/nlpm-check` is a standalone cross-tool validator |

## Each project, in one paragraph

**cc-suite** exists because each coding CLI reads its own instruction file and none of them can natively ask another one for help. It fixes that with a shared `AGENTS.md`, mirrored hooks/MCP config, and named delegation lanes (`/cc-suite:audit`, `/cc-suite:grok`, `/cc-suite:qwen-review`, etc.) in both directions. Its unit of value is the *round trip between tools*, not the quality of any single tool's output.

**addyosmani/agent-skills** stays inside one ecosystem (Claude Code) and instead goes deep on one thing: mapping the full SDLC into 9 slash commands (`/spec /plan /build /test /review /ship`, plus `/constraints /webperf /code-simplify`) with CI-enforced gates. It doesn't talk to other CLIs at all — that's out of scope by design.

**steipete/agent-scripts + CodexBar** are personal infrastructure, not a shipped framework. `agent-scripts` solves one narrow problem — Claude Code and Codex CLI discover skills differently (nested-dir scan vs. one-level-only), so a symlink-sync script keeps them consistent across machines. `CodexBar` is a separate macOS menu-bar app for watching usage/quota across 69+ providers, built around an embedded QuickJS runtime so third-party providers can be added without recompiling the Swift host.

**nlpm** (cc-suite's sibling project, same author as the marketplace cc-suite ships through) is a scoring and rule system: 50 rules, a 100-point rubric, per-tool convention overlays (Claude/Codex/Antigravity). It never delegates tasks — it grades artifacts that already exist.

## How to choose

- Working inside Claude Code only, want full-SDLC quality gates enforced automatically → **addyosmani/agent-skills**.
- Multiple machines/projects, want skill discovery to stay consistent, or want a local usage/quota dashboard → **steipete's two projects**.
- Want a standardized scoring/audit pass over skills, agents, rules, commands — not concerned with cross-tool delegation → **nlpm**.
- Need to actually hand work back and forth between different AI CLIs (ask Codex to implement what Claude planned, have Grok review what Codex wrote) → **cc-suite**. None of the other three do this; it's not a matter of picking the "best" one, it's a different job.

## Can they be combined?

Yes, and cheaply. cc-suite's shared-skills bridge (`.agents/skills → .claude/skills` symlink) is content-agnostic — it will happily carry an addyosmani-style skill pack or an nlpm-scored skill set into every bridged CLI's view. A reasonable stack: cc-suite for the cross-tool plumbing, nlpm for grading what's in `.claude/skills/`, and an addyosmani-style command set (`/spec /plan /build /ship`) as the actual skill content living inside that shared tree. Nothing about cc-suite's design excludes running alongside the other three; it only conflicts with itself if you also try to build a second, competing delegation bridge.

## Where cc-suite is weaker (stated plainly, not buried)

1. **No CI-enforced quality gate.** Every `/cc-suite:audit*` command is user-triggered. Unlike agent-skills, nothing stops a commit from landing without review — cc-suite has no pre-commit or CI hook of its own that blocks bad work.
2. **No runtime hot-plug extension model.** Adding a new bridged tool or delegation lane means adding new command/script files and reinstalling the plugin — there's no embedded scripting runtime like CodexBar's QuickJS layer that lets a third party extend it without touching the host code.
3. **Highest dependency surface of the four.** Delegation breadth is cc-suite's whole point, and it's also its cost: every bridged CLI must be installed and authenticated, and a preflight failure on any one of them blocks that lane. addyosmani and nlpm have near-zero external dependencies by comparison; steipete's agent-scripts is a handful of shell scripts.
4. **Exposed to upstream CLI breakage.** Because cc-suite drives other vendors' CLIs directly, a behavior change in any of them (e.g. this session's finding that Qwen Code 0.21.0–0.21.2 silently ignores `--core-tools` in Safe Mode) becomes cc-suite's problem to work around. Single-ecosystem tools like agent-skills don't carry this risk.

---
*Sources: this session's methodology distillations at `knowledge-base/03 - RESOURCES/creator-repos/agent-skills-addyosmani-methodology/` and `knowledge-base/03 - RESOURCES/creator-repos/steipete-methodology/`, plus cc-suite's own README.md. nlpm details are from the xiaolai marketplace listing read earlier in the same session — not independently re-verified against nlpm's source for this document.*
