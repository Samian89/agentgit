"""OpenAI Agents SDK adapter for AgentGit.

The OpenAI Agents SDK exposes ``Agent.run_step`` as the canonical hook for
intercepting tool calls. This module wraps an Agent so each ``run_step`` call
becomes an AgentGit commit, while still delegating to the underlying runner.
Tested against a tiny stub that mimics the SDK surface so we don't require
the upstream package to install.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Optional, Sequence, Union

# Re-use the canonical commit machinery from the generic Python adapter so the
# on-disk shape is identical across every adapter we ship.
_THIS = os.path.dirname(os.path.abspath(__file__))
_PY_ADAPTER = os.path.abspath(os.path.join(_THIS, "..", "..", "python"))
if _PY_ADAPTER not in sys.path:
    sys.path.insert(0, _PY_ADAPTER)

from agentgit_adapter import AgentWrapper  # type: ignore  # noqa: E402


class OpenAIAgentsAdapter:
    """Wrap an OpenAI Agents SDK ``Agent`` and record each ``run_step`` call."""

    def __init__(
        self,
        agent: Any,
        repo_path: str,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> None:
        self._agent = agent
        self.repo_path = repo_path
        self._guards = guards

        # Build a wrapper that owns the session/guard chain. We intercept
        # `run_step` and forward each call through `wrapper(...)` so the call
        # is recorded as a commit before the real implementation runs.
        original_run_step = getattr(agent, "run_step", None)
        if original_run_step is None:
            raise AttributeError(
                "OpenAIAgentsAdapter requires `agent.run_step` to exist; "
                "the upstream SDK exposes this hook on every Agent instance."
            )

        class _RunStepCallable:
            name = getattr(agent, "name", "run_step")

            def __call__(self, *args: Any, **kwargs: Any) -> Any:
                return original_run_step(*args, **kwargs)

        self._wrapper = AgentWrapper(_RunStepCallable(), repo_path, guards=guards)
        agent.run_step = self._wrapper  # type: ignore[attr-defined]

    @property
    def session_id(self) -> Optional[str]:
        return self._wrapper._session_id

    def finish(self, status: str = "completed") -> None:
        self._wrapper.finish(status)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._agent, item)


def wrap_agent(
    agent: Any,
    repo_path: str,
    guards: Union[Sequence[Any], bool, None] = None,
) -> OpenAIAgentsAdapter:
    """Wrap an OpenAI Agents SDK agent. See module docstring for semantics."""

    return OpenAIAgentsAdapter(agent, repo_path, guards=guards)
