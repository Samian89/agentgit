# Architecture

AgentGit is a content-addressed, append-only commit log for AI-agent sessions.
Everything an agent does — the prompt, every tool call, every state mutation —
is recorded as an immutable object addressed by the SHA-256 of its canonical
JSON. A SQLite index sits beside the object store and answers `log` / `diff` /
`blame` queries without deserialising the object files.

This page covers the on-disk layout, the relational index, the request flow
through `wrapAgentJS`, and the invariants the implementation relies on.

> All diagrams on this page are plain text, not Mermaid, so they render
> correctly in VitePress (which has no Mermaid plugin enabled), on GitHub, and
> in any other Markdown viewer.

## On-disk layout

A repository lives under `.agentgit/` next to your project. It is a single
directory; there is no daemon and no server.

```
.agentgit/
├── HEAD                 # created by init; "ref: refs/sessions/main" or a hash
├── config.json          # user identity + optional signing keys
├── index.db             # SQLite metadata index (WAL mode)
├── index.db-wal         # write-ahead log (transient)
├── index.db-shm         # shared-memory file (transient)
├── refs/
│   └── sessions/
│       └── <branch-name> # written by `agentgit branch`; contains a commit hash
└── objects/
    ├── 3a/
    │   └── f4e1...b9    # commit, tree, or blob — sharded by first 2 hex chars
    ├── 7c/
    │   └── 8c2d...01
    └── ...
```

### Object store

Three object kinds live in `objects/`, sharded by the first two hex chars of
their hash. Each object is a single file whose content is the canonical JSON
of the object (without the `hash` / `signature` / `publicKey` fields).

```
                .agentgit/objects/
                +-------------------+
                |  3a/              |
                |    f4e1...b9   <-----  commit JSON   { tree, parent, toolCall, ... }
                |  7c/              |
                |    8c2d...01   <-----  tree   JSON   { entries: [{path, blobHash, size}, ...] }
                |  9d/              |
                |    1a2b...fe   <-----  blob   JSON   { content, size, encoding }
                +-------------------+
                          ^
                          |  hash = sha256(canonicalJson(object minus hash/signature/publicKey))
                          |
              +-----------+-----------+-----------+
              |                       |           |
           commit                   tree         blob
        (points at a            (lists one    (raw file content,
         tree + parent +         or more       base64 or utf-8)
         tool call)              blobs)
```

| Kind     | Holds                                                | Referenced by                |
| -------- | ---------------------------------------------------- | ---------------------------- |
| `blob`   | A single file's bytes (base64 or utf-8) + metadata   | `Tree.entries[].blobHash`    |
| `tree`   | A flat list of `(path, blobHash, size)` entries      | `Commit.tree`                |
| `commit` | A pointer to a tree, a parent commit, and a toolCall | `Session.head`, `Ref.target` |

Writes are idempotent — `ObjectStore.write` skips the filesystem write when the
target path already exists (`packages/core/src/object-store.ts`). This is what
makes deduplication free: two commits that produce the same state share a
single tree object, and two trees that contain the same file content share a
single blob object. Object files are written before the SQLite transaction, so
a crash can leave extra unreferenced object files; it must not leave a SQLite
row pointing at an object that was never written.

### Refs and HEAD

Refs are plain files under `refs/`. Each file contains a single commit hash;
the file name is the ref name (`sessions/main`, `sessions/feature-x`,
`tags/v1.0.0`, and so on). The top-level `HEAD` file is either the literal
string `ref: refs/sessions/<name>` (symbolic) or a bare 64-char hash
(detached).

One implementation detail matters when debugging stores: **session heads live
in SQLite first.** `agentgit init` writes `HEAD` as `ref: refs/sessions/main`,
but `Repository.commit()` advances `sessions.head`; it does not rewrite
`HEAD`, create a session ref file, or upsert a `refs` row. `agentgit branch`
is the path that writes both the file ref (`refs/sessions/<name>`) and the
matching SQLite `refs` row. `log`, `replay`, and `export` therefore use
`sessions.head` / `commits`, not `HEAD`, as the canonical session history.

## SQLite index

`index.db` is a queryable mirror of the object store. The CLI hits it for
`log`, `diff`, `branch`, and `verify`; the object store is only opened when
content is actually needed.

### Tables and columns

There are **five content tables** plus a `schema_version` housekeeping table.
Note in particular: **there is no `trees` table.** The tree object lives only
in the object store (as a JSON file under `objects/`). The `tree_entries`
table denormalises that JSON so `blob → path` lookups don't have to
deserialise the file.

```
                                     PRIMARY KEY ─── PK
                                     FOREIGN KEY ─── FK (with on-delete action)

   +-------------------------------+                  +-------------------------------+
   | sessions                      |                  | refs                          |
   +-------------------------------+                  +-------------------------------+
   | id           TEXT  PK         |                  | name         TEXT  PK         |
   | name         TEXT             |                  | target       TEXT  FK ──┐     |
   | status       TEXT  (CHECK)    |                  | type         TEXT  (CHECK)    |
   | head         TEXT  FK ──┐     |                  | updated_at   INTEGER          |
   | created_at   INTEGER    │     |                  +-------------------------------+
   | updated_at   INTEGER    │     |                                              │
   | metadata     TEXT (JSON)│     |                                              │
   +-------------------------+-----+                                              │
                      ^      │                                                    │
                      │      │ head:  ON DELETE SET NULL                          │
       session_id:    │      │                                                    │
       ON DELETE      │      v                                                    │
       CASCADE        │   +-------------------------------+                       │
                      └───| commits                       | <─── target:          │
                          +-------------------------------+      ON DELETE        │
                          | hash         TEXT  PK         | <────RESTRICT ────────┘
                          | tree         TEXT  (no FK)    | ─── points at a tree
                          | parent       TEXT  FK ──┐     |     OBJECT file in
                          | session_id   TEXT  FK   │     |     .agentgit/objects/
                          | timestamp    INTEGER    │     |     (not a SQLite row)
                          | message      TEXT       │     |
                          | tool_call    TEXT (JSON?)│    |
                          | llm_call     TEXT (JSON?)│    |   <─── added by
                          |                          │    |        migration 003
                          | metadata     TEXT (JSON)│    |
                          | author_name  TEXT?      │    |   <─── added by
                          | author_email TEXT?      │    |        migration 002
                          | signature    TEXT?      │    |
                          | public_key   TEXT?      │    |
                          +-------------------------+----+
                              ^                       │
                              └───────────────────────┘
                              parent:  ON DELETE RESTRICT  (self-reference)

**Note:** Both `tool_call` and `llm_call` (added in migration 003) are embedded JSON columns, not separate tables. The same pattern is used for `metadata`. `LlmCall` and `ToolCall` objects are serialised into these TEXT columns and round-tripped through the content-addressed object store and the SQLite index. The current `TARGET_VERSION` is 3.

   +-------------------------------+                  +-------------------------------+
   | tree_entries                  |                  | blobs                         |
   +-------------------------------+                  +-------------------------------+
   | tree_hash    TEXT  PK part    |                  | hash         TEXT  PK         |
   | path         TEXT  PK part    |                  | size         INTEGER          |
   | blob_hash    TEXT  FK ──────────────────────────>| mime_type    TEXT?            |
   | size         INTEGER          |                  | encoding     TEXT  (CHECK)    |
   +-------------------------------+                  +-------------------------------+
        │                                                       ^
        │ tree_hash has NO FK — it identifies a tree            │
        │ OBJECT in .agentgit/objects/, not a row.              │
        │                                                       │
        └───────────────────────────────────────────────────────┘
             blob_hash:  ON DELETE RESTRICT


   +-------------------------------+
   | schema_version                |   bookkeeping table — one row per applied
   +-------------------------------+   migration; the runner refuses to open a
   | version      INTEGER  PK      |   DB whose max version is higher than the
   | name         TEXT             |   build supports.
   | applied_at   INTEGER          |
   +-------------------------------+
```

### Foreign keys and what they actually enforce

Five FKs are declared in `packages/core/src/schema.sql`. Two columns that look
like FKs (`commits.tree`, `tree_entries.tree_hash`) are deliberately **not**
FKs because their referent is a file in the object store, not a SQLite row.

| Column                  | References             | On delete    | Why                                                                            |
| ----------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------ |
| `sessions.head`         | `commits.hash`         | `SET NULL`   | Losing the session-head commit shouldn't orphan the session row.               |
| `commits.parent`        | `commits.hash`         | `RESTRICT`   | Parents may not be deleted while children exist; this keeps the DAG whole.     |
| `commits.session_id`    | `sessions.id`          | `CASCADE`    | Session deletion is declared to sweep commits, but the self-referential `commits.parent` `RESTRICT` means populated sessions must be cleaned leaf-first in manual maintenance. |
| `tree_entries.blob_hash`| `blobs.hash`           | `RESTRICT`   | A referenced blob can't be garbage-collected while a tree still points at it.  |
| `refs.target`           | `commits.hash`         | `RESTRICT`   | A ref always resolves.                                                         |
| `commits.tree`          | _(none — text hash)_   | n/a          | Tree object lives in `objects/`; SQLite never sees the tree as a row.          |
| `tree_entries.tree_hash`| _(none — text hash)_   | n/a          | Same reason; this column is part of a composite PK, not an FK.                 |

- **Idempotent DDL and migrations**: migrations use `CREATE TABLE IF NOT
  EXISTS` / `CREATE INDEX IF NOT EXISTS` for the v1 schema, and the runner
  records every applied migration in `schema_version`. Re-opening an up-to-date
  DB is a no-op; opening a DB whose max version is higher than the build
  supports is refused (`packages/core/src/migrations/index.ts`).
- **WAL mode** is set at startup (see [WAL](#wal-mode-and-concurrency) below)
  and **`PRAGMA foreign_keys = ON`** is set on every connection, so the FK
  arrows above are enforced, not advisory.

## Recording a step: `wrapAgentJS`

`wrapAgentJS` wraps any object that exposes a `run(prompt)` method. Every
property access is intercepted by a `Proxy`; `run` records the prompt as a
commit, then every other method call is treated as a tool invocation, guarded,
executed, and recorded as a child commit.

```
 User              wrapAgentJS Proxy          Underlying Agent       GuardRegistry      Repository
  │                       │                          │                      │                │
  │  wrapped.run("…")     │                          │                      │                │
  ├──────────────────────>│                          │                      │                │
  │                       │  repo.commit({prompt})                                           │
  │                       ├──────────────────────────────────────────────────────────────────>│
  │                       │                          │                      │      write blob│
  │                       │                          │                      │      write tree│
  │                       │                          │                      │    write commit│
  │                       │                          │                      │      INSERT rows
  │                       │                          │                      │ update sessions.head
  │                       │  prompt commit hash                                              │
  │                       │<──────────────────────────────────────────────────────────────────┤
  │                       │  parentHash = promptCommit.hash                                  │
  │                       │                                                                  │
  │                       │  run.call(proxy, prompt)                                         │
  │                       ├─────────────────────────>│                                       │
  │                       │                          │                                       │
  │                       │                          │  this.tool({...})                     │
  │                       │<─────────────────────────┤  (trapped by Proxy.get)               │
  │                       │     guards.before(name, input)                                   │
  │                       ├──────────────────────────────────────────────>│                  │
  │                       │     allow / deny / mutated input              │                  │
  │                       │<──────────────────────────────────────────────┤                  │
  │                       │  realToolFn.apply(agent, args)                                   │
  │                       ├─────────────────────────>│                                       │
  │                       │  result                  │                                       │
  │                       │<─────────────────────────┤                                       │
  │                       │  repo.commit({toolCall, parent: prevHash})                       │
  │                       ├──────────────────────────────────────────────────────────────────>│
  │                       │                          │                      │      write objs│
  │                       │                          │                      │     INSERT row │
  │                       │                          │                      │ update sessions.head
  │                       │  tool-call commit hash                                           │
  │                       │<──────────────────────────────────────────────────────────────────┤
  │                       │  parentHash = toolCommit.hash                                    │
  │                       │  return result           │                                       │
  │                       ├─────────────────────────>│                                       │
  │  run result           │                          │                                       │
  │<──────────────────────┤<─────────────────────────┤                                       │
  │                                                                                          │
  │  wrapped.agentgit.end()                                                                  │
  ├──────────────────────>│  updateSessionStatus("completed")                                 │
  │                       ├──────────────────────────────────────────────────────────────────>│
```

Notes on the flow:

- The proxy rebinds `this` to itself before calling `run`, which is how
  internal `this.toolMethod()` calls inside `run` get trapped
  (`packages/sdk/src/wrap.ts:85-87`).
- Each commit's `parent` is the previous commit's hash, so the session forms a
  linear chain. Recording advances the SQLite `sessions.head`; explicit
  branches are separate refs created with `agentgit branch`.
- Object writes are deduplicated by the filesystem check in `ObjectStore`, so
  re-recording an identical state is essentially free.

## Invariants

The implementation leans on a small set of guarantees. If any of them break,
the audit trail loses its meaning, so they're worth stating explicitly.

### Canonical JSON

Hashes are computed over **canonical JSON**: every object's keys are sorted
lexicographically at every level, with no extra whitespace, encoded as UTF-8
(`packages/core/src/hash.ts`). The hex digest is lower-case. Two objects
with the same content and different key insertion order produce the **same**
hash, which is what makes content-addressing work across processes, machines,
and language adapters.

The Python adapter implements the same canonicalisation in
`adapters/python/agentgit_adapter/adapter.py`. If you write a new adapter,
ship a `canonicalJson` equivalent and test it against fixtures from
`packages/core/src/__tests__` — drift here is a silent corruption bug.

### Hash-field strip

Before hashing, three **top-level** fields are stripped from object records:
`hash`, `signature`, `publicKey` (`packages/core/src/hash.ts` and
`packages/core/src/object-store.ts:28-32`). Nested metadata is content and is
not filtered recursively. This means:

- A commit's `hash` is computed over the commit minus its own `hash` field, so
  the field can be attached after the digest is computed without invalidating
  it (the same trick git uses).
- Adding an Ed25519 signature later does **not** change the commit's address.
  An unsigned commit and the same commit re-signed share the same SHA-256, so
  `agentgit verify` can detach the signature, re-hash, and compare.
- `ObjectStore.write` strips the same fields before serialising to disk, so
  the on-disk JSON is the exact byte sequence that was hashed.

If you add another derived top-level field, add it to the strip-list in both
`packages/core/src/hash.ts` and `packages/core/src/object-store.ts` in
lockstep — those two lists must stay identical.

### WAL mode and concurrency

`index.db` opens with `PRAGMA journal_mode = WAL` (set in
`packages/core/src/schema.sql:12` and re-asserted by `SqliteIndex` and the
migration runner on every open). WAL gives us:

- Concurrent reads while a writer is appending — the CLI can run `agentgit
  log` while the SDK is still committing.
- Atomic metadata updates inside the SQLite transaction. Object files are
  written just before that transaction and are content-addressed/idempotent,
  so crash recovery may need to prune orphaned files but should not need to
  repair half-written rows.
- Recovery: if the process is killed mid-commit, the `-wal` and `-shm`
  sidecars are replayed or discarded on the next open.

The cost is the two sidecar files. They are safe to delete only when **no**
process has the DB open; deleting them while a connection is live can corrupt
the index. See [Troubleshooting → SQLite locking](./troubleshooting.md#sqlite-locking).

### Foreign-key enforcement

`PRAGMA foreign_keys = ON` is set on every connection. The `ON DELETE` clauses
in the schema are therefore live, not decorative — see the FK table above for
the full list and what each one guarantees.

Two details matter for maintenance scripts:

- `commits.parent` is `ON DELETE RESTRICT`, so deleting a chain of commits must
  start at leaf commits and walk backward to the root. A plain `DELETE FROM
  sessions ...` can fail on multi-commit sessions even though
  `commits.session_id` is declared `ON DELETE CASCADE`.
- `commits.tree` and `tree_entries.tree_hash` are plain text hashes, not FKs.
  Deleting commits never automatically deletes matching `tree_entries` rows or
  tree object files; GC has to sweep those projections explicitly. A manual GC
  must delete `tree_entries` whose `tree_hash` no longer appears in `commits`
  before it deletes orphaned `blobs` rows or unreferenced object files.

When you write new code that mutates rows in these tables, do it through the
`Repository` API rather than touching `SqliteIndex` directly — the repository
orders writes so the FK graph stays consistent.

## Multi-branch semantics

Branches exist as refs (see [Refs and HEAD](#refs-and-head) above), but the
per-session commit graph remains singly linked — `Commit.parent` is `Hash |
null`, not a list. "Merging" two sessions in v0.2 is therefore defined as a
cherry-pick replay: `agentgit cherry-pick <source> --onto <target>` walks the
source commit chain from the merge base forward and rewrites each step on
top of the target head, producing fresh commits with new hashes. Path-level
conflicts abort cleanly without mutating the target. The reasoning behind
this choice (versus three-way tree merges or removing branches entirely) is
captured in [ADR 001 — Merge model](./adr/001-merge-model.md).

## Where to look next

- **CLI behaviour**: [CLI reference](./cli-reference.md)
- **Wrapping agents in code**: [SDK API](./sdk-api.md), [Adapters](./adapters.md)
- **Reversibility**: [Safety guards](./safety-guards.md)
- **Architecture decisions**: [ADR 001 — Merge model](./adr/001-merge-model.md)
- **Things going wrong**: [Troubleshooting](./troubleshooting.md)
