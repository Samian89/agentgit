# Adapters

AgentGit ships drop-in adapters for Python agents and LangChain. Both adapters record commits to the same content-addressed store and SQLite index as the TypeScript SDK.

---

## Python adapter

### Installation

```bash
pip install -e adapters/python
```

Or from PyPI (once published):

```bash
pip install agentgit-adapter
```

### `wrap_agent(agent, repo_path)`

Wraps any Python callable or object in an `AgentWrapper` that intercepts `__call__` and records each invocation as a commit.

```python
from agentgit_adapter import wrap_agent

wrapped = wrap_agent(agent, repo_path="/path/to/project")
```

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | any callable | The agent to wrap. Must be callable (`__call__`). |
| `repo_path` | `str` | Path to the project root (`.agentgit/` will be created here if missing). |

**Returns** — `AgentWrapper`

### `AgentWrapper`

`AgentWrapper` is a thin proxy around the original agent.

```python
class AgentWrapper:
    def __call__(self, *args, **kwargs):
        """Calls the underlying agent and records a commit."""

    def finish(self, status: str = "completed") -> None:
        """Mark the session completed in SQLite."""
```

#### Context manager support

```python
with wrap_agent(agent, repo_path=".") as wrapped:
    result = wrapped("Summarize this document")
# session.finish("completed") is called automatically on exit
# session.finish("failed") is called if an exception is raised
```

### Behaviour

| Event | What happens |
|-------|-------------|
| `wrapped(*args, **kwargs)` | Opens a session if needed; calls the agent; records a commit with a `ToolCall` (status=success) |
| Agent raises an exception | Records a commit with `ToolCall` (status=error, error=str(exc)); re-raises |
| `wrapped.finish()` | Marks the session `completed` in SQLite |
| `with wrap_agent(...) as w:` | `finish("completed")` on normal exit, `finish("failed")` on exception |

### Commit schema (Python adapter)

Each commit recorded by the Python adapter follows this shape:

```json
{
  "hash": "<sha256>",
  "parent": "<parent-hash-or-null>",
  "sessionId": "<uuid>",
  "message": "tool_call: <agent-class-name>",
  "timestamp": 1705312800000,
  "tree": "<empty-tree-hash>",
  "type": "commit",
  "toolCall": {
    "id": "<uuid>",
    "name": "<agent-class-name>",
    "input": { "args": [...], "kwargs": {...} },
    "output": "<result>",
    "startedAt": 1705312800000,
    "completedAt": 1705312800100,
    "status": "success"
  }
}
```

### Full example

```python
from agentgit_adapter import wrap_agent

class SummaryAgent:
    def __call__(self, text: str) -> str:
        return f"Summary of: {text[:50]}..."

agent = SummaryAgent()

with wrap_agent(agent, repo_path="/my/project") as wrapped:
    result = wrapped("This is a long document...")
    print(result)
```

Then inspect:

```bash
agentgit log
agentgit export my-session > session.json
```

---

## LangChain adapter

### Installation

```bash
pip install -e adapters/langchain
```

Or from PyPI:

```bash
pip install agentgit-langchain
```

Requires `langchain-core`.

### `AgentGitCallbackHandler`

A LangChain `BaseCallbackHandler` that records every agent run as content-addressed commits. Pass it in the `callbacks` list when invoking your chain or agent.

```python
from agentgit_langchain import AgentGitCallbackHandler

handler = AgentGitCallbackHandler(repo_path="/path/to/project")
```

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `repo_path` | `str` | Path to the project root (`.agentgit/` will be created here if missing). |

### Callback → commit mapping

| Callback | Action |
|----------|--------|
| `on_agent_action` | Opens a session (idempotent; noop if session already open) |
| `on_agent_finish` | Marks the session `completed` |
| `on_tool_start` | Captures tool name, input, and start timestamp |
| `on_tool_end` | Writes a commit with `tool_call` (status=success) and advances HEAD |
| `on_tool_error` | Writes a commit with `tool_call` (status=error) |
| `on_llm_start` | Captures prompts and start timestamp |
| `on_llm_end` | Writes a commit with prompts + outputs in metadata |

### Usage

```python
from langchain.agents import initialize_agent, Tool
from langchain_openai import ChatOpenAI
from agentgit_langchain import AgentGitCallbackHandler

handler = AgentGitCallbackHandler(repo_path="/my/project")

tools = [
    Tool(name="search", func=lambda q: f"results for {q}",
         description="Search the web"),
]

llm = ChatOpenAI(model="gpt-4o")
agent = initialize_agent(tools, llm, agent="zero-shot-react-description")

# Pass the handler via callbacks
result = agent.run(
    "What is the capital of France?",
    callbacks=[handler],
)
```

After the run:

```bash
agentgit log
# Shows one commit per tool call + LLM call
```

### Auto-initialization

If `.agentgit/` does not exist in `repo_path`, the handler runs `agentgit init <repo_path>` automatically before writing the first commit.

### Example with explicit session control

```python
handler = AgentGitCallbackHandler(repo_path=".")

# Run multiple turns in one session
for question in ["Q1", "Q2", "Q3"]:
    agent.run(question, callbacks=[handler])

# Handler tracks the open session automatically; it is closed by on_agent_finish.
```

---

## Anthropic SDK adapter

The `@agentgit/adapter-anthropic-sdk` (source in `adapters/anthropic-sdk/`) wraps an Anthropic client so that every `messages.create(...)` call records both `ToolCall` entries (for any `tool_use` / `tool_result` blocks) **and** a single `LlmCall` (provider `"anthropic"`) via the optional `recorder.recordLlm` hook.

### Usage

```js
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic, inMemoryRecorder } from "@agentgit/adapter-anthropic-sdk";

const recorder = inMemoryRecorder();
const client = wrapAnthropic(new Anthropic({ apiKey: "..." }), { recorder });

const resp = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});

console.log(recorder.llmCalls[0]); // RecordedLlmCall with model, messages, response, usage, costEstimateUsd, ...
```

- `wrapAnthropic(client, { recorder })` monkey-patches `messages.create` and returns the same client object.
- On success: extracts model, normalises messages (string or block content), joins text responses, maps usage, computes `costEstimateUsd` via the pricing helper, stamps timestamps/duration, calls `recorder.recordLlm(llmCall)`.
- On error: records an `LlmCall` with `status:"error"` then re-throws.
- If `recorder` has no `recordLlm`, the hook is a no-op (backward compatible).
- Pricing table (`pricing.mjs`): `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` with conservative per-million rates; unknown models → `null`.

The `RecordedLlmCall` shape matches the core `LlmCall` (id, provider, model, messages[], response, usage, costEstimateUsd, startedAt/completedAt/durationMs, status, error).

When used together with `@agentgit/sdk` the `wrapAgentJS({ llm: { provider: "anthropic", client } })` path uses an internal bridge that calls the same `recordLlm`.

---

## Vercel AI SDK adapter

The `@agentgit/adapter-vercel-ai-sdk` (source in `adapters/vercel-ai-sdk/`) wraps a Vercel AI module (`{ generateText, streamText }`) and records every `generateText` / `streamText` invocation as an `LlmCall` (provider `"vercel-ai-sdk"`) plus any tool calls returned in the result.

### Usage

```js
import { generateText, streamText } from "ai";
import { wrapAI, inMemoryRecorder } from "@agentgit/adapter-vercel-ai-sdk";

const recorder = inMemoryRecorder();
const ai = wrapAI({ generateText, streamText }, { recorder });

await ai.generateText({ model: openai("gpt-4o"), prompt: "Hello" });
console.log(recorder.llmCalls[0]); // { provider: "vercel-ai-sdk", model, messages, response, usage, costEstimateUsd, ... }
```

- Both `generateText` and `streamText` are instrumented; `streamText` captures the final accumulated text + usage after the stream ends.
- Messages are normalised from the Vercel `messages` / `prompt` shape into `LlmMessage[]`.
- `costEstimateUsd` is computed by `pricing.mjs` for known routed models (openai/gpt-4o*, anthropic/claude-* fallbacks); unknown → `null`.
- Error path records `status:"error"` and re-throws.
- `recorder.recordLlm` is optional (no-op when absent).

Used by `wrapAgentJS({ llm: { provider: "vercel-ai-sdk" } })` via the SDK bridge.

---

## Python LLM capture

The Python adapter family (`agentgit_adapter`, `agentgit_langchain`, and the framework adapters) exposes first-class LLM capture that writes `LlmCall` commits exactly like the TypeScript side (migration 003 parity, `TARGET_VERSION = 3`).

### `AgentWrapper.record_llm_call(...)`

```python
from agentgit_adapter import wrap_agent

wrapped = wrap_agent(my_agent, repo_path=".")
h = wrapped.record_llm_call(
    provider="anthropic",
    model="claude-opus-4-7",
    messages=[{"role": "user", "content": "Explain redaction"}],
    response="Redaction scrubs secrets before hashing.",
    usage={"promptTokens": 12, "completionTokens": 9, "totalTokens": 21},
    cost_estimate_usd=0.00042,
)
print(h)  # 64-char content hash of the LlmCall commit
```

- Auto-generates UUID id, timestamps, durationMs, status (success/error).
- Sets `message = f"LLM: {model}"`.
- Always emits `"llmCall": ...` (null when absent) in the canonical commit body.
- Supports optional `started_at`, `completed_at`, `error`.
- Redaction (if configured in `.agentgit/config.json`) is applied before hashing.

### `@agentgit_record_llm` decorator

```python
from agentgit_adapter import agentgit_record_llm, openai_chat_extractor

@agentgit_record_llm(repo_path=".", provider="openai", extract=openai_chat_extractor)
def ask(prompt: str) -> str:
    resp = client.chat.completions.create(model="gpt-4o", messages=[{"role":"user","content":prompt}])
    return resp.choices[0].message.content
```

- The `extract(args, kwargs, result)` hook projects provider-specific shapes onto the canonical `{model, messages, response, usage}` dict.
- `openai_chat_extractor` is provided out of the box; you can supply your own for Anthropic, Bedrock, etc.
- Recording failures are swallowed so the decorated function is never broken by the audit layer.
- The wrapper is created on first call; call `finish()` on the returned object to close the session.

### LangChain handler (`on_llm_end`)

`AgentGitCallbackHandler` now writes a full `LlmCall` (provider `"langchain"`) on `on_llm_end` instead of metadata-only. The model name is taken from `invocation_params`, token usage from `llm_output["token_usage"]` when present, and the prompt/response are stored in the structured `llm_call` column.

```python
handler = AgentGitCallbackHandler(repo_path=".")
# ... run chain with callbacks=[handler]
# log now shows "LLM: gpt-4o (N tok)" lines and replay --full shows Prompt/Response blocks
```

The handler also participates in redaction and writes the `llm_call` column (migration 003).

### Framework adapters (OpenAI Agents, AutoGen, CrewAI)

- **OpenAI Agents adapter** (`agentgit_openai_agents`): patches `Agent.run_step`; when a `ModelResponse` is present it calls `record_llm_call` with the model, usage (`input_tokens`/`output_tokens`), and the accumulated message history.
- **AutoGen adapter** (`agentgit_autogen`): hooks the OAI client `create` / `_completions_create` path and records each chat completion via the shared `AgentWrapper.record_llm_call`.
- **CrewAI adapter** (`agentgit_crewai`): intercepts `LLM.call` (and `LLM.call_with_tools`) and extracts model/usage/messages/response before delegating, producing one `LlmCall` per LLM turn.

All three delegate to the common `AgentWrapper` / `_record_commit` so they automatically receive v3 schema support, redaction, and cross-runtime hash compatibility.

See `adapters/*/tests/test_*_llm_capture.py` for usage examples and the smoke tests.
