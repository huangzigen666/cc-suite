"""One local stdio adapter for all cc-suite-managed Claude MCP registrations."""
from pathlib import Path

PROXY = Path(__file__).resolve().parent.parent / "claude-mcp-bridge.mjs"


def claude_transport(pin):
    return {"command": "node", "args": [str(PROXY), "--", "npx", "-y", f"claude-octopus@{pin}"]}


def is_claude_transport(config):
    if not isinstance(config, dict) or config.get("type", "stdio") != "stdio":
        return False
    args = config.get("args")
    if not isinstance(args, list):
        return False
    if config.get("command") == "node":
        if len(args) != 5 or args[1:4] != ["--", "npx", "-y"]:
            return False
        allowed = {PROXY.resolve(), (Path.home() / "Developer/cc-suite/scripts/claude-mcp-bridge.mjs").resolve()}
        if not isinstance(args[0], str) or Path(args[0]).resolve() not in allowed:
            return False
        args = args[3:]
    elif config.get("command") != "npx":
        return False
    return any(isinstance(a, str) and (a == "claude-octopus" or a.startswith("claude-octopus@")) for a in args)
