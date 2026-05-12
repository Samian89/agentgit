# CLI Reference

The `agentgit` CLI provides seven subcommands modelled after Git's workflow.

## Global usage

```
agentgit [command] [options]
```

Run `agentgit --help` or `agentgit <command> --help` for inline help.

---

## `agentgit init [dir]`

Initialize a new `.agentgit/` repository.

**Arguments**

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `dir` | no | current directory | Directory in which to create `.agentgit/` |

**What it creates**

```
<dir>/
└── .agentgit/
    ├── index.db        # SQLite metadata index
    ├── objects/        # content-addressed object store
    └── HEAD            # ref: refs/sessions/main
```

**Output**

```bash
$ agentgit init
Initialized empty AgentGit repository in /your/project/.agentgit

$ agentgit init          # run again in the same directory
Reinitialized existing AgentGit repository in /your/project/.agentgit
```

**Notes**

- Safe to run more than once (idempotent).
- `HEAD` is initialized to `ref: refs/sessions/main` and is not overwritten on reinit.

---

## `agentgit log`

List commits in reverse chronological order.

**Options**

| Flag | Description |
|------|-------------|
| `-s, --session <id>` | Filter output to a single session by ID or name |

**Output format** (ANSI-coloured in a terminal)

```
<hash-short>  <ISO-timestamp>  [<session-name>]
    <commit-message>
    tool: <tool-name> (<status>)     ← only for tool-call commits
```

**Examples**

```bash
# Show all commits across all sessions
agentgit log

# Show commits for a named session
agentgit log --session my-session

# Show commits for a session by UUID
agentgit log --session f47ac10b-58cc-4372-a567-0e02b2c3d479
```

---

## `agentgit diff <hash1> <hash2>`

Show a step-level diff between two commits.

**Arguments**

| Argument | Required | Description |
|----------|----------|-------------|
| `hash1` | yes | Source commit hash (full or prefix) |
| `hash2` | yes | Target commit hash (full or prefix) |

**Output format**

```
diff <hash1-short>..<hash2-short>
--- <path>  (<size> bytes)    ← file present in hash1 but removed in hash2
+++ <path> (new, <size> bytes) ← file added in hash2
~~~ <path>  (<old-size> → <new-size> bytes) ← file changed
```

**Example**

```bash
agentgit diff a1b2c3d4 e5f6a7b8
```

---

## `agentgit branch <name> <commitHash>`

Create a named branch pointing to an existing commit.

**Arguments**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Branch name (e.g. `experiment-1`) |
| `commitHash` | yes | Full commit hash to point the branch at |

**Output**

```bash
$ agentgit branch experiment-1 a1b2c3d4e5f6...
Branch 'experiment-1' created at a1b2c3d4
```

**Notes**

- Branches are stored as refs under `.agentgit/refs/`.
- There is currently no `agentgit branch --list` command; use the SQLite index directly for listing.

---

## `agentgit checkout <hash>`

Restore the agent state snapshot at a commit to `.agentgit/CHECKOUT`.

**Arguments**

| Argument | Required | Description |
|----------|----------|-------------|
| `hash` | yes | Commit hash to check out |

**Output**

```bash
$ agentgit checkout a1b2c3d4e5f6...
HEAD is now at a1b2c3d4 Prompt: add: Buy groceries
Snapshot written to /your/project/.agentgit/CHECKOUT
```

**CHECKOUT file format**

```json
{
  "commitHash": "<full-hash>",
  "timestamp": 1705312800000,
  "message": "Prompt: add: Buy groceries",
  "files": [
    {
      "path": "prompt.txt",
      "blobHash": "<hash>",
      "size": 19,
      "content": "add: Buy groceries",
      "encoding": "utf-8"
    }
  ]
}
```

---

## `agentgit replay <session>`

Print all recorded tool calls for a session in chronological order.

**Arguments**

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | yes | Session ID (UUID) or session name |

**Output**

```
Replaying session: my-session (<uuid>)
Total steps: 9

Step 1/9: Prompt: add: Buy groceries

Step 2/9: Tool: addTodo
  Tool: addTodo
  Input: {
    "task": "Buy groceries"
  }
  Output: {"id":1705312800001,"task":"Buy groceries","done":false}
  Status: success
...
```

---

## `agentgit export <session>`

Export a session as a [ReplayExport](./replay-export) JSON document to stdout.

**Arguments**

| Argument | Required | Description |
|----------|----------|-------------|
| `session` | yes | Session ID (UUID) or session name |

**Example**

```bash
# Write to a file
agentgit export my-session > session.json

# Pipe to jq for inspection
agentgit export my-session | jq '.commits | length'
```

**Output** — see [Replay Export](./replay-export) for the full schema.

```json
{
  "version": "1",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "sessionName": "my-session",
  "exportedAt": 1705312800000,
  "commits": [ ... ]
}
```
