# AMC-a78f8560 — Core Data Model & Storage Schemas

## What was built

Two files defining the complete AgentGit data model and SQLite storage schema:

### `packages/core/src/types.ts`
TypeScript interfaces for every domain object:
- **`Blob`** — content unit (base64 or utf-8 encoded raw bytes, SHA-256 addressed)
- **`Tree` / `TreeEntry`** — snapshot of agent state as a path→blob mapping
- **`ToolCall`** — single tool invocation with input, output, status, and timing
- **`Commit`** — one agent step: links tree, parent, session, toolCall, and metadata
- **`Ref`** — named pointer (branch/tag/session-head) to a commit hash
- **`Session`** — full agent run with lifecycle status and head pointer
- **`StepDiff` / `DiffEntry`** — diff between two commits (added/removed/modified paths)
- **`Hash`, `Timestamp`** — primitive type aliases for clarity

The top-of-file JSDoc block documents:
- The content-addressing algorithm (SHA-256 of canonical JSON with sorted keys)
- The `.agentgit/` directory layout (`HEAD`, `refs/`, `objects/`, `index.db`)

### `packages/core/src/schema.sql`
SQLite DDL consumed by `packages/core` at `agentgit init` time:
- **`sessions`** — session lifecycle, head commit FK, JSON metadata
- **`commits`** — commit graph (parent self-FK), session FK, JSON tool_call column
- **`blobs`** — existence/size index (content lives in object files, not here)
- **`refs`** — named pointers with type constraint
- **`tree_entries`** — denormalised path index for fast blob→path lookups

All tables use `IF NOT EXISTS`; foreign keys and WAL mode are enabled.

## Changed files

| File | Status |
|------|--------|
| `packages/core/src/types.ts` | Created |
| `packages/core/src/schema.sql` | Created |

## APIs / types other tickets may consume

All exports from `packages/core/src/types.ts`:

```typescript
// Primitive aliases
Hash          // string — 64-char lowercase SHA-256 hex
Timestamp     // number — Unix epoch milliseconds

// Object interfaces
Blob
TreeEntry
Tree
ToolCall      // ToolCallStatus = "pending" | "success" | "error"
Commit
Ref           // RefType = "branch" | "tag" | "session-head"
Session       // SessionStatus = "active" | "completed" | "failed" | "abandoned"
DiffEntry
StepDiff
```

SQL table names for downstream packages that open `index.db` directly:
`sessions`, `commits`, `blobs`, `refs`, `tree_entries`
