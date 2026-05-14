"""Run a chain of guards in registration order.

Stops at the first blocking guard. Snapshot hashes from passing guards
are surfaced on the final result (last one wins, mirroring TS).
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence


class GuardRegistry:
    def __init__(self, guards: Sequence[Any]) -> None:
        self._guards = list(guards)

    @property
    def size(self) -> int:
        return len(self._guards)

    def run(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        last_snapshot: Any = None
        for guard in self._guards:
            result = guard.check(tool_call)
            if "snapshot_hash" in result:
                last_snapshot = result["snapshot_hash"]
            if result.get("outcome") == "block":
                return result
        out: Dict[str, Any] = {"outcome": "allow"}
        if last_snapshot is not None:
            out["snapshot_hash"] = last_snapshot
        return out
