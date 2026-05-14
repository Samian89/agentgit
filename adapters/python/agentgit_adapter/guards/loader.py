"""Build the default guard chain from `.agentgit/config.json`.

Mirrors `buildDefaultGuards` in `packages/core/src/guards/load-guards.ts`:
honors the `guards.enabled`, `guards.confirmation.*`, and `guards.snapshot.*`
keys; everything else is left at the TS defaults.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional

from .confirmation_guard import ConfirmationGuard
from .snapshot_guard import SnapshotGuard, WriteBlobFn


def _load_config_dict(agentgit_dir: str) -> Dict[str, Any]:
    path = os.path.join(agentgit_dir, "config.json")
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def build_default_guards(
    config: Optional[Dict[str, Any]],
    write_blob: Optional[WriteBlobFn] = None,
) -> List[Any]:
    """Build [ConfirmationGuard, SnapshotGuard] honoring `config.guards`.

    SnapshotGuard is omitted when `write_blob` is None (we have no way to
    persist a snapshot blob otherwise).
    """
    g = (config or {}).get("guards") or {}
    if g.get("enabled") is False:
        return []

    guards: List[Any] = []

    confirm = g.get("confirmation") or {}
    if confirm.get("enabled") is not False:
        guards.append(
            ConfirmationGuard(
                destructive_tools=confirm.get("destructiveTools"),
                allowlist=confirm.get("allowlist"),
                denylist=confirm.get("denylist"),
                auto_confirm=confirm.get("autoConfirm"),
            )
        )

    snapshot = g.get("snapshot") or {}
    if snapshot.get("enabled") is not False and write_blob is not None:
        guards.append(
            SnapshotGuard(
                write_blob=write_blob,
                write_tools=snapshot.get("writeTools"),
                max_blob_bytes=snapshot.get("maxBlobBytes"),
            )
        )

    return guards


def load_guards_from_file(
    agentgit_dir: str,
    write_blob: Optional[WriteBlobFn] = None,
) -> List[Any]:
    """Read `.agentgit/config.json` and return the default guard chain."""
    return build_default_guards(_load_config_dict(agentgit_dir), write_blob)
