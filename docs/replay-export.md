# Replay Export

`agentgit export <session>` emits a self-contained JSON document that captures every commit in a session together with its tool calls and state snapshot manifests.

## Producing an export

```bash
# Write to stdout
agentgit export my-session

# Save to a file
agentgit export my-session > session.json

# Inspect with jq
agentgit export my-session | jq '.commits | length'
```

---

## `ReplayExport` schema

```ts
interface ReplayExport {
  /** Schema version. Always "1". */
  version: "1";

  /** UUID of the exported session. */
  sessionId: string;

  /** Human-readable session name. */
  sessionName: string;

  /** Unix epoch milliseconds when the export was generated. */
  exportedAt: number;

  /** Commits in chronological order (oldest first). */
  commits: ReplayCommit[];
}
```

### `ReplayCommit`

```ts
interface ReplayCommit {
  /** SHA-256 hex digest of the commit object (64 lowercase chars). */
  hash: string;

  /** Unix epoch milliseconds when this commit was recorded. */
  timestamp: number;

  /** Human-readable summary (e.g. "Prompt: ..." or "Tool: ..."). */
  message: string;

  /** Tool call recorded in this commit, or null for prompt-only commits. */
  toolCall: ToolCall | null;

  /** Manifest of blob objects in the commit's state tree. */
  stateSnapshot: ReplayStateEntry[];
}
```

### `ReplayStateEntry`

```ts
interface ReplayStateEntry {
  /** Logical path within the agent's state namespace (e.g. "prompt.txt"). */
  path: string;

  /** SHA-256 hash of the Blob object for this file. */
  blobHash: string;

  /** Byte size of the blob. */
  size: number;
}
```

### `ToolCall`

```ts
interface ToolCall {
  /** UUID v4 — unique identifier for this invocation. */
  id: string;

  /** Tool name as registered in the agent framework. */
  name: string;

  /** Arguments passed to the tool. */
  input: Record<string, unknown>;

  /** Return value of the tool call, or null if it failed or is pending. */
  output: unknown | null;

  /** Unix epoch milliseconds when the tool call started. */
  startedAt: number;

  /** Unix epoch milliseconds when the tool call finished, or null if pending. */
  completedAt: number | null;

  /** Execution status. */
  status: "pending" | "success" | "error";

  /** Error message if status is "error", otherwise null. */
  error: string | null;
}
```

---

## Complete example

```json
{
  "version": "1",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "sessionName": "todo-session",
  "exportedAt": 1705312900000,
  "commits": [
    {
      "hash": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      "timestamp": 1705312800000,
      "message": "Prompt: add: Buy groceries",
      "toolCall": null,
      "stateSnapshot": [
        {
          "path": "prompt.txt",
          "blobHash": "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
          "size": 19
        }
      ]
    },
    {
      "hash": "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4",
      "timestamp": 1705312800050,
      "message": "Tool: addTodo",
      "toolCall": {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "name": "addTodo",
        "input": { "task": "Buy groceries" },
        "output": { "id": 1705312800001, "task": "Buy groceries", "done": false },
        "startedAt": 1705312800020,
        "completedAt": 1705312800048,
        "status": "success",
        "error": null
      },
      "stateSnapshot": []
    },
    {
      "hash": "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
      "timestamp": 1705312800100,
      "message": "Tool: saveTodos",
      "toolCall": {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "name": "saveTodos",
        "input": {},
        "output": { "path": "/project/todos.json", "count": 1 },
        "startedAt": 1705312800055,
        "completedAt": 1705312800099,
        "status": "success",
        "error": null
      },
      "stateSnapshot": []
    }
  ]
}
```

---

## Consuming a ReplayExport

### TypeScript

```ts
import type { ReplayExport, ReplayCommit, ToolCall } from "@agentgit/cli";

const data: ReplayExport = JSON.parse(await fs.readFile("session.json", "utf-8"));

for (const commit of data.commits) {
  if (commit.toolCall) {
    console.log(`Tool: ${commit.toolCall.name} → ${commit.toolCall.status}`);
  }
}
```

### Validation with Zod

```ts
import { z } from "zod";

const ToolCallSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  input: z.record(z.unknown()),
  output: z.unknown().nullable(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  status: z.enum(["pending", "success", "error"]),
  error: z.string().nullable(),
});

const ReplayStateEntrySchema = z.object({
  path: z.string(),
  blobHash: z.string().length(64),
  size: z.number(),
});

const ReplayCommitSchema = z.object({
  hash: z.string().length(64),
  timestamp: z.number(),
  message: z.string(),
  toolCall: ToolCallSchema.nullable(),
  stateSnapshot: z.array(ReplayStateEntrySchema),
});

const ReplayExportSchema = z.object({
  version: z.literal("1"),
  sessionId: z.string().uuid(),
  sessionName: z.string(),
  exportedAt: z.number(),
  commits: z.array(ReplayCommitSchema),
});

const parsed = ReplayExportSchema.parse(JSON.parse(raw));
```

---

## Accessing blob content

The `stateSnapshot` manifest lists blob hashes but not the content. To read content, use the object store directly:

```ts
import { Repository } from "@agentgit/core";

const repo = Repository.open(".agentgit");

for (const entry of commit.stateSnapshot) {
  const blob = repo.objects.read(entry.blobHash);
  console.log(entry.path, "→", blob.content);
}
```

---

## Content-addressing guarantee

Every commit hash in the export is the SHA-256 of the commit's canonical JSON (keys sorted lexicographically, no extra whitespace). You can verify any commit's integrity independently:

```bash
# Extract a commit object from the store
cat .agentgit/objects/a1/b2c3d4e5f6... | python3 -c "
import sys, json, hashlib
data = sys.stdin.read()
h = hashlib.sha256(data.encode()).hexdigest()
print(h)
"
```

The printed hash must match the `hash` field in the commit.
