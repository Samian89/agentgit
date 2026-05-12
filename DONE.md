# AMC-024ae171 — Python Drop-In Adapter

## What was built

`adapters/python/` — a pip-installable Python package (`agentgit-adapter`) providing `wrap_agent(agent, repo_path)`, a decorator/wrapper that intercepts `__call__` on any Python agent object and records each invocation as a content-addressed commit in an AgentGit repository.

### Behaviour

`wrap_agent(agent, repo_path)` returns an `AgentWrapper` that:

| Action | What happens |
|--------|-------------|
| `wrapped_agent(*args, **kwargs)` | Opens a session if needed, calls the underlying agent, records a commit with a `ToolCall` (status=success). Returns the agent's result unchanged. |
| Underlying agent raises | Records a commit with `ToolCall` (status=error, error=str(exc)), then re-raises. |
| `wrapped.finish()` | Marks the session `completed` in SQLite. |
| `with wrap_agent(...) as a:` | Calls `finish("completed")` on normal exit, `finish("failed")` on exception. |

Each commit is content-addressed (SHA-256 of canonical JSON, keys sorted), written to `.agentgit/objects/<2>/<62>` and indexed in SQLite. If `.agentgit/` does not exist, the wrapper tries `agentgit init` via CLI and falls back to direct directory + SQLite initialization.

### ToolCall schema (matches `@agentgit/core` types.ts)

```python
{
  "completedAt": int,          # Unix ms — null if pending (never null here)
  "error": str | None,
  "id": str,                   # UUID v4
  "input": dict,               # {"args": [...]} for positional, kwarg names for keyword
  "name": str,                 # agent.name attr or class name
  "output": any | None,
  "startedAt": int,            # Unix ms
  "status": "success" | "error",
}
```

### Tests

29 pytest tests, all passing (`pytest adapters/python`), covering:
- `wrap_agent` returns an `AgentWrapper`
- Each `__call__` records exactly one commit with valid ToolCall schema
- ToolCall fields: id (UUID), name, input, output, startedAt, completedAt, status, error
- Success path records `status=success`, output, and correct message
- Error path records `status=error`, error string, null output
- Session created in SQLite with `active` status
- Sequential calls create parent-linked commit chain
- `finish()` marks session `completed`; no-op when no session open
- Context manager: `completed` on clean exit, `failed` on exception
- Agent class name used when `name` attr absent
- Identical calls produce different hashes (timestamps + parent differ)
- kwargs recorded in input dict, positional args recorded as `args` list
- Direct `.agentgit/` init when CLI unavailable
- Existing repo not re-initialised
- Empty tree hash is idempotent
- Object file sharding verified (`<2-char>/<62-char>`)

## Changed files

```
adapters/python/pyproject.toml                     (new)
adapters/python/setup.py                           (new)
adapters/python/agentgit_adapter/__init__.py       (new)
adapters/python/agentgit_adapter/adapter.py        (new)
adapters/python/tests/__init__.py                  (new)
adapters/python/tests/conftest.py                  (new)
adapters/python/tests/test_wrap_agent.py           (new)
```

## APIs consumed by downstream tickets

### Python import

```python
from agentgit_adapter import wrap_agent, AgentWrapper

# Functional style
wrapped = wrap_agent(my_agent, repo_path="/path/to/project")
result = wrapped("some query")
wrapped.finish()

# Context manager
with wrap_agent(my_agent, repo_path="/path/to/project") as agent:
    result = agent("some query")
```

### Commit object written (matches @agentgit/core)

```python
{
  "message": "tool: <name>" | "tool error: <name>",
  "metadata": {},
  "parent": str | None,
  "sessionId": str,
  "timestamp": int,
  "toolCall": { ... },    # see ToolCall schema above
  "tree": str,            # SHA-256 of empty tree
  "type": "commit",
}
```

### Install

```bash
pip install -e adapters/python
```

---

# AMC-60d00a36 — LangChain Callback Adapter

## What was built

`adapters/langchain/` — a pip-installable Python package (`agentgit-langchain`) providing `AgentGitCallbackHandler`, a LangChain `BaseCallbackHandler` that records every agent run as content-addressed commits in an AgentGit repository.

### Behaviour

| Callback | Action |
|----------|--------|
| `on_agent_action` | Opens a session (idempotent; noop if session already open) |
| `on_agent_finish` | Marks the session `completed` |
| `on_tool_start` | Captures tool name, input, and start timestamp in `_pending_tool` |
| `on_tool_end` | Writes a commit with `tool_call` (status=success) and advances `session.head` |
| `on_tool_error` | Writes a commit with `tool_call` (status=error) |
| `on_llm_start` | Captures prompts and start timestamp in `_pending_llm` |
| `on_llm_end` | Writes a commit with prompts + outputs in metadata |

Each commit is content-addressed (SHA-256 of canonical JSON, keys sorted), written to `.agentgit/objects/<2>/<62>` and inserted into the SQLite `commits` table. Sequential commits are linked via `parent` hashes. If `.agentgit/` does not exist, `agentgit init <repo_path>` is called automatically.

### Tests

18 pytest tests, all passing (`pytest adapters/langchain`), covering:
- Session open/close lifecycle
- Repeated `on_agent_action` does not duplicate sessions
- Tool start/end pairs produce exactly one commit with correct `tool_call` JSON
- Tool errors record `status=error`
- Sequential tool calls form a parent-linked chain
- LLM start/end pairs produce commits with prompt + output metadata
- Object files are written to the object store
- Commit hashes are 64-character lowercase hex
- Empty tree hash is idempotent

## Changed files

```
adapters/langchain/pyproject.toml                      (new)
adapters/langchain/agentgit_langchain/__init__.py      (new)
adapters/langchain/agentgit_langchain/handler.py       (new)
adapters/langchain/tests/__init__.py                   (new)
adapters/langchain/tests/conftest.py                   (new)
adapters/langchain/tests/test_handler.py               (new)
```

## APIs consumed by downstream tickets

### Python import

```python
from agentgit_langchain import AgentGitCallbackHandler

handler = AgentGitCallbackHandler(repo_path="/path/to/project")
# Pass handler to any LangChain agent or chain via callbacks=[handler]
```

### Commit schema written (matches @agentgit/core)

```python
# Canonical JSON fields (camelCase, sorted keys):
{
  "message": str,
  "metadata": dict,
  "parent": str | None,   # previous commit hash
  "sessionId": str,
  "timestamp": int,        # Unix ms
  "toolCall": {            # None for LLM commits
    "id": str,
    "name": str,
    "input": {"input": str},
    "output": str | None,
    "startedAt": int,
    "finishedAt": int,
    "status": "success" | "error" | "pending",
    "error": str | None,
  },
  "tree": str,             # SHA-256 of empty tree object
  "type": "commit",
}
```

---

# AMC-f2ac92a0 — Tauri Desktop UI (timeline, step cards, diffs, blame) — rev 2

## What changed this cycle (rev 2 — addressing reviewer feedback)

1. **Replaced rusqlite with `tauri-plugin-sql`**: removed all custom Rust IPC commands; Rust side now just registers the `tauri_plugin_sql` plugin. All DB queries moved to the TypeScript frontend via `@tauri-apps/plugin-sql`.
2. **Added fixture `.agentgit/index.db`**: a `pretest` script (`scripts/seed-fixture.mjs`) seeds a real SQLite file at `src/__tests__/fixtures/index.db` before every test run. Five new tests (`fixture-db.test.ts`) open and query this file with `better-sqlite3`.

## What was built

Full implementation of `packages/ui` as a Tauri 2 + React 18 + TypeScript desktop application with four main UI components. All SQLite access uses `tauri-plugin-sql` (frontend SQL via `@tauri-apps/plugin-sql`).

### Frontend (React/TypeScript)

| File | Purpose |
|------|---------|
| `src/types.ts` | `SessionRow`, `CommitRow`, `DiffEntry`, `DiffResult`, `BlameEntry`, `ToolCall` interfaces |
| `src/ipc.ts` | `getSessions`, `getCommits`, `getDiff`, `getBlame` — use `@tauri-apps/plugin-sql` Database queries |
| `src/main.tsx` | React root mount |
| `src/App.tsx` | Top-level component: DB path input, session selector, timeline, step cards, diff panel, blame panel |
| `src/App.css` | Dark-theme CSS with custom properties |
| `src/components/TimelineScrollbar.tsx` | Horizontal tick-bar, one tick per commit; left-click selects, right-click sets compare commit |
| `src/components/StepCard.tsx` | Expandable commit card; shows message, tool call name, timestamp, input/output/status/error |
| `src/components/DiffView.tsx` | Side-by-side diff using `diff-match-patch`; green for additions, red for removals |
| `src/components/BlameView.tsx` | Sticky-header table of path → last-modifying commit hash, message, timestamp |

### Rust side

`src-tauri/src/lib.rs` — registers `tauri_plugin_sql::Builder::new().build()` only; no custom commands.
`src-tauri/capabilities/default.json` — grants `sql:allow-execute`, `sql:allow-select`, `sql:allow-load`, `sql:allow-close` to the main window.
`src-tauri/Cargo.toml` — `tauri-plugin-sql = { version = "2", features = ["sqlite"] }`.

### Fixture DB

`scripts/seed-fixture.mjs` — Node.js script (run as `pretest`) that creates `src/__tests__/fixtures/index.db` with one session, two parent-linked commits, and corresponding tree entries / blobs using `better-sqlite3` directly.

### Build infrastructure

- `vite.config.ts` — Vite + React plugin, port 1420
- `vitest.config.ts` — happy-dom environment, `better-sqlite3` externalized, setup file
- `index.html` — HTML entry point
- `src-tauri/build.rs` — calls `tauri_build::build()`
- `src-tauri/tauri.conf.json` — wired `beforeBuildCommand`/`beforeDevCommand`
- `tsconfig.json` — `jsx: react-jsx`, `moduleResolution: bundler`
- `package.json` — `@tauri-apps/plugin-sql`, `better-sqlite3` (devDep), `pretest` script

### Tests

21 Vitest tests passing (5 test files):
- `fixture-db.test.ts` — 5 tests (file exists, sessions queryable, commits queryable, parent-linked, tree_entries linked)
- `TimelineScrollbar.test.tsx` — 4 tests
- `StepCard.test.tsx` — 5 tests
- `DiffView.test.tsx` — 3 tests
- `BlameView.test.tsx` — 4 tests

## Changed files (this cycle)

```
packages/ui/package.json                           (updated — added @tauri-apps/plugin-sql, better-sqlite3, pretest script)
packages/ui/vitest.config.ts                       (updated — server.deps.external for better-sqlite3)
packages/ui/scripts/seed-fixture.mjs               (new — fixture DB seed script)
packages/ui/src/ipc.ts                             (replaced — @tauri-apps/plugin-sql instead of invoke)
packages/ui/src/__tests__/setup.ts                 (updated — mock @tauri-apps/plugin-sql)
packages/ui/src/__tests__/fixture-db.test.ts       (new — 5 real-DB tests)
packages/ui/src-tauri/Cargo.toml                   (updated — tauri-plugin-sql replaces rusqlite)
packages/ui/src-tauri/src/lib.rs                   (replaced — plugin registration only)
packages/ui/src-tauri/capabilities/default.json    (new — SQL permissions)
```

## APIs consumed by downstream tickets

### Frontend DB access (via `@tauri-apps/plugin-sql`)

```ts
// src/ipc.ts — same public signatures as before
getSessions(dbPath: string): Promise<SessionRow[]>
getCommits(dbPath: string, sessionId: string): Promise<CommitRow[]>
getDiff(dbPath: string, hash1: string, hash2: string): Promise<DiffResult>
getBlame(dbPath: string, sessionId: string): Promise<BlameEntry[]>
```

### TypeScript types (`packages/ui/src/types.ts`)

```ts
interface SessionRow { id, name, status, head, created_at, updated_at, metadata }
interface CommitRow { hash, tree, parent, session_id, timestamp, message, tool_call, metadata }
interface DiffEntry { path, from_hash, to_hash }
interface DiffResult { hash1, hash2, commit1_tool_call, commit2_tool_call, added, removed, modified }
interface BlameEntry { path, commit_hash, timestamp, message }
interface ToolCall { id, name, input, output, started_at, completed_at, status, error }
```
