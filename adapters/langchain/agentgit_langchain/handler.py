import hashlib
import json
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from langchain_core.agents import AgentAction, AgentFinish
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentGitCallbackHandler(BaseCallbackHandler):
    """Records LangChain agent runs as content-addressed commits in an AgentGit repo."""

    def __init__(self, repo_path: str) -> None:
        super().__init__()
        self.repo_path = os.path.abspath(repo_path)
        self.agentgit_dir = os.path.join(self.repo_path, ".agentgit")
        self._session_id: Optional[str] = None
        self._session_head: Optional[str] = None
        self._pending_tool: Optional[Dict[str, Any]] = None
        self._pending_llm: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_init(self) -> None:
        if os.path.isdir(self.agentgit_dir):
            return
        result = subprocess.run(
            ["agentgit", "init", self.repo_path],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"agentgit init failed: {result.stderr.strip()}")

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
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)

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
        conn = self._db()
        try:
            conn.execute(
                "INSERT INTO sessions (id, name, status, head, created_at, updated_at, metadata)"
                " VALUES (?,?,?,?,?,?,?)",
                (session_id, f"session-{session_id[:8]}", "active", None, now, now, "{}"),
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

    # ------------------------------------------------------------------
    # LangChain callbacks
    # ------------------------------------------------------------------

    def on_agent_action(self, action: AgentAction, **kwargs: Any) -> None:
        self._ensure_session()

    def on_agent_finish(self, finish: AgentFinish, **kwargs: Any) -> None:
        if self._session_id is None:
            return
        session_id, self._session_id, self._session_head = self._session_id, None, None
        conn = self._db()
        try:
            conn.execute(
                "UPDATE sessions SET status=?, updated_at=? WHERE id=?",
                ("completed", _now_ms(), session_id),
            )
            conn.commit()
        finally:
            conn.close()

    def on_tool_start(
        self, serialized: Dict[str, Any], input_str: str, **kwargs: Any
    ) -> None:
        self._pending_tool = {
            "id": str(uuid.uuid4()),
            "name": serialized.get("name", "unknown"),
            "input": {"input": input_str},
            "output": None,
            "startedAt": _now_ms(),
            "finishedAt": None,
            "status": "pending",
            "error": None,
        }

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        pending, self._pending_tool = self._pending_tool, None
        if pending is None:
            return
        self._ensure_session()
        output_str = output if isinstance(output, str) else str(output)
        tool_call = {
            **pending,
            "output": output_str,
            "finishedAt": _now_ms(),
            "status": "success",
        }
        self._record_commit(message=f'tool: {tool_call["name"]}', tool_call=tool_call)

    def on_tool_error(
        self, error: Union[Exception, KeyboardInterrupt], **kwargs: Any
    ) -> None:
        pending, self._pending_tool = self._pending_tool, None
        if pending is None:
            return
        self._ensure_session()
        tool_call = {
            **pending,
            "output": None,
            "finishedAt": _now_ms(),
            "status": "error",
            "error": str(error),
        }
        self._record_commit(
            message=f'tool error: {tool_call["name"]}', tool_call=tool_call
        )

    def on_llm_start(
        self, serialized: Dict[str, Any], prompts: List[str], **kwargs: Any
    ) -> None:
        self._pending_llm = {
            "serialized": serialized,
            "prompts": prompts,
            "startedAt": _now_ms(),
        }

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        pending, self._pending_llm = self._pending_llm, None
        if pending is None:
            return
        self._ensure_session()
        outputs = [
            gen.text if hasattr(gen, "text") else str(gen)
            for gen_list in response.generations
            for gen in gen_list
        ]
        self._record_commit(
            message="llm: response",
            metadata={
                "prompts": pending["prompts"],
                "outputs": outputs,
                "llmOutput": response.llm_output,
                "startedAt": pending["startedAt"],
                "finishedAt": _now_ms(),
            },
        )
