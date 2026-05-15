# Adapter Expansion — Auto-Instrumentation, LangChain Example, New Framework Adapters

## Goal
Lower the integration friction for Python and add adapters for additional agent frameworks: a `@agentgit_record` decorator and global `auto_install()` for LangChain in Python, a runnable LangChain ReAct example, and new adapters for OpenAI Agents SDK, the Anthropic SDK (`tool_use` blocks), the Vercel AI SDK, AutoGen, and CrewAI. Every adapter writes the canonical schema so all sessions open identically in the UI.

## Context
- Today users must manually wrap their agent: `AgentWrapper(agent)` in Python, `wrapAgentJS(agent)` in TS. No decorator, no entrypoint hook.
- `adapters/python/agentgit_adapter/adapter.py` and `adapters/langchain/agentgit_langchain/handler.py` are unit-tested but no real-agent example exists.
- The canonical commit shape (after spec 002) is fixed: `{ tree, parent, sessionId, timestamp, message, toolCall, metadata, author }`. Every new adapter must produce identical records.
- Spec 003 makes guards default-on; adapters added here must honor the same defaults.

## Technical Approach
1. **Python auto-instrumentation (item #7)**
   - `@agentgit_record(session_name="...")` decorator: wraps any callable; on first invocation creates a session and wraps the callable's host object (if it's a method) with `AgentWrapper`.
   - `from agentgit_langchain import auto_install; auto_install()`: registers `AgentGitCallbackHandler` as a global LangChain callback via `langchain_core.callbacks.manager.set_handler` (or the current API equivalent).
   - Pytest fixture `agentgit_session` in `adapters/python/agentgit_adapter/pytest_plugin.py`: yields a Repository pointed at a tmp dir; cleans up after the test.
2. **LangChain example (item #11)**
   - `examples/langchain-react-agent/`:
     - `package.json` minimal scripts.
     - `run.ts` boots a ReAct agent (LangChain JS) with two tools: `search` (mocked) and `calculator` (numeric).
     - Wraps via the LangChain JS callback path (`AgentGitCallbackHandler` for JS — port if not present today).
     - On completion prints `agentgit log --session <id>` output and the path to launch the UI.
     - One-paragraph README walkthrough.
3. **OpenAI Agents SDK adapter (`adapters/openai-agents/`)**
   - Python first (the SDK is Python-primary).
   - Hook `Agent.run_step` to intercept tool calls; map each to a `ToolCall` record + a commit.
   - `examples/openai-agents-example/` smoke test.
4. **Anthropic SDK adapter (`adapters/anthropic-sdk/`)**
   - TS package.
   - Wraps `anthropic.messages.create` calls; whenever the response contains a `tool_use` block, record a `ToolCall` and follow-up commit. When the user resolves a tool with `tool_result`, attach the output to the in-flight call before committing.
5. **Vercel AI SDK adapter (`adapters/vercel-ai-sdk/`)**
   - TS package.
   - `wrapAI(ai)` returns an instrumented `ai` object whose `streamText` / `generateText` calls produce commits per tool invocation in the resulting tool-call stream.
6. **AutoGen adapter (`adapters/autogen/`)**
   - Python.
   - Hooks `ConversableAgent._process_received_message` and the tool-execution hook.
7. **CrewAI adapter (`adapters/crewai/`)**
   - Python.
   - Hooks `Crew.kickoff` and `Task.execute`.
8. **Cross-cutting**
   - Each adapter ships with a `smoke.test.ts` / `test_smoke.py` that boots a minimal agent of that framework (mocked LLM) and asserts at least one commit lands.
   - Each adapter's README example is ≤3 lines (excluding imports).

## Acceptance Criteria
- [ ] `@agentgit_record` decorator records commits for a wrapped function call (test in `adapters/python/tests/test_decorator.py`).
- [ ] `auto_install()` in `agentgit_langchain` registers globally; subsequent `LLMChain.run(...)` produces commits without explicit handler wiring.
- [ ] `agentgit_session` pytest fixture yields a working repo; usable from a sample test.
- [ ] `examples/langchain-react-agent/run.ts` runs end-to-end with a mocked LLM and produces a session visible in `agentgit log` and in the Tauri UI.
- [ ] Each of the five new adapters builds, ships a smoke test that passes, and has a ≤3-line README "wrap your agent" snippet.
- [ ] A session produced by each adapter opens in the Tauri UI showing the same step/diff/blame views (manual verification).

## Files to Touch
- adapters/python/agentgit_adapter/decorator.py  (create)
- adapters/python/agentgit_adapter/pytest_plugin.py  (create)
- adapters/python/agentgit_adapter/__init__.py  (modify — export decorator)
- adapters/python/pyproject.toml  (modify — register pytest plugin entrypoint)
- adapters/langchain/agentgit_langchain/auto_install.py  (create)
- adapters/langchain/agentgit_langchain/__init__.py  (modify)
- adapters/openai-agents/  (create — full package)
- adapters/anthropic-sdk/  (create — full package)
- adapters/vercel-ai-sdk/  (create — full package)
- adapters/autogen/  (create — full package)
- adapters/crewai/  (create — full package)
- examples/langchain-react-agent/  (create — runnable example)

## Test Strategy
- `pytest` in each Python adapter dir.
- `pnpm test` in each TS adapter package.
- Mocked LLM responses keep tests deterministic and offline.
- Manual UI verification for the "all adapters open identically" claim.
