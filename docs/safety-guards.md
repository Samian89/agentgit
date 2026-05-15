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
---

## Redaction

Redaction is an opt-in privacy feature that scrubs sensitive substrings from LLM prompts/responses and (by default) tool call inputs/outputs **before** they are hashed and persisted in the content-addressed store. Redacted values are replaced by the placeholder `[REDACTED]` (configurable) and are visible in the resulting `llmCall` / `toolCall` records — the audit trail keeps structure while secrets never leave the machine in plaintext.

### Configuration

Add an `llm.redaction` block to `.agentgit/config.json`:

```json
{
  "llm": {
    "redaction": {
      "redactPatterns": ["sk-[A-Za-z0-9]{20,}", "(?i)password\\s*=\\s*\\S+"],
      "placeholder": "[REDACTED]",
      "includeToolCalls": true
    }
  }
}
```

- `redactPatterns`: array of ECMAScript regex *source strings* (no `/.../g` delimiters). Each is compiled with the global flag and applied in order.
- `placeholder`: defaults to `"[REDACTED]"`.
- `includeToolCalls`: when `false`, tool call `input`/`output`/`error` are left untouched (LLM fields are always redacted if patterns are set). Default `true`.
- `enabled`: set to `false` to disable even if patterns are present (rare).

Invalid regex syntax (e.g. `"[unclosed"`) causes `Repository.init` (and the first `AgentWrapper` record in Python) to throw immediately with the offending pattern in the error message.

### Fields affected

- `LlmCall.messages[].content`, `LlmCall.response`, `LlmCall.error`
- `ToolCall.input` (JSON-serialized, redacted, re-parsed), `ToolCall.output` (string or JSON round-trip for objects/arrays), `ToolCall.error`

Redaction is applied inside `Repository.commit` / `recordLlmCall` (TS) and `_record_commit` (Python adapters + langchain) **before** the commit body is canonical-JSON-hashed. Consequently:

- `getCommit(hash)` and the on-disk object file contain only redacted text.
- The commit hash itself is computed from the redacted payload (content-addressed invariant preserved).

### Regex compatibility notes

Both implementations use the host regex engine on the exact pattern source:

- TypeScript: `new RegExp(p, "g")`
- Python: `re.compile(p)` (no extra flags)

ECMAScript-specific features (`\u{...}`, named capture groups `(? <name>...)`, lookbehind) may behave differently or be unsupported in Python's `re`. For portable cross-language redaction, prefer ASCII patterns and basic character classes. The shared test fixture in `packages/core/src/__tests__/fixtures/redacted-llm-call.json` is used by both test suites to guarantee identical canonical JSON output.

### Example: scrubbing OpenAI keys

```json
{ "llm": { "redaction": { "redactPatterns": ["(?i)sk-[A-Za-z0-9]{20,}"] } } }
```

Any occurrence of an `sk-...` key in an LLM message or response (or tool I/O) becomes `[REDACTED]` before persistence.

Redaction is independent of telemetry (which already never emits prompt/response text per the privacy contract in `telemetry/reporter.ts`).
