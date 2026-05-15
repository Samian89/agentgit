"""CrewAI adapter for AgentGit.

Hooks ``Crew.kickoff`` and each ``Task.execute`` so every task in a crew run
becomes one AgentGit commit. Tested against an in-process stub of CrewAI.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Callable, Optional, Sequence, Union

_THIS = os.path.dirname(os.path.abspath(__file__))
_PY_ADAPTER = os.path.abspath(os.path.join(_THIS, "..", "..", "python"))
if _PY_ADAPTER not in sys.path:
    sys.path.insert(0, _PY_ADAPTER)

from agentgit_adapter import AgentWrapper  # type: ignore  # noqa: E402


class CrewAIAdapter:
    """Wrap a CrewAI ``Crew`` and record kickoff + each task execution."""

    def __init__(
        self,
        crew: Any,
        repo_path: str,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> None:
        self._crew = crew
        self.repo_path = repo_path
        self._guards = guards

        class _CrewCallable:
            name = getattr(crew, "name", "crew")

            def __call__(self, *args: Any, **kwargs: Any) -> Any:
                return {"args": args, "kwargs": kwargs}

        self._wrapper = AgentWrapper(_CrewCallable(), repo_path, guards=guards)

        original_kickoff: Optional[Callable[..., Any]] = getattr(crew, "kickoff", None)
        if original_kickoff is not None:
            wrapper = self._wrapper

            def patched_kickoff(*args: Any, **kwargs: Any) -> Any:
                wrapper(event="kickoff", args=args, kwargs=kwargs)
                return original_kickoff(*args, **kwargs)

            crew.kickoff = patched_kickoff  # type: ignore[attr-defined]

        # Patch each Task.execute on the tasks attached to the crew so the
        # per-step commits chain inside the same session.
        tasks = getattr(crew, "tasks", None)
        if tasks:
            for task in tasks:
                self._instrument_task(task)

    def _instrument_task(self, task: Any) -> None:
        original_execute: Optional[Callable[..., Any]] = getattr(task, "execute", None)
        if original_execute is None:
            return
        wrapper = self._wrapper
        task_name = getattr(task, "description", getattr(task, "name", "task"))

        def patched_execute(*args: Any, **kwargs: Any) -> Any:
            wrapper(event="task.execute", task=task_name, args=args, kwargs=kwargs)
            return original_execute(*args, **kwargs)

        task.execute = patched_execute  # type: ignore[attr-defined]

    @property
    def session_id(self) -> Optional[str]:
        return self._wrapper._session_id

    def finish(self, status: str = "completed") -> None:
        self._wrapper.finish(status)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._crew, item)


def wrap_crew(
    crew: Any,
    repo_path: str,
    guards: Union[Sequence[Any], bool, None] = None,
) -> CrewAIAdapter:
    return CrewAIAdapter(crew, repo_path, guards=guards)
