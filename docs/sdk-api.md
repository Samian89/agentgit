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

Wraps any agent object so that every tool call is intercepted, guarded, and recorded as a content-addressed commit.

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
  guards?: Guard[];
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

## Types

All types are re-exported from `@agentgit/sdk`:

```ts
export type { AgentLike, WrapOptions, WrappedAgent } from "@agentgit/sdk";
export { wrapAgentJS } from "@agentgit/sdk";
export { AgentGitSession } from "@agentgit/sdk";
```

`Guard`, `GuardResult`, `ToolCall`, `Repository`, and `Session` are imported from `@agentgit/core`.
