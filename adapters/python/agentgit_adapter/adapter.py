import hashlib
import json
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,
    tree        TEXT    NOT NULL,
    parent      TEXT,
    session_id  TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    tool_call   TEXT,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime_type   TEXT,
    encoding    TEXT    NOT NULL DEFAULT 'utf-8'
);

CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,
    target      TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'branch',
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    blob_hash   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);
"""


class AgentWrapper:
    """Wraps any Python agent to record tool calls as AgentGit commits."""

    def __init__(self, agent: Any, repo_path: str) -> None:
        self._agent = agent
        self.repo_path = os.path.abspath(repo_path)
        self.agentgit_dir = os.path.join(self.repo_path, ".agentgit")
        self._session_id: Optional[str] = None
        self._session_head: Optional[str] = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        if os.path.isdir(self.agentgit_dir):
            return
        # Try CLI first; fall back to direct initialization if unavailable.
        try:
            result = subprocess.run(
                ["agentgit", "init", self.repo_path],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                return
        except FileNotFoundError:
            pass
        objects_dir = os.path.join(self.agentgit_dir, "objects")
        refs_dir = os.path.join(self.agentgit_dir, "refs")
        os.makedirs(objects_dir, exist_ok=True)
        os.makedirs(refs_dir, exist_ok=True)
        with open(os.path.join(self.agentgit_dir, "HEAD"), "w", encoding="utf-8") as fh:
            fh.write("ref: refs/sessions/main")
        conn = sqlite3.connect(os.path.join(self.agentgit_dir, "index.db"))
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA_DDL)
        finally:
            conn.close()

    def _db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(os.path.join(self.agentgit_dir, "index.db"))
        conn.execute("PRAGMA journal_mode=WAL")
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

    def _record_commit(
        self,
        message: str,
        tool_call: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        tree_hash = self._empty_tree_hash()
        now = _now_ms()
        commit_obj = {
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
            conn.execute(
                "INSERT OR IGNORE INTO commits"
                " (hash, tree, parent, session_id, timestamp, message, tool_call, metadata)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (
                    commit_hash,
                    tree_hash,
                    self._session_head,
                    self._session_id,
                    now,
                    message,
                    json.dumps(tool_call) if tool_call is not None else None,
                    json.dumps(metadata or {}),
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
            self._record_commit(message=f"tool: {name}", tool_call=tool_call)
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
            self._record_commit(message=f"tool error: {name}", tool_call=tool_call)
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


def wrap_agent(agent: Any, repo_path: str) -> AgentWrapper:
    """Wrap any Python agent to record tool calls as AgentGit commits.

    Args:
        agent: Any Python object with a __call__ method.
        repo_path: Path to the AgentGit repository root.

    Returns:
        AgentWrapper that records a commit on each __call__.
    """
    return AgentWrapper(agent, repo_path)
