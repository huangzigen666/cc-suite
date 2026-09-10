# Secrets handling

> Convention doc for anyone adding a new preflight/runner script to cc-suite. Not enforced by a script yet — read this before you add code that touches credentials.

## Audit that prompted this (2026-09-10)

Grepped every `scripts/*preflight*.sh` and `scripts/*runner*.mjs` for patterns that could log a raw credential. Found none: the matches that came up were all status-string checks (`echo "$LOGIN_STATUS" | grep -qi "not logged in"`) or boolean env-var presence checks (`process.env.XAI_API_KEY && ...`) — never the credential value itself being printed. No fix needed; this doc exists so the next script written here holds the same line deliberately instead of by accident.

## The rule (borrowed from steipete/agent-scripts' `qa-test` skill)

1. **Never print a credential value.** Not to stdout, not to a log file, not in an error message. If a check needs to report "is this set", report presence (boolean) or a masked form (`sk-...ab12`), never the raw string.
2. **Prefer a credential manager over an env var when the flow allows it.** cc-suite's existing pattern (`process.env.XAI_API_KEY && ids.includes(...)`) is fine for a presence check; don't extend it into a pattern that reads the value further than necessary to pass it to the tool that needs it.
3. **External credential flows get flagged, not silently trusted.** If a script needs to shell out to something that reads browser cookies, a service-account file, or any credential store outside cc-suite's own env — mark that code path clearly (comment or log line) as `prompt-risky` so a reviewing agent or human knows this step handles material that shouldn't be echoed back into a transcript.
4. **`.mcp.json` / `.codex/config.toml` mirroring already follows this** — cc-suite's own README states env-var values and remote headers are never written into a mirrored config; the vars that need setting are reported by name only. New bridge code should hold the same line.

## When writing a new preflight or runner script

- Grep your own diff for `console.log`, `echo`, `print(` anywhere near a variable with `token`/`key`/`secret`/`password`/`credential`/`auth` in its name before committing.
- If the check only needs to know "is this configured", write it as a boolean, not a value dump.
- If a failure path needs to help the user debug, name *which* variable/file is missing — never its contents.
