"""Python port of TS `SnapshotGuard`.

Snapshots the prior content of a file before a write tool call so the
pre-mutation state is captured in the audit trail. Skips files that don't
exist yet (nothing to snapshot) and files exceeding `max_blob_bytes` when set.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Dict, List, Optional, Sequence


DEFAULT_WRITE_TOOLS: List[str] = [
    "writeFile",
    "write_file",
    "editFile",
    "edit_file",
    "createFile",
    "create_file",
]


# (file_path) -> Optional[str]   None if missing.
ReadFileFn = Callable[[str], Optional[str]]
# (content) -> hash. Lets us write the blob through the adapter's own
# object store without taking a hard dependency on it here.
WriteBlobFn = Callable[[str], str]


def _default_read_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (FileNotFoundError, IsADirectoryError, OSError):
        return None


def _extract_file_path(input_dict: Dict[str, Any]) -> Optional[str]:
    for key in ("path", "filePath", "file_path", "filename"):
        v = input_dict.get(key)
        if isinstance(v, str):
            return v
    return None


class SnapshotGuard:
    name = "SnapshotGuard"

    def __init__(
        self,
        write_blob: WriteBlobFn,
        write_tools: Optional[Sequence[str]] = None,
        max_blob_bytes: Optional[int] = None,
        read_file_fn: Optional[ReadFileFn] = None,
    ) -> None:
        self._write_blob = write_blob
        self._write_tools = set(
            write_tools if write_tools is not None else DEFAULT_WRITE_TOOLS
        )
        self._max_blob_bytes = max_blob_bytes
        self._read_file = read_file_fn or _default_read_file

    def check(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        name = tool_call.get("name", "")
        if name not in self._write_tools:
            return {"outcome": "allow"}

        input_dict = tool_call.get("input") or {}
        file_path = _extract_file_path(input_dict)
        if not file_path:
            return {"outcome": "allow"}

        content = self._read_file(file_path)
        if content is None:
            return {"outcome": "allow"}

        size = len(content.encode("utf-8"))
        if self._max_blob_bytes is not None and size > self._max_blob_bytes:
            return {"outcome": "allow"}

        snapshot_hash = self._write_blob(content)
        return {"outcome": "allow", "snapshot_hash": snapshot_hash}
