# SDK API

The `@agentgit/sdk` package provides two ways to record agent sessions:

- **`wrapAgentJS`** — automatic interception via a Proxy (zero-change wrapper)
- **`AgentGitSession`** — manual session management for fine-grained control

## Installation

```bash
npm install @agentgit/sdk
```

---

## `wrapAgentJS(agent, options?)`

Wraps any agent object so that every tool call is intercepted, guarded, and recorded as a content-addressed commit. When `agent.llm` (or an explicit client) is present and `WrapOptions.llm` is not `false`, LLM calls are also auto-captured as `LlmCall` commits via the Anthropic / Vercel AI SDK adapters.

### Signature

```ts
function wrapAgentJS<T extends AgentLike>(
  agent: T,
  options?: WrapOptions,
): WrappedAgent<T>
```

### `AgentLike` interface

Your agent must implement at least one method named `run`:

```ts
interface AgentLike {
  run(prompt: string): Promise<unknown>;
  [key: string]: unknown;
}
```

All other methods on the agent are treated as **tool calls** and are intercepted automatically.

### `WrapOptions`

```ts
interface WrapOptions {
  /** Path to the .agentgit directory. Auto-created if missing. Defaults to ".agentgit". */
  repoDir?: string;

  /** Human-readable name for the session (shown in agentgit log). */
  sessionName?: string;

  /** Arbitrary metadata stored with the session record in SQLite. */
  sessionMetadata?: Record<string, unknown>;

  /** Guards to run before each intercepted tool call. See Safety Guards. */
  guards?: Guard[] | false;

  /**
   * LLM auto-capture options (see LlmCall below).
   *
   * - `undefined` (default): auto-detect `agent.llm` if present and shaped like
   *   an Anthropic client (`messages.create`) or Vercel AI module (`generateText`/`streamText`).
   * - `false`: disable auto-capture even if `agent.llm` exists.
   * - `{ provider: "anthropic" | "vercel-ai-sdk", client? }`: force a specific adapter
   *   and (optionally) wrap the given client instead of (or in addition to) `agent.llm`.
   */
  llm?: LlmAutoCaptureOptions;
}
```

### Return value — `WrappedAgent<T>`

The wrapped agent is a Proxy of the original. It adds a read-only `agentgit` property:

```ts
type WrappedAgent<T extends AgentLike> = T & {
  readonly agentgit: {
    /** UUID of the active session. */
    readonly sessionId: string;
    /** Direct access to the underlying Repository. */
    readonly repo: Repository;
    /** Mark the session as completed (or another terminal status). */
    end(status?: "completed" | "failed" | "cancelled"): void;
  };
};
```

### How interception works

A Proxy traps all property access on the agent:

1. `run(prompt)` is called → a **prompt commit** is recorded (tree contains `prompt.txt`), then `run` executes with `this` bound to the proxy.
2. Every other method (e.g. `search`, `writeFile`) is treated as a **tool call** → guards run, the real function executes, and a tool-call commit is recorded.
3. Commits are chained via `parent` hashes forming a verifiable DAG.

```
Prompt: add: Buy groceries      ← commit 1  (prompt.txt in tree)
  └── Tool: addTodo             ← commit 2  (toolCall recorded)
      └── Tool: saveTodos       ← commit 3  (toolCall recorded)
          └── Prompt: ...       ← commit 4  ...
```

### Example

```ts
import { wrapAgentJS } from "@agentgit/sdk";
import { ConfirmationGuard } from "@agentgit/core";

class MyAgent {
  async run(prompt: string) {
    await this.search({ query: prompt });
    return { ok: true };
  }

  async search({ query }: { query: string }) {
    return [`result: ${query}`];
  }
}

const wrapped = wrapAgentJS(new MyAgent(), {
  repoDir: ".agentgit",
  sessionName: "research-session",
  guards: [new ConfirmationGuard()],
});

await wrapped.run("What is AgentGit?");
wrapped.agentgit.end();
```

---

## `AgentGitSession`

Manual session management for recording agent steps without automatic interception. Useful when you need full control over what gets committed, or when integrating with frameworks that manage their own execution loops.

### `AgentGitSession.create(repoDir, name, metadata?, guards?)`

Create a new session in a repository (initializing it if it does not exist):

```ts
static create(
  repoDir: string,
  name: string,
  metadata?: Record<string, unknown>,
  guards?: Guard[],
): AgentGitSession
```

**Example:**

```ts
import { AgentGitSession } from "@agentgit/sdk";

const session = AgentGitSession.create(".agentgit", "manual-session");
```

### `session.id`

```ts
readonly id: string  // UUID of this session
```

### `session.repo`

```ts
readonly repo: Repository  // the underlying @agentgit/core Repository
```

### `session.recordPrompt(prompt, stateEntries?)`

Record the incoming prompt as a commit and advance the internal parent pointer.

```ts
recordPrompt(
  prompt: string,
  stateEntries?: StateEntry[],  // defaults to [{ path: "prompt.txt", content: prompt }]
): Commit
```

### `session.recordToolCall(toolCall, stateEntries?)`

Record a completed tool call as a commit.

```ts
recordToolCall(
  toolCall: ToolCall,
  stateEntries?: StateEntry[],
): Commit
```

`ToolCall` shape:

```ts
interface ToolCall {
  id: string;                          // UUID v4
  name: string;                        // tool name
  input: Record<string, unknown>;      // arguments
  output: unknown | null;              // return value
  startedAt: number;                   // Unix ms
  completedAt: number | null;          // Unix ms
  status: "pending" | "success" | "error";
  error: string | null;
}
```

### `session.runGuards(toolCall)`

Run registered guards against a pending tool call before execution.

```ts
async runGuards(toolCall: ToolCall): Promise<GuardResult>
```

Returns a `GuardResult`:

```ts
interface GuardResult {
  outcome: "allow" | "block";
  reason?: string;
  snapshotHash?: string;  // blob hash of pre-write snapshot (from SnapshotGuard)
}
```

### `session.getSession()`

Fetch the live session record from the SQLite index (reflects the latest HEAD pointer).

```ts
getSession(): Session
```

### `session.end(status?)`

Mark the session as a terminal status.

```ts
end(status?: "completed" | "failed" | "cancelled"): void
```

### Manual session example

```ts
import { AgentGitSession } from "@agentgit/sdk";
import { randomUUID } from "node:crypto";

const session = AgentGitSession.create(".agentgit", "manual-session");

session.recordPrompt("Translate the README to French");

const toolCall = {
  id: randomUUID(),
  name: "read_file",
  input: { path: "README.md" },
  output: "# AgentGit\n...",
  startedAt: Date.now(),
  completedAt: Date.now(),
  status: "success" as const,
  error: null,
};

session.recordToolCall(toolCall);
session.end();
```

---

## `LlmCall`

`LlmCall` is the first-class payload for LLM reasoning steps (prompt → response, usage, cost). It is recorded by `Repository.recordLlmCall` (TS) or `AgentWrapper.record_llm_call` (Python) and appears as `commit.llmCall` (camelCase in JS objects) / `llm_call` (snake in SQLite rows and wire types).

### Shape (from `@agentgit/core`)

```ts
interface LlmCall {
  id: string;                    // UUID v4
  provider: string;              // "anthropic", "vercel-ai-sdk", "openai", "langchain", ...
  model: string;                 // e.g. "claude-opus-4-7"
  messages: LlmMessage[];        // normalized prompt history
  response: string;              // joined text response
  usage: LlmUsage | null;        // token counts or null
  costEstimateUsd: number | null; // USD estimate or null
  startedAt: number;             // Unix ms
  completedAt: number | null;
  durationMs: number | null;
  status: "pending" | "success" | "error";
  error: string | null;
}

interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}
```

### Auto-capture via `wrapAgentJS({ llm })`

When the `llm` option is truthy (or left undefined and `agent.llm` is detected), the wrapper installs a thin bridge that calls `recorder.recordLlm(llmCall)` after every model invocation. The bridge is provider-specific:

- Anthropic SDK → `wrapAnthropic`
- Vercel AI SDK → `wrapAI`

See [Adapters](./adapters) for per-SDK details and the pricing helpers that populate `costEstimateUsd`.

### Manual recording

```ts
import { randomUUID } from "node:crypto";
const llmCall: LlmCall = {
  id: randomUUID(),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "Hello" }],
  response: "Hi there!",
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
  costEstimateUsd: 0.00012,
  startedAt: Date.now() - 1200,
  completedAt: Date.now(),
  durationMs: 1200,
  status: "success",
  error: null,
};
repo.recordLlmCall({ sessionId, ...llmCall }); // or via AgentGitSession
```

---

## Types

All types are re-exported from `@agentgit/sdk`:

```ts
export type { AgentLike, WrapOptions, WrappedAgent, LlmAutoCaptureOptions } from "@agentgit/sdk";
export { wrapAgentJS, createLlmRecorderBridge } from "@agentgit/sdk";
export { AgentGitSession } from "@agentgit/sdk";
```

`Guard`, `GuardResult`, `ToolCall`, `LlmCall`, `LlmUsage`, `LlmMessage`, `Repository`, and `Session` are imported from `@agentgit/core`.
