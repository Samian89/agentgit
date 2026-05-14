"""Python ports of the AgentGit default guards.

Mirrors the semantics of `packages/core/src/guards/*` so a Python-wrapped
agent behaves the same way as a TS-wrapped one.
"""

from .confirmation_guard import ConfirmationGuard, DEFAULT_DESTRUCTIVE_TOOLS
from .registry import GuardRegistry
from .snapshot_guard import SnapshotGuard, DEFAULT_WRITE_TOOLS
from .loader import build_default_guards, load_guards_from_file

__all__ = [
    "ConfirmationGuard",
    "DEFAULT_DESTRUCTIVE_TOOLS",
    "DEFAULT_WRITE_TOOLS",
    "GuardRegistry",
    "SnapshotGuard",
    "build_default_guards",
    "load_guards_from_file",
]
