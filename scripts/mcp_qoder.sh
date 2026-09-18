#!/usr/bin/env bash
# cc-suite: register the pinned claude-code (claude-octopus) MCP server
# directly in .mcp.json, so a delegated Qoder session can call back into
# Claude the same way Codex, agy, and Grok can.
#
# Qoder's project-scope MCP config *is* .mcp.json itself (confirmed 2026-09-18
# against qodercli 1.1.17: `qoder mcp add --scope project` writes straight into
# it, and `qoder mcp get` reports the resulting entry "Connected" with no
# separate approval/trust gate the way Grok's folder-trust required) — unlike
# agy (.agents/mcp_config.json) and Grok (.grok/config.toml), there is no
# separate target file to mirror into.
#
# Writing the reservation into .mcp.json itself means Claude Code's own
# project MCP listing for this repo will also show a self-referential
# "claude-code" entry. That is a deliberate, accepted tradeoff (harmless,
# never invoked by Claude Code itself) rather than an oversight — see the
# commit that added this script.
#
# Reuses claude_code_server() / apply_delegation_reservation() from
# bridge_agy_mcp.py rather than re-deriving the pin/conflict logic a third
# time (bridge_tools.py's grok emitter already has its own copy for the
# mirror-outward case; this is the mirror-inward case).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$SCRIPT_DIR" <<'PY'
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from bridge_agy_mcp import (  # noqa: E402
    DELEGATION_SERVER,
    ReservedNameConflict,
    apply_delegation_reservation,
)
from pin import PinError  # noqa: E402

p = Path(".mcp.json")


def commit(data, create):
    """Same exclusive-create / atomic-replace scheme as mcp_codex.sh, so a
    0600 file holding other servers' credentials is never widened and a
    concurrent creator is never clobbered."""
    fd, tmp_name = tempfile.mkstemp(dir=str(p.parent), prefix=f".{p.name}.", suffix=".tmp")
    try:
        if create:
            mask = os.umask(0)
            os.umask(mask)
            os.fchmod(fd, 0o666 & ~mask)
        else:
            os.fchmod(fd, p.stat().st_mode & 0o7777)
        with os.fdopen(fd, "w", encoding="utf-8") as tmp_file:
            tmp_file.write(json.dumps(data, indent=2) + "\n")
        if create:
            os.link(tmp_name, p)
        else:
            os.replace(tmp_name, p)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    if create:
        os.unlink(tmp_name)


try:
    if not p.exists():
        servers = {}
        apply_delegation_reservation(servers)
        commit({"mcpServers": servers}, create=True)
        print(f"✓ .mcp.json created with {DELEGATION_SERVER} MCP server")
        sys.exit(0)

    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("! .mcp.json is not valid JSON — leaving alone", file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict):
        print(f"! .mcp.json top level must be an object (got {type(data).__name__})", file=sys.stderr)
        sys.exit(2)

    servers = data.get("mcpServers")
    if servers is None:
        data["mcpServers"] = servers = {}
    elif not isinstance(servers, dict):
        print(f"! .mcp.json mcpServers must be an object (got {type(servers).__name__})", file=sys.stderr)
        sys.exit(2)

    before = servers.get(DELEGATION_SERVER)
    apply_delegation_reservation(servers)
    if servers.get(DELEGATION_SERVER) == before:
        print(f"· .mcp.json already registers {DELEGATION_SERVER} (pinned)")
        sys.exit(0)

    verb = "updated" if before is not None else "added"
    commit(data, create=False)
    print(f"✓ .mcp.json: {DELEGATION_SERVER} MCP server {verb}")
except ReservedNameConflict as exc:
    print(f"! {exc}", file=sys.stderr)
    sys.exit(2)
except PinError as exc:
    print(f"! {exc}", file=sys.stderr)
    sys.exit(2)
except FileExistsError:
    print("! .mcp.json appeared while creating it — re-run to merge the claude-code entry", file=sys.stderr)
    sys.exit(1)
PY
