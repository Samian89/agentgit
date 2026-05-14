import hashlib
import json
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Union

from agentgit_adapter.guards import GuardRegistry, build_default_guards
from agentgit_adapter.migrations import run_migrations


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentWrapper:
    """Wraps any Python agent to record tool calls as AgentGit commits."""

    def __init__(
        self,
        agent: Any,
        repo_path: str,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> None:
        """Wrap a Python agent to record tool calls as AgentGit commits.

        ``guards`` mirrors the TS `wrapAgentJS(agent, { guards })` semantics:
          - ``None`` (default): apply `ConfirmationGuard` + `SnapshotGuard`,
            configured from `.agentgit/config.json` if present.
          - ``False``: explicit opt-out — no guards run.
          - ``Sequence``: full override — exactly these guards run.
        """
        self._agent = agent
        self.repo_path = os.path.abspath(repo_path)
        self.agentgit_dir = os.path.join(self.repo_path, ".agentgit")
        self._session_id: Optional[str] = None
        self._session_head: Optional[str] = None
        self._guards_option = guards
        self._guard_registry: Optional[GuardRegistry] = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        existed = os.path.isdir(self.agentgit_dir)
        if not existed:
            # Try CLI first; fall back to direct initialization if unavailable.
            try:
                subprocess.run(
                    ["agentgit", "init", self.repo_path],
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError:
                pass
            objects_dir = os.path.join(self.agentgit_dir, "objects")
            refs_dir = os.path.join(self.agentgit_dir, "refs")
            os.makedirs(objects_dir, exist_ok=True)
            os.makedirs(refs_dir, exist_ok=True)
            head_file = os.path.join(self.agentgit_dir, "HEAD")
            if not os.path.exists(head_file):
                with open(head_file, "w", encoding="utf-8") as fh:
                    fh.write("ref: refs/sessions/main")
        # Apply migrations regardless of whether the CLI or a previous call
        # already initialised the directory — run_migrations is idempotent and
        # also upgrades legacy v0.1 fixtures to the current target version.
        conn = sqlite3.connect(os.path.join(self.agentgit_dir, "index.db"))
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            run_migrations(conn)
        finally:
            conn.close()

    def _db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(os.path.join(self.agentgit_dir, "index.db"))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _write_object(self, hash_hex: str, content: str) -> None:
        prefix, suffix = hash_hex[:2], hash_hex[2:]
        obj_dir = os.path.join(self.agentgit_dir, "objects", prefix)
        os.makedirs(obj_dir, exist_ok=True)
        path = os.path.join(obj_dir, suffix)
        if not os.path.exists(path):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(content)

    def _hash_and_write(self, obj: Dict[str, Any]) -> str:
        content = _canonical_json(obj)
        h = _sha256(content)
        self._write_object(h, content)
        return h

    def _empty_tree_hash(self) -> str:
        return self._hash_and_write({"entries": [], "type": "tree"})

    def _open_session(self) -> None:
        session_id = str(uuid.uuid4())
        now = _now_ms()
        agent_name = getattr(self._agent, "name", type(self._agent).__name__)
        conn = self._db()
        try:
            conn.execute(
                "INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata)"
                " VALUES (?,?,?,?,?,?,?)",
                (session_id, f"{agent_name}-{session_id[:8]}", "active", None, now, now, "{}"),
            )
            conn.commit()
        finally:
            conn.close()
        self._session_id = session_id
        self._session_head = None

    def _ensure_session(self) -> None:
        if self._session_id is None:
            self._ensure_init()
            self._open_session()
        self._ensure_guard_registry()

    def _ensure_guard_registry(self) -> None:
        """Resolve the guard chain.

        Defers loading config-derived defaults until after `.agentgit/` exists
        (i.e. inside `_ensure_init`) so the JSON file is read from its final
        location, not from a phantom path during construction.
        """
        if self._guard_registry is not None:
            return

        opt = self._guards_option
        if opt is False:
            self._guard_registry = GuardRegistry([])
            return
        if isinstance(opt, (list, tuple)):
            self._guard_registry = GuardRegistry(list(opt))
            return

        config_path = os.path.join(self.agentgit_dir, "config.json")
        config: Dict[str, Any] = {}
        if os.path.isfile(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f) or {}
            except (json.JSONDecodeError, OSError):
                config = {}

        # write_blob: persist a snapshot blob through the adapter's own
        # `_hash_and_write` so the file lands in `.agentgit/objects/<xx>/<...>`.
        def write_blob(content: str) -> str:
            size = len(content.encode("utf-8"))
            return self._hash_and_write(
                {
                    "content": content,
                    "encoding": "utf-8",
                    "mimeType": None,
                    "size": size,
                    "type": "blob",
                }
            )

        self._guard_registry = GuardRegistry(
            build_default_guards(config, write_blob=write_blob)
        )

    def _record_commit(
        self,
        message: str,
        tool_call: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        tree_hash = self._empty_tree_hash()
        now = _now_ms()
        # The canonical commit body must match exactly what the TypeScript
        # core writes (see packages/core/src/repository.ts) so that a TS
        # verify on the same hash produces the same digest. The `author`
        # field is part of the hashed body even when null; omitting it here
        # would cause TS verify to report "tampered" on Python-written commits.
        commit_obj = {
            "author": None,
            "message": message,
            "metadata": metadata or {},
            "parent": self._session_head,
            "sessionId": self._session_id,
            "timestamp": now,
            "toolCall": tool_call,
            "tree": tree_hash,
            "type": "commit",
        }
        commit_hash = self._hash_and_write(commit_obj)

        conn = self._db()
        try:
            # Insert into the full v2 schema: include author_name, author_email,
            # signature, public_key columns explicitly so the row is canonical
            # and round-trips identically through TS Repository.verifyCommit.
            conn.execute(
                "INSERT OR IGNORE INTO commits"
                " (hash, tree, parent, session_id, timestamp, message, tool_call, metadata,"
                "  author_name, author_email, signature, public_key)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    commit_hash,
                    tree_hash,
                    self._session_head,
                    self._session_id,
                    now,
                    message,
                    json.dumps(tool_call) if tool_call is not None else None,
                    json.dumps(metadata or {}),
                    None,  # author_name
                    None,  # author_email
                    None,  # signature
                    None,  # public_key
                ),
            )
            conn.execute(
                "UPDATE sessions SET head=?, updated_at=? WHERE id=?",
                (commit_hash, now, self._session_id),
            )
            conn.commit()
        finally:
            conn.close()

        self._session_head = commit_hash
        return commit_hash

    @staticmethod
    def _serialize_value(value: Any) -> Any:
        """Recursively convert a value to JSON-safe primitives."""
        if isinstance(value, (str, int, float, bool, type(None))):
            return value
        if isinstance(value, (list, tuple)):
            return [AgentWrapper._serialize_value(v) for v in value]
        if isinstance(value, dict):
            return {str(k): AgentWrapper._serialize_value(v) for k, v in value.items()}
        return str(value)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        """Invoke the wrapped agent and record the call as an AgentGit commit."""
        self._ensure_session()
        name = getattr(self._agent, "name", type(self._agent).__name__)
        tool_call_id = str(uuid.uuid4())
        started_at = _now_ms()

        input_data: Dict[str, Any] = {}
        if args:
            input_data["args"] = self._serialize_value(list(args))
        for k, v in kwargs.items():
            input_data[k] = self._serialize_value(v)

        # Guard chain: a blocking guard prevents the underlying agent from
        # being invoked at all and surfaces as a Python exception, matching
        # the TS `Tool call '...' blocked by guard: ...` error shape.
        assert self._guard_registry is not None
        pending_tool_call: Dict[str, Any] = {
            "id": tool_call_id,
            "name": name,
            "input": input_data,
            "output": None,
            "startedAt": started_at,
            "completedAt": None,
            "status": "pending",
            "error": None,
        }
        guard_result = self._guard_registry.run(pending_tool_call)
        if guard_result.get("outcome") == "block":
            reason = guard_result.get("reason") or "no reason given"
            raise RuntimeError(
                f"Tool call '{name}' blocked by guard: {reason}"
            )
        snapshot_hash = guard_result.get("snapshot_hash")
        metadata: Optional[Dict[str, Any]] = (
            {"snapshotHash": snapshot_hash} if snapshot_hash is not None else None
        )

        try:
            result = self._agent(*args, **kwargs)
            tool_call: Dict[str, Any] = {
                "completedAt": _now_ms(),
                "error": None,
                "id": tool_call_id,
                "input": input_data,
                "name": name,
                "output": self._serialize_value(result),
                "startedAt": started_at,
                "status": "success",
            }
            self._record_commit(
                message=f"tool: {name}", tool_call=tool_call, metadata=metadata
            )
            return result
        except Exception as exc:
            tool_call = {
                "completedAt": _now_ms(),
                "error": str(exc),
                "id": tool_call_id,
                "input": input_data,
                "name": name,
                "output": None,
                "startedAt": started_at,
                "status": "error",
            }
            self._record_commit(
                message=f"tool error: {name}", tool_call=tool_call, metadata=metadata
            )
            raise

    def finish(self, status: str = "completed") -> None:
        """Mark the current session as completed, failed, or abandoned."""
        if self._session_id is None:
            return
        session_id, self._session_id, self._session_head = (
            self._session_id,
            None,
            None,
        )
        conn = self._db()
        try:
            conn.execute(
                "UPDATE sessions SET status=?, updated_at=? WHERE id=?",
                (status, _now_ms(), session_id),
            )
            conn.commit()
        finally:
            conn.close()

    def __enter__(self) -> "AgentWrapper":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.finish("failed" if exc_type is not None else "completed")


def wrap_agent(
    agent: Any,
    repo_path: str,
    guards: Union[Sequence[Any], bool, None] = None,
) -> AgentWrapper:
    """Wrap any Python agent to record tool calls as AgentGit commits.

    Args:
        agent: Any Python object with a __call__ method.
        repo_path: Path to the AgentGit repository root.
        guards: ``None`` (default) → ConfirmationGuard + SnapshotGuard;
                ``False`` → no guards; sequence → exactly those guards.

    Returns:
        AgentWrapper that records a commit on each __call__.
    """
    return AgentWrapper(agent, repo_path, guards=guards)
