# Safety Guards

Safety guards intercept tool calls before execution. They can **block** destructive operations or **snapshot** files before writes so every change is reversible.

Guards are composable: register multiple guards in a pipeline; the first blocking guard stops execution. All snapshot hashes from passing guards are surfaced in the commit.

---

## Guard interface

Implement the `Guard` interface to create a custom guard:

```ts
import type { Guard, GuardContext, GuardResult } from "@agentgit/core";

interface Guard {
  readonly name: string;
  check(context: GuardContext): Promise<GuardResult>;
}

interface GuardContext {
  toolCall: ToolCall;
  objectStore?: ObjectStore;
}

interface GuardResult {
  outcome: "allow" | "block";
  reason?: string;            // human-readable message shown when blocked
  snapshotHash?: string;      // blob hash of pre-write snapshot
}
```

---

## Built-in guards

### `ConfirmationGuard`

Blocks tool calls whose names appear on a configurable destructive-tools list and prompts the user for confirmation via stdin.

**Default destructive tools:** `deleteFile`, `rm`, `shell`

#### Usage

```ts
import { ConfirmationGuard } from "@agentgit/core";

const guard = new ConfirmationGuard({
  destructiveTools: ["deleteFile", "rm", "shell", "exec"],
});
```

#### Options

```ts
interface ConfirmationGuardOptions {
  /** Tool names to treat as destructive. Defaults to ["deleteFile", "rm", "shell"]. */
  destructiveTools?: string[];

  /**
   * Injectable prompt function.
   * Defaults to readline on stdin/stdout.
   * Override in tests or CI to avoid blocking on user input.
   */
  promptFn?: (message: string) => Promise<string>;
}
```

#### Behaviour

When a tool call matches a destructive tool name:

1. The guard prints: `Guard: "<tool>" is a destructive tool call. Proceed? [y/N]`
2. If the user types `y` (case-insensitive) → `outcome: "allow"`
3. Any other input → `outcome: "block"`, throwing an error in the SDK

#### Testing with a custom `promptFn`

```ts
const guard = new ConfirmationGuard({
  promptFn: async () => "y",   // always allow in tests
});
```

---

### `SnapshotGuard`

Reads the current content of a file before any write-tool call and stores it as a blob in the object store. The blob hash is attached to the commit's metadata under `snapshotHash`, enabling point-in-time recovery.

**Default write tools:** `writeFile`, `write_file`, `editFile`, `edit_file`, `createFile`, `create_file`

#### Usage

```ts
import { SnapshotGuard } from "@agentgit/core";
import { Repository } from "@agentgit/core";

const repo = Repository.init(".agentgit");

const guard = new SnapshotGuard({
  objectStore: repo.objects,
  writeTools: ["writeFile", "edit_file"],
});
```

#### Options

```ts
interface SnapshotGuardOptions {
  /** The ObjectStore to write snapshot blobs into. */
  objectStore: ObjectStore;

  /** Tool names that mutate files. Defaults to common write-file names. */
  writeTools?: string[];

  /**
   * Injectable file reader.
   * Defaults to fs.readFile.
   * Override in tests to avoid touching the filesystem.
   */
  readFileFn?: (path: string) => Promise<string | null>;
}
```

#### Path extraction

The guard extracts the target file path from the tool call's `input` object by checking these keys in order: `path`, `filePath`, `file_path`, `filename`.

If no path is found, or the file does not yet exist, the guard allows the call without snapshotting.

#### Recovering a snapshot

```ts
const blob = repo.objects.read(snapshotHash);
// blob.content contains the pre-write file content
```

---

## Using guards with `wrapAgentJS`

```ts
import { wrapAgentJS } from "@agentgit/sdk";
import { ConfirmationGuard, SnapshotGuard, Repository } from "@agentgit/core";

const repo = Repository.init(".agentgit");

const wrapped = wrapAgentJS(agent, {
  repoDir: ".agentgit",
  guards: [
    new ConfirmationGuard(),
    new SnapshotGuard({ objectStore: repo.objects }),
  ],
});
```

---

## Using guards with `AgentGitSession`

```ts
import { AgentGitSession } from "@agentgit/sdk";
import { ConfirmationGuard } from "@agentgit/core";

const session = AgentGitSession.create(".agentgit", "guarded-session", {}, [
  new ConfirmationGuard({ destructiveTools: ["rm"] }),
]);

const toolCall = { id: "...", name: "rm", input: { path: "/tmp/data" }, ... };
const result = await session.runGuards(toolCall);

if (result.outcome === "block") {
  console.log("Blocked:", result.reason);
} else {
  // execute the tool and record the commit
  session.recordToolCall({ ...toolCall, status: "success", output: null });
}
```

---

## Loading guards from `.agentgit/config.json`

Create `.agentgit/config.json` to configure guards declaratively:

```json
{
  "confirmationGuard": {
    "enabled": true,
    "destructiveTools": ["deleteFile", "rm", "shell", "exec", "bash"]
  },
  "snapshotGuard": {
    "enabled": true,
    "writeTools": ["writeFile", "edit_file", "createFile"]
  }
}
```

Load at runtime:

```ts
import { loadGuardsFromFile } from "@agentgit/core";
import { Repository } from "@agentgit/core";

const repo = Repository.init(".agentgit");
const registry = loadGuardsFromFile(".agentgit", repo.objects);
```

Or load from an explicit config object:

```ts
import { loadGuards } from "@agentgit/core";

const registry = loadGuards(
  {
    confirmationGuard: { enabled: true, destructiveTools: ["rm"] },
    snapshotGuard: { enabled: true },
  },
  repo.objects,
);
```

### `GuardConfig` schema

```ts
interface GuardConfig {
  confirmationGuard?: {
    enabled?: boolean;                 // default: true
    destructiveTools?: string[];       // default: ["deleteFile", "rm", "shell"]
  };
  snapshotGuard?: {
    enabled?: boolean;                 // default: true
    writeTools?: string[];             // default: common write-file names
  };
}
```

---

## Writing a custom guard

```ts
import type { Guard, GuardContext, GuardResult } from "@agentgit/core";

export class RateLimitGuard implements Guard {
  readonly name = "RateLimitGuard";
  private callCount = 0;

  constructor(private readonly maxCalls: number) {}

  async check(context: GuardContext): Promise<GuardResult> {
    this.callCount++;
    if (this.callCount > this.maxCalls) {
      return {
        outcome: "block",
        reason: `Rate limit exceeded: ${this.callCount} > ${this.maxCalls}`,
      };
    }
    return { outcome: "allow" };
  }
}
```

Pass it alongside built-in guards:

```ts
const wrapped = wrapAgentJS(agent, {
  guards: [new ConfirmationGuard(), new RateLimitGuard(100)],
});
```
