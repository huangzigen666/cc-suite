#!/usr/bin/env python3
"""Probe whether the installed Codex CLI exposes a stdio MCP server.

The direct Claude -> Codex MCP registration is optional.  Codex CLI releases
can change their subcommand surface, so a syntactically valid registration is
not enough: the child must answer an MCP ``initialize`` request before we
advertise it to Claude.

Exit status is zero only when a valid MCP initialize response is observed.
The JSON result is intentionally small so shell scripts, diagnose.py, and
future release checks share one runtime compatibility check.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from typing import Any


TIMEOUT_SECONDS = 5
COMMAND = ("codex", "mcp-server")
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "cc-suite-codex-mcp-probe", "version": "1"},
    },
}


def _version(binary: str) -> str | None:
    try:
        result = subprocess.run(
            [binary, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (result.stdout or result.stderr).strip().splitlines()
    return text[0] if text else None


def _looks_like_unsupported(output: str) -> bool:
    lowered = output.lower()
    return any(
        marker in lowered
        for marker in (
            "stdin is not a terminal",
            "unrecognized subcommand",
            "unknown command",
            "found argument 'mcp-server'",
            "usage: codex mcp",
        )
    )


def _probe(binary: str) -> dict[str, Any]:
    version = _version(binary)
    try:
        child = subprocess.Popen(
            [binary, *COMMAND[1:]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ.copy(),
            start_new_session=True,
        )
        request = json.dumps(INITIALIZE, separators=(",", ":")) + "\n"
        stdout, stderr = child.communicate(request, timeout=TIMEOUT_SECONDS)
    except FileNotFoundError:
        return {
            "status": "missing",
            "reason": "codex binary is not on PATH",
            "version": version,
            "command": list(COMMAND),
        }
    except subprocess.TimeoutExpired as exc:
        child.kill()
        stdout, stderr = child.communicate()
        detail = ((stderr or "") + "\n" + (stdout or "")).strip()[-400:]
        return {
            "status": "failed",
            "reason": "codex mcp-server did not answer initialize within 5 seconds",
            "detail": detail,
            "version": version,
            "command": list(COMMAND),
        }
    except OSError as exc:
        return {
            "status": "failed",
            "reason": f"could not start codex mcp-server: {exc}",
            "version": version,
            "command": list(COMMAND),
        }

    for line in stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict) and isinstance(message.get("result"), dict):
            result = message["result"]
            if isinstance(result.get("capabilities"), dict):
                return {
                    "status": "healthy",
                    "reason": "codex mcp-server answered MCP initialize",
                    "version": version,
                    "command": list(COMMAND),
                }

    detail = ((stderr or "") + "\n" + (stdout or "")).strip()[-400:]
    unsupported = _looks_like_unsupported(detail)
    return {
        "status": "unsupported" if unsupported else "failed",
        "reason": (
            "installed codex CLI does not expose codex mcp-server"
            if unsupported
            else "codex mcp-server exited without a valid MCP initialize response"
        ),
        "detail": detail,
        "version": version,
        "command": list(COMMAND),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    binary = shutil.which("codex")
    result = (
        {
            "status": "missing",
            "reason": "codex binary is not on PATH",
            "version": None,
            "command": list(COMMAND),
        }
        if binary is None
        else _probe(binary)
    )
    if args.as_json:
        print(json.dumps(result, sort_keys=True))
    elif not args.quiet:
        print(f"{result['status']}: {result['reason']}")
        if result.get("detail"):
            print(result["detail"], file=sys.stderr)
    return 0 if result["status"] == "healthy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
