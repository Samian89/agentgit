# Quickstart

Record and replay an agent session in under 10 minutes.

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9

## Step 1 — Install the CLI

```bash
npm install -g @agentgit/cli
```

Or use it locally inside a Node.js project:

```bash
npm install --save-dev @agentgit/cli @agentgit/sdk
```

## Step 2 — Initialize a repository

Run this inside your project directory:

```bash
agentgit init
```

Expected output:

```
Initialized empty AgentGit repository in /your/project/.agentgit
```

This creates `.agentgit/` with a SQLite index (`index.db`) and a content-addressed object store (`objects/`).

## Step 3 — Wrap your agent

Install the SDK:

```bash
npm install @agentgit/sdk
```

Create `agent.js`:

```js
import { wrapAgentJS } from "@agentgit/sdk";

class MyAgent {
  async run(prompt) {
    console.log(`[agent] "${prompt}"`);
    await this.search({ query: prompt });
    return { ok: true };
  }

  async search({ query }) {
    console.log(`  [tool] search("${query}")`);
    return [`result for: ${query}`];
  }
}

const agent = new MyAgent();
const wrapped = wrapAgentJS(agent, {
  repoDir: ".agentgit",
  sessionName: "my-session",
});

await wrapped.run("What is AgentGit?");
wrapped.agentgit.end();
```

`wrapAgentJS` proxies all methods on your agent. When `wrapped.run(prompt)` is called:

1. A **prompt commit** is recorded (tree contains `prompt.txt`).
2. `run()` executes with `this` bound to the proxy, so every `this.search(...)` is also intercepted.
3. Each intercepted method becomes a **tool-call commit** chained via a `parent` hash.

## Step 4 — Run the agent

```bash
node agent.js
```

Expected output:

```
[agent] "What is AgentGit?"
  [tool] search("What is AgentGit?")
```

## Step 5 — View the commit log

```bash
agentgit log
```

Expected output (hashes will differ):

```
a1b2c3d40011 2024-01-15 10:00:01 UTC [my-session]
    Tool: search
    tool: search (success)

e5f6a7b8c901 2024-01-15 10:00:00 UTC [my-session]
    Prompt: What is AgentGit?
```

## Step 6 — Filter by session

```bash
agentgit log --session my-session
```

## Step 7 — Diff two commits

Copy the first and second hashes from `agentgit log`, then:

```bash
agentgit diff a1b2c3d4 e5f6a7b8
```

Expected output:

```
diff a1b2c3d40011..e5f6a7b8c901
+++ prompt.txt (new, 20 bytes)
```

## Step 8 — Inspect a step (checkout)

```bash
agentgit checkout e5f6a7b8
```

Expected output:

```
HEAD is now at e5f6a7b8 Prompt: What is AgentGit?
Snapshot written to .agentgit/CHECKOUT
```

Open `.agentgit/CHECKOUT` to see the full JSON snapshot of that commit's state tree.

## Step 9 — Replay the session

```bash
agentgit replay my-session
```

Expected output:

```
Replaying session: my-session (<session-id>)
Total steps: 2

Step 1/2: Prompt: What is AgentGit?

Step 2/2: Tool: search
  Tool: search
  Input: {
    "query": "What is AgentGit?"
  }
  Output: ["result for: What is AgentGit?"]
  Status: success
```

## Step 10 — Export for archiving or CI

```bash
agentgit export my-session > session.json
```

The output is a self-contained [ReplayExport](./replay-export) JSON file containing every commit with its tool calls and state snapshots.

---

## Full example: todo-agent

The repository ships a complete working example at `examples/todo-agent/`:

```bash
pnpm install
# Build the workspace packages required by the example (filtered to avoid
# @agentgit/ui (its "build:tauri" needs Rust + webkit2gtk; root "build" is safe).
pnpm --filter @agentgit/core --filter @agentgit/sdk --filter @agentgit/cli build
cd examples/todo-agent
node run-agent.js
```

Expected output:

```
[agent] "add: Buy groceries"
  [tool] addTodo  → "Buy groceries" (total: 1)
  [tool] saveTodos  → wrote 1 todo(s) to todos.json

[agent] "add: Write unit tests"
  [tool] addTodo  → "Write unit tests" (total: 2)
  [tool] saveTodos  → wrote 2 todo(s) to todos.json

[agent] "complete: 0"
  [tool] completeTodo  → #0 "Buy groceries" ✓
  [tool] saveTodos  → wrote 2 todo(s) to todos.json

─────────────────────────────────────────
✓  9 commits recorded in .agentgit/
   Session: <session-id>
─────────────────────────────────────────

Next steps:
  pnpm exec agentgit log -s <session-id>
  pnpm exec agentgit diff <hash1> <hash3>
```

The agent processes 3 prompts and produces 9 commits (1 prompt + 2 tool calls per prompt).

---

## Capturing LLM calls

When your agent exposes an `llm` property (Anthropic client, Vercel AI SDK module, or any Python LLM SDK via the adapter), `wrapAgentJS` (and the Python `wrap_agent` / `@agentgit_record_llm`) automatically captures every `messages.create` / `generateText` / chat completion as a first-class `LlmCall` commit.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAgentJS } from "@agentgit/sdk";

class Agent {
  llm = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  async run(prompt: string) {
    const resp = await this.llm.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return resp.content[0].text;
  }
}

const wrapped = wrapAgentJS(new Agent(), {
  repoDir: ".agentgit",
  sessionName: "llm-demo",
});
await wrapped.run("Explain LlmCall in one sentence");
wrapped.agentgit.end();
```

After running, `agentgit log` shows the LLM reasoning step:

```
a1b2c3d4... 2024-01-15 10:05:00 UTC [llm-demo]
    llm: claude-opus-4-7 (18 tok ~$0.0012)
```

Use `agentgit replay llm-demo --full` to see the full prompt messages, response text, token breakdown, duration, and cost estimate.

The same capture works in Python via `AgentWrapper.record_llm_call(...)`, the `@agentgit_record_llm` decorator, LangChain `on_llm_end`, and the OpenAI Agents / AutoGen / CrewAI adapters.
