import hashlib
import json
import os
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Union

from langchain_core.agents import AgentAction, AgentFinish
from langchain_core.outputs import LLMResult

try:
    from langchain_core.callbacks import BaseCallbackHandler
except Exception:  # pragma: no cover - depends on installed LangChain extras
    class BaseCallbackHandler:  # type: ignore[no-redef]
        pass

_GUARD_IMPORT_ERROR: Optional[BaseException] = None

try:
    # Default guards come from the generic Python adapter so the LangChain
    # handler and the standalone AgentWrapper share one canonical implementation.
    from agentgit_adapter.guards import GuardRegistry, build_default_guards
except ImportError as exc:  # pragma: no cover - exercised by monkeypatch tests
    GuardRegistry = None  # type: ignore[assignment]
    build_default_guards = None  # type: ignore[assignment]
    _GUARD_IMPORT_ERROR = exc


class _NullRegistry:
    """No-op registry used for the explicit ``guards=False`` opt-out."""

    size = 0

    def run(self, _tool_call: Dict[str, Any]) -> Dict[str, Any]:
        return {"outcome": "allow"}


class _LocalRegistry:
    """Small guard runner used when callers pass an explicit guard array."""

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


class _FailClosedRegistry:
    """Blocks tool calls when the default guard implementation is unavailable."""

    size = 1

    def __init__(self, error: Optional[BaseException]) -> None:
        self._error = error

    def run(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        detail = f": {self._error}" if self._error is not None else ""
        return {
            "outcome": "block",
            "reason": (
                "default guard dependencies unavailable; install "
                f"agentgit-adapter to use safe defaults{detail}"
            ),
        }


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class AgentGitCallbackHandler(BaseCallbackHandler):
    """Records LangChain agent runs as content-addressed commits in an AgentGit repo."""

    def __init__(
        self,
        repo_path: str,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> None:
        """LangChain callback that records agent runs into an AgentGit repo.

        ``guards`` mirrors `wrapAgentJS({ guards })`:
          - ``None`` (default): apply ConfirmationGuard + SnapshotGuard,
            configured from ``.agentgit/config.json`` if present.
          - ``False``: no guards run.
          - ``Sequence``: full override.
        """
        super().__init__()
        self.repo_path = os.path.abspath(repo_path)
        self.agentgit_dir = os.path.join(self.repo_path, ".agentgit")
        self._session_id: Optional[str] = None
        self._session_head: Optional[str] = None
        self._pending_tool: Optional[Dict[str, Any]] = None
        self._pending_llm: Optional[Dict[str, Any]] = None
        self._guards_option = guards
        self._guard_registry: Optional[Any] = None

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
        conn.execute("PRAGMA foreign_keys=ON")
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
        self._ensure_guard_registry()

    def _ensure_guard_registry(self) -> None:
        if self._guard_registry is not None:
            return

        opt = self._guards_option
        if opt is False:
            if GuardRegistry is None:
                self._guard_registry = _NullRegistry()
            else:
                self._guard_registry = GuardRegistry([])
            return
        if isinstance(opt, (list, tuple)):
            registry_cls = GuardRegistry or _LocalRegistry
            self._guard_registry = registry_cls(list(opt))
            return

        if GuardRegistry is None or build_default_guards is None:
            self._guard_registry = _FailClosedRegistry(_GUARD_IMPORT_ERROR)
            return

        config_path = os.path.join(self.agentgit_dir, "config.json")
        config: Dict[str, Any] = {}
        if os.path.isfile(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f) or {}
            except (json.JSONDecodeError, OSError):
                config = {}

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

    @staticmethod
    def _parse_tool_input(input_str: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        # Newer LangChain versions pass structured inputs via the `inputs` kwarg.
        raw_inputs = kwargs.get("inputs")
        if isinstance(raw_inputs, dict):
            return raw_inputs
        # input_str is often a JSON-serialized object; try to recover the structure.
        try:
            parsed = json.loads(input_str)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
        return {"input": input_str}

    def on_tool_start(
        self, serialized: Dict[str, Any], input_str: str, **kwargs: Any
    ) -> None:
        # Resolving guards eagerly here (not lazily in on_tool_end) lets a
        # blocking guard raise before LangChain dispatches to the real tool.
        self._ensure_session()
        pending = {
            "id": str(uuid.uuid4()),
            "name": serialized.get("name", "unknown"),
            "input": self._parse_tool_input(input_str, kwargs),
            "output": None,
            "startedAt": _now_ms(),
            "completedAt": None,
            "status": "pending",
            "error": None,
        }

        assert self._guard_registry is not None
        guard_result = self._guard_registry.run(pending)
        if guard_result.get("outcome") == "block":
            reason = guard_result.get("reason") or "no reason given"
            self._pending_tool = None
            raise RuntimeError(
                f"Tool call '{pending['name']}' blocked by guard: {reason}"
            )
        snapshot_hash = guard_result.get("snapshot_hash")
        if snapshot_hash is not None:
            pending["_snapshotHash"] = snapshot_hash  # type: ignore[assignment]
        self._pending_tool = pending

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        pending, self._pending_tool = self._pending_tool, None
        if pending is None:
            return
        self._ensure_session()
        snapshot_hash = pending.pop("_snapshotHash", None)
        output_str = output if isinstance(output, str) else str(output)
        tool_call = {
            **pending,
            "output": output_str,
            "completedAt": _now_ms(),
            "status": "success",
        }
        metadata = {"snapshotHash": snapshot_hash} if snapshot_hash is not None else None
        self._record_commit(
            message=f'tool: {tool_call["name"]}',
            tool_call=tool_call,
            metadata=metadata,
        )

    def on_tool_error(
        self, error: Union[Exception, KeyboardInterrupt], **kwargs: Any
    ) -> None:
        pending, self._pending_tool = self._pending_tool, None
        if pending is None:
            return
        self._ensure_session()
        snapshot_hash = pending.pop("_snapshotHash", None)
        tool_call = {
            **pending,
            "output": None,
            "completedAt": _now_ms(),
            "status": "error",
            "error": str(error),
        }
        metadata = {"snapshotHash": snapshot_hash} if snapshot_hash is not None else None
        self._record_commit(
            message=f'tool error: {tool_call["name"]}',
            tool_call=tool_call,
            metadata=metadata,
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
                "completedAt": _now_ms(),
            },
        )
