"""Python port of TS `ConfirmationGuard`.

Blocks destructive tool calls unless the user confirms (or a config-driven
allowlist/autoConfirm pattern matches). The denylist hard-blocks regardless
of user input. Pattern matching looks at the tool name AND any string-valued
field in `tool_call["input"]` so a denylist entry like `"rm -rf"` blocks a
`bash` call with `args: ["rm -rf /tmp/x"]`.
"""

from __future__ import annotations

import sys
from typing import Any, Callable, Dict, List, Optional, Sequence


DEFAULT_DESTRUCTIVE_TOOLS: List[str] = [
    "deleteFile",
    "delete_file",
    "removeFile",
    "remove_file",
    "rm",
    "shell",
    "bash",
    "Bash",
    "execute_bash",
    "run_bash",
    "run_command",
    "exec",
]


PromptFn = Callable[[str], str]


def _default_prompt(message: str) -> str:
    """In non-interactive environments, block by default rather than hang."""
    if not sys.stdin.isatty():
        return "n"
    try:
        return input(message)
    except EOFError:
        return "n"


def _string_contains_any(value: Any, patterns: Sequence[str]) -> bool:
    if isinstance(value, str):
        return any(p in value for p in patterns)
    if isinstance(value, (list, tuple)):
        return any(_string_contains_any(v, patterns) for v in value)
    return False


def _matches_any(tool_call: Dict[str, Any], patterns: Sequence[str]) -> bool:
    if not patterns:
        return False
    if tool_call.get("name") in patterns:
        return True
    for v in (tool_call.get("input") or {}).values():
        if _string_contains_any(v, patterns):
            return True
    return False


class ConfirmationGuard:
    name = "ConfirmationGuard"

    def __init__(
        self,
        destructive_tools: Optional[Sequence[str]] = None,
        allowlist: Optional[Sequence[str]] = None,
        denylist: Optional[Sequence[str]] = None,
        auto_confirm: Optional[Sequence[str]] = None,
        prompt_fn: Optional[PromptFn] = None,
    ) -> None:
        self._destructive = set(
            destructive_tools if destructive_tools is not None else DEFAULT_DESTRUCTIVE_TOOLS
        )
        self._allowlist = list(allowlist or [])
        self._denylist = list(denylist or [])
        self._auto_confirm = list(auto_confirm or [])
        self._prompt = prompt_fn or _default_prompt

    def check(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        name = tool_call.get("name", "")

        if _matches_any(tool_call, self._denylist):
            return {
                "outcome": "block",
                "reason": f"Tool call '{name}' matched denylist",
            }

        if _matches_any(tool_call, self._allowlist):
            return {"outcome": "allow"}

        if name not in self._destructive:
            return {"outcome": "allow"}

        if _matches_any(tool_call, self._auto_confirm):
            return {"outcome": "allow"}

        answer = self._prompt(
            f'Guard: "{name}" is a destructive tool call. Proceed? [y/N] '
        )
        if answer.strip().lower() == "y":
            return {"outcome": "allow"}

        return {
            "outcome": "block",
            "reason": f"User did not confirm destructive tool call: {name}",
        }
