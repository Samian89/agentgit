"""Tests for the default-on guard chain in `AgentGitCallbackHandler`.

Mirrors the SDK + Python adapter behaviour: ConfirmationGuard +
SnapshotGuard apply automatically, with opt-out via `guards=False`
and full override via `guards=[...]`.
"""

import json
import os

import pytest
from langchain_core.agents import AgentAction

import agentgit_langchain.handler as handler_module
from agentgit_langchain import AgentGitCallbackHandler
from .conftest import db_rows


def _write_config(tmp_repo: str, body: dict) -> None:
    cfg_path = os.path.join(tmp_repo, ".agentgit", "config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(body, f)


class TestDefaultGuards:
    def test_default_handler_blocks_destructive_bash(self, tmp_repo):
        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))

        with pytest.raises(RuntimeError, match="blocked by guard"):
            handler.on_tool_start({"name": "bash"}, "rm -rf /tmp/x")

        # No commit recorded for the blocked call.
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 0

    def test_non_destructive_tool_unaffected(self, tmp_repo):
        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))
        handler.on_tool_start({"name": "search"}, "what is AI?")
        handler.on_tool_end("AI is cool")

        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1

    def test_opt_out_with_guards_false(self, tmp_repo):
        handler = AgentGitCallbackHandler(repo_path=tmp_repo, guards=False)
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))
        # No guard chain → destructive call records normally.
        handler.on_tool_start({"name": "bash"}, "rm -rf /tmp/x")
        handler.on_tool_end("ok")
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1

    def test_explicit_guards_array_overrides_defaults(self, tmp_repo):
        seen = []

        class Tracker:
            name = "tracker"

            def check(self, tool_call):
                seen.append(tool_call["name"])
                return {"outcome": "allow"}

        handler = AgentGitCallbackHandler(repo_path=tmp_repo, guards=[Tracker()])
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))
        handler.on_tool_start({"name": "bash"}, "ls")
        handler.on_tool_end("ok")

        assert seen == ["bash"]  # tracker fired
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1  # destructive call succeeded because ConfirmationGuard was excluded

    def test_missing_guard_dependency_fails_closed(self, tmp_repo, monkeypatch):
        monkeypatch.setattr(handler_module, "GuardRegistry", None)
        monkeypatch.setattr(handler_module, "build_default_guards", None)
        monkeypatch.setattr(
            handler_module,
            "_GUARD_IMPORT_ERROR",
            ImportError("missing agentgit_adapter"),
        )

        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))

        with pytest.raises(RuntimeError, match="guard dependencies unavailable"):
            handler.on_tool_start({"name": "search"}, "q")

        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 0

    def test_guard_builder_failure_fails_closed(self, tmp_repo, monkeypatch):
        def broken_build_default_guards(*_args, **_kwargs):
            raise ImportError("missing transitive guard dependency")

        monkeypatch.setattr(
            handler_module, "build_default_guards", broken_build_default_guards
        )

        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))

        with pytest.raises(RuntimeError, match="guard dependencies unavailable"):
            handler.on_tool_start({"name": "search"}, "q")

        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 0

    def test_missing_guard_dependency_still_honors_opt_out(
        self, tmp_repo, monkeypatch
    ):
        monkeypatch.setattr(handler_module, "GuardRegistry", None)
        monkeypatch.setattr(handler_module, "build_default_guards", None)
        monkeypatch.setattr(
            handler_module,
            "_GUARD_IMPORT_ERROR",
            ImportError("missing agentgit_adapter"),
        )

        handler = AgentGitCallbackHandler(repo_path=tmp_repo, guards=False)
        handler.on_agent_action(AgentAction(tool="search", tool_input="q", log=""))
        handler.on_tool_start({"name": "search"}, "q")
        handler.on_tool_end("ok")

        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1


class TestConfigDrivenGuards:
    def test_auto_confirm_suppresses_prompt(self, tmp_repo):
        _write_config(
            tmp_repo,
            {"guards": {"confirmation": {"autoConfirm": ["bash"]}}},
        )
        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))
        handler.on_tool_start({"name": "bash"}, "ls -la")
        handler.on_tool_end("ok")
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1

    def test_denylist_substring_blocks(self, tmp_repo):
        _write_config(
            tmp_repo,
            {"guards": {"confirmation": {"denylist": ["rm -rf"]}}},
        )
        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))
        with pytest.raises(RuntimeError, match="denylist"):
            handler.on_tool_start({"name": "bash"}, "rm -rf /tmp/x")

    def test_guards_enabled_false_turns_off_chain(self, tmp_repo):
        _write_config(tmp_repo, {"guards": {"enabled": False}})
        handler = AgentGitCallbackHandler(repo_path=tmp_repo)
        handler.on_agent_action(AgentAction(tool="bash", tool_input="x", log=""))
        # Destructive call records without prompting or blocking.
        handler.on_tool_start({"name": "bash"}, "rm -rf /tmp/x")
        handler.on_tool_end("ok")
        count = db_rows(tmp_repo, "SELECT COUNT(*) FROM commits")[0][0]
        assert count == 1
