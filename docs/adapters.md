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
