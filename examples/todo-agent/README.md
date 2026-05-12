# todo-agent — AgentGit Example

A minimal to-do list agent wrapped with `wrapAgentJS`, demonstrating the full
AgentGit workflow: every prompt and every tool call becomes a tamper-evident,
content-addressed commit in a local `.agentgit/` store.

## What happens when you run it

The agent processes three prompts:

1. `add: Buy groceries` → records `addTodo` + `saveTodos` tool calls
2. `add: Write unit tests` → records `addTodo` + `saveTodos` tool calls
3. `complete: 0` → records `completeTodo` + `saveTodos` tool calls

Each `run()` creates a **prompt commit** followed by **tool-call commits** (one
per intercepted `this.tool()` call), for a total of **9 commits** in one
session.  `wrapAgentJS` auto-initializes the `.agentgit/` store on first run —
no `agentgit init` required.

## Quickstart

### 1. Build the monorepo (from the repo root)

```bash
pnpm install
pnpm build
```

### 2. Run the agent

```bash
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

The last two lines are printed with the real hash values — copy and paste them
directly to run the next steps.

### 3. Inspect the commit log

```bash
pnpm exec agentgit log
```

Expected output (9 entries, most recent first; your hashes will differ):

```
<hash>  <timestamp>  [todo-session]
    Tool: saveTodos
    tool: saveTodos (success)

<hash>  <timestamp>  [todo-session]
    Tool: completeTodo
    tool: completeTodo (success)

<hash>  <timestamp>  [todo-session]
    Prompt: complete: 0

<hash>  <timestamp>  [todo-session]
    Tool: saveTodos
    tool: saveTodos (success)

<hash>  <timestamp>  [todo-session]
    Tool: addTodo
    tool: addTodo (success)

<hash>  <timestamp>  [todo-session]
    Prompt: add: Write unit tests

<hash>  <timestamp>  [todo-session]
    Tool: saveTodos
    tool: saveTodos (success)

<hash>  <timestamp>  [todo-session]
    Tool: addTodo
    tool: addTodo (success)

<hash>  <timestamp>  [todo-session]
    Prompt: add: Buy groceries
```

### 4. Diff commit 1 vs commit 3

Use the `diff` command printed at the end of `node run-agent.js`, or copy the
first and third hashes from `agentgit log` yourself:

```bash
pnpm exec agentgit diff <hash-of-log-entry-1> <hash-of-log-entry-3>
```

Expected output:

```
diff <hash1-short>..<hash3-short>
+++ prompt.txt (new, 11 bytes)
```

Commit 1 (the most-recent `saveTodos`) has an empty tree; commit 3 (`Prompt:
complete: 0`) carries `prompt.txt`.  The diff shows the file appearing — proof
that AgentGit captured the state change between those two steps.

## How it works

```js
const wrapped = wrapAgentJS(agent, {
  repoDir: ".agentgit",   // auto-created on first run
  sessionName: "todo-session",
});
```

`wrapAgentJS` returns a `Proxy` around the agent.  When you call
`wrapped.run(prompt)`:

1. A **prompt commit** is recorded (tree contains `prompt.txt`).
2. `run()` executes with `this` bound to the proxy, so every
   `this.addTodo(...)` / `this.saveTodos()` call is also intercepted.
3. Each intercepted method runs as a **tool-call commit** chained to the
   previous one via its `parent` hash, forming a verifiable DAG.

```
Prompt: add: Buy groceries      ← commit 1  (prompt.txt in tree)
  └── Tool: addTodo             ← commit 2  (empty tree, toolCall recorded)
      └── Tool: saveTodos       ← commit 3  (empty tree, toolCall recorded)
          └── Prompt: add: Write unit tests  ← commit 4  ...
```

## Files

| File | Purpose |
|------|---------|
| `run-agent.js` | Agent definition + `wrapAgentJS` invocation |
| `.gitignore` | Excludes `.agentgit/`, `todos.json`, `node_modules/` from version control |
| `.agentgit/` | Created at runtime — content-addressed object store + SQLite index |
| `todos.json` | Created at runtime — written by `saveTodos` on each run |
