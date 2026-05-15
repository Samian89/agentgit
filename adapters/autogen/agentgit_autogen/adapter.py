"""AutoGen adapter for AgentGit.

AutoGen's ``ConversableAgent`` exposes two natural interception points:

  * ``_process_received_message(message, sender, ...)`` — every inbound message
    flows through here, including tool-call replies.
  * ``execute_function`` — the tool-execution hook used by registered
    function-calling agents.

This adapter monkey-patches both so tool calls and inbound messages produce
AgentGit commits via the shared ``AgentWrapper`` machinery. Tested against a
tiny stub that mimics ``ConversableAgent`` so the upstream package isn't a
hard dependency.
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


class AutoGenAdapter:
    """Wrap an AutoGen ``ConversableAgent`` and record each tool call."""

    def __init__(
        self,
        agent: Any,
        repo_path: str,
        guards: Union[Sequence[Any], bool, None] = None,
    ) -> None:
        self._agent = agent
        self.repo_path = repo_path
        self._guards = guards

        # Long-lived wrapper that owns the session/guard chain. We use it as a
        # commit recorder by routing each intercepted call through `wrapper(...)`.
        class _AgentCallable:
            name = getattr(agent, "name", type(agent).__name__)

            def __call__(self, *args: Any, **kwargs: Any) -> Any:
                # Returning the args is fine — we discard the result. The
                # AgentWrapper persists `args/kwargs` as the tool input
                # regardless of what we return here.
                return {"args": args, "kwargs": kwargs}

        self._wrapper = AgentWrapper(_AgentCallable(), repo_path, guards=guards)

        # Patch execute_function (function-calling tool dispatch).
        original_execute: Optional[Callable[..., Any]] = getattr(
            agent, "execute_function", None
        )
        if original_execute is not None:
            wrapper = self._wrapper

            def patched_execute(func_call: Any, *args: Any, **kwargs: Any) -> Any:
                wrapper(func_call=func_call, args=args, kwargs=kwargs)
                return original_execute(func_call, *args, **kwargs)

            agent.execute_function = patched_execute  # type: ignore[attr-defined]

        # Patch _process_received_message (every inbound message).
        original_process: Optional[Callable[..., Any]] = getattr(
            agent, "_process_received_message", None
        )
        if original_process is not None:
            wrapper = self._wrapper

            def patched_process(
                message: Any, sender: Any = None, *args: Any, **kwargs: Any
            ) -> Any:
                wrapper(message=message, sender=getattr(sender, "name", str(sender)))
                return original_process(message, sender, *args, **kwargs)

            agent._process_received_message = patched_process  # type: ignore[attr-defined]

        # LLM capture hook: patch common AutoGen OAI client paths so that
        # chat.completions.create calls produce a structured LlmCall commit.
        # The patched function extracts request (messages, model) + response usage.
        oai_client = getattr(agent, "client", None) or getattr(agent, "_oai_client", None)
        if oai_client is not None and hasattr(oai_client, "create"):
            orig_create = oai_client.create
            w = self._wrapper

            def patched_create(*args: Any, **kwargs: Any) -> Any:
                # kwargs typically: model, messages
                model = kwargs.get("model", "gpt-4o")
                messages = kwargs.get("messages", [])
                res = orig_create(*args, **kwargs)
                # response may be dict or object with usage
                usage = None
                resp_text = ""
                if isinstance(res, dict):
                    u = res.get("usage", {})
                    usage = {
                        "promptTokens": u.get("prompt_tokens", 0),
                        "completionTokens": u.get("completion_tokens", 0),
                        "totalTokens": u.get("total_tokens", 0),
                    }
                    choices = res.get("choices", [])
                    if choices:
                        resp_text = (choices[0].get("message") or {}).get("content", "")
                else:
                    u = getattr(res, "usage", None)
                    if u:
                        usage = {
                            "promptTokens": getattr(u, "prompt_tokens", 0),
                            "completionTokens": getattr(u, "completion_tokens", 0),
                            "totalTokens": getattr(u, "total_tokens", 0),
                        }
                    # try choices
                    ch = getattr(res, "choices", None)
                    if ch:
                        m = ch[0].message if hasattr(ch[0], "message") else ch[0]
                        resp_text = getattr(m, "content", "") or ""
                try:
                    w.record_llm_call(
                        provider="autogen",
                        model=str(model),
                        messages=messages if isinstance(messages, list) else [],
                        response=resp_text or str(res)[:200],
                        usage=usage,
                    )
                except Exception:
                    pass
                return res

            oai_client.create = patched_create  # type: ignore[attr-defined]

        # Also support direct _generate_oai_reply_from_client patch (some AutoGen versions)
        gen_oai = getattr(agent, "_generate_oai_reply_from_client", None)
        if callable(gen_oai):
            w = self._wrapper

            def patched_gen(client: Any, messages: Any, *a: Any, **k: Any) -> Any:
                model = getattr(client, "model", "unknown")
                res = gen_oai(client, messages, *a, **k)
                # simplistic: treat as LLM success
                try:
                    w.record_llm_call(
                        provider="autogen",
                        model=str(model),
                        messages=messages if isinstance(messages, list) else [],
                        response=str(res)[:200] if res else "",
                        usage=None,
                    )
                except Exception:
                    pass
                return res

            agent._generate_oai_reply_from_client = patched_gen  # type: ignore[attr-defined]

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
) -> AutoGenAdapter:
    return AutoGenAdapter(agent, repo_path, guards=guards)
