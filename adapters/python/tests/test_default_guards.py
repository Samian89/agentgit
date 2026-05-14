"""Tests for the default-on guard chain in `AgentWrapper`.

Mirrors `packages/sdk/src/__tests__/default-guards.test.ts` so the
Python and TS adapters behave identically.
"""

import json
import os

import pytest

from agentgit_adapter import AgentWrapper, ConfirmationGuard, wrap_agent


class BashAgent:
    """Agent whose tool name matches DEFAULT_DESTRUCTIVE_TOOLS."""

    name = "bash"

    def __init__(self):
        self.calls = []

    def __call__(self, cmd: str = "") -> str:
        self.calls.append(cmd)
        return f"executed: {cmd}"


class HarmlessAgent:
    name = "search"

    def __call__(self, q: str = "") -> str:
        return f"results: {q}"


# ---------------------------------------------------------------------------
# Default-on behavior
# ---------------------------------------------------------------------------


class TestDefaultGuards:
    def test_naive_wrap_blocks_destructive_bash(self, tmp_repo):
        """No options → ConfirmationGuard + non-TTY pytest stdin → blocked."""
        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo)
        with pytest.raises(RuntimeError, match="blocked by guard"):
            wrapped("rm -rf /tmp/x")
        assert agent.calls == []  # underlying agent never ran

    def test_non_destructive_tools_pass_through(self, tmp_repo):
        wrapped = wrap_agent(HarmlessAgent(), tmp_repo)
        # Not destructive, not a write tool → both default guards allow.
        assert wrapped("hello") == "results: hello"

    def test_opt_out_with_guards_false(self, tmp_repo):
        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo, guards=False)
        result = wrapped("rm -rf /tmp/x")
        assert result == "executed: rm -rf /tmp/x"
        assert agent.calls == ["rm -rf /tmp/x"]

    def test_explicit_guards_array_overrides_defaults(self, tmp_repo):
        seen = []

        class Tracker:
            name = "tracker"

            def check(self, tool_call):
                seen.append(tool_call["name"])
                return {"outcome": "allow"}

        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo, guards=[Tracker()])
        # ConfirmationGuard is NOT applied: bash succeeds despite being
        # destructive. Tracker observes the call.
        wrapped("ls")
        assert seen == ["bash"]
        assert agent.calls == ["ls"]


# ---------------------------------------------------------------------------
# Config-driven overrides
# ---------------------------------------------------------------------------


def _write_config(tmp_repo: str, body: dict) -> None:
    cfg_path = os.path.join(tmp_repo, ".agentgit", "config.json")
    os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(body, f)


class TestConfigDrivenGuards:
    def test_auto_confirm_suppresses_prompt(self, tmp_repo):
        _write_config(
            tmp_repo,
            {"guards": {"confirmation": {"autoConfirm": ["bash"]}}},
        )
        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo)
        # No prompt is invoked; the call succeeds.
        result = wrapped("ls -la")
        assert result == "executed: ls -la"

    def test_denylist_blocks_matching_input_substring(self, tmp_repo):
        _write_config(
            tmp_repo,
            {"guards": {"confirmation": {"denylist": ["rm -rf"]}}},
        )
        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo)
        with pytest.raises(RuntimeError, match="denylist"):
            wrapped("rm -rf /tmp/x")
        assert agent.calls == []

    def test_guards_enabled_false_turns_off_chain(self, tmp_repo):
        _write_config(tmp_repo, {"guards": {"enabled": False}})
        agent = BashAgent()
        wrapped = wrap_agent(agent, tmp_repo)
        # bash is destructive but the chain is disabled.
        assert wrapped("rm -rf /tmp/x") == "executed: rm -rf /tmp/x"


# ---------------------------------------------------------------------------
# ConfirmationGuard direct unit tests
# ---------------------------------------------------------------------------


class TestConfirmationGuardUnit:
    def _make_call(self, name: str, input_dict=None):
        return {
            "id": "t1",
            "name": name,
            "input": input_dict or {},
            "output": None,
            "startedAt": 0,
            "completedAt": None,
            "status": "pending",
            "error": None,
        }

    def test_allows_non_destructive_tool(self):
        guard = ConfirmationGuard(prompt_fn=lambda _: "n")
        assert guard.check(self._make_call("readFile"))["outcome"] == "allow"

    def test_blocks_destructive_when_prompt_says_no(self):
        guard = ConfirmationGuard(prompt_fn=lambda _: "n")
        result = guard.check(self._make_call("bash"))
        assert result["outcome"] == "block"

    def test_allows_destructive_when_prompt_says_yes(self):
        guard = ConfirmationGuard(prompt_fn=lambda _: "y")
        assert guard.check(self._make_call("bash"))["outcome"] == "allow"

    def test_denylist_blocks_via_input_substring(self):
        guard = ConfirmationGuard(
            denylist=["rm -rf"], prompt_fn=lambda _: "y"
        )
        result = guard.check(
            self._make_call("bash", {"args": ["rm -rf /tmp/x"]})
        )
        assert result["outcome"] == "block"
        assert "denylist" in result["reason"]

    def test_auto_confirm_skips_prompt(self):
        called = []

        def prompt(msg):
            called.append(msg)
            return "n"

        guard = ConfirmationGuard(auto_confirm=["bash"], prompt_fn=prompt)
        assert guard.check(self._make_call("bash"))["outcome"] == "allow"
        assert called == []  # no prompt invoked
