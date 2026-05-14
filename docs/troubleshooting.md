# Troubleshooting

Common operational failure modes for the local `.agentgit/` store. Each
section includes a way to reproduce the failure and a fix that matches the
current implementation.

[[toc]]

## SQLite Locking

### Symptom

`agentgit log`, `agentgit migrate`, or a wrapped agent exits with:

```text
SqliteError: database is locked
```

or `.agentgit/index.db-wal` keeps growing while another process appears idle.

### Repro

Hold an exclusive SQLite write lock in one terminal:

```bash
node -e "
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));
const db = new Database('.agentgit/index.db');
db.exec('BEGIN EXCLUSIVE');
console.log('holding lock on pid', process.pid);
setInterval(() => {}, 5000);
"
```

Then run a command that opens the index in another terminal:

```bash
agentgit migrate --check
```

### Fix

AgentGit uses SQLite WAL mode. WAL allows concurrent readers, but there is
still only one writer. First stop the process holding the lock; do not delete
`index.db`, `index.db-wal`, or `index.db-shm` while a Node process, CLI command,
or UI has the DB open.

Checkpoint the WAL and verify the DB with the same `better-sqlite3` dependency
AgentGit uses:

```bash
node -e "
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));
const db = new Database('.agentgit/index.db');
console.log(db.pragma('wal_checkpoint(TRUNCATE)'));
console.log('integrity:', db.pragma('integrity_check', { simple: true }));
db.close();
"
```

If the repository lives in Dropbox, OneDrive, iCloud Drive, or a network share,
move it to a local non-synced directory. Those tools can keep file locks open
long enough to make WAL recovery look stuck.

## Corrupted Store Or Index

### Symptom

The index refers to an object that is missing or damaged:

```text
Error: Object not found: 3af4e1...
```

or `index.db` itself fails `PRAGMA integrity_check`.

### Repro

Delete one real object file from a disposable repo:

```bash
HASH=<64-char-hash-from-agentgit-log>
rm ".agentgit/objects/${HASH:0:2}/${HASH:2}"
agentgit checkout "$HASH"
```

`agentgit log` may still work because it reads SQLite rows, while `checkout`,
`verify`, or `replay` fails when it needs the object file.

### Fix

Start with a byte-for-byte backup:

```bash
cp -a .agentgit ".agentgit.bak.$(date +%s)"
```

On Windows PowerShell:

```powershell
Copy-Item -Recurse -Force .agentgit ".agentgit.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
```

Then run a read-only verifier. It recomputes every object filename from the
canonical JSON body and also reports DB rows that point at missing files.

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));

const NON_CONTENT_FIELDS = new Set(['hash', 'signature', 'publicKey']);
function stripTopLevel(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = {};
  for (const [k, value] of Object.entries(v)) {
    if (!NON_CONTENT_FIELDS.has(k)) out[k] = value;
  }
  return out;
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue(v[k]);
    }
    return out;
  }
  return v;
}
function digest(v) {
  return crypto.createHash('sha256').update(JSON.stringify(sortValue(stripTopLevel(v))), 'utf8').digest('hex');
}
function objectPath(hash) {
  return path.join('.agentgit', 'objects', hash.slice(0, 2), hash.slice(2));
}

let bad = 0;
for (const shard of fs.readdirSync(path.join('.agentgit', 'objects'))) {
  const dir = path.join('.agentgit', 'objects', shard);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const file of fs.readdirSync(dir)) {
    const expected = shard + file;
    const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const actual = digest(body);
    if (actual !== expected) {
      console.log('HASH MISMATCH', expected, 'actual', actual);
      bad++;
    }
  }
}

const db = new Database('.agentgit/index.db', { readonly: true });
const wanted = new Set();
for (const r of db.prepare('SELECT hash FROM commits').all()) wanted.add(r.hash);
for (const r of db.prepare('SELECT DISTINCT tree FROM commits').all()) wanted.add(r.tree);
for (const r of db.prepare('SELECT DISTINCT blob_hash FROM tree_entries').all()) wanted.add(r.blob_hash);
for (const h of wanted) {
  if (!fs.existsSync(objectPath(h))) {
    console.log('MISSING OBJECT', h);
    bad++;
  }
}
console.log(bad ? bad + ' problem(s)' : 'object store matches index');
db.close();
"
```

Restore missing or mismatched object files from a backup or from another copy of
the same content-addressed store. Do not edit an object JSON file to make it
match its filename; the correct fix is to restore the exact bytes for that
hash.

If `index.db` is corrupt but the object store is intact, AgentGit cannot
rebuild the index today. `agentgit fsck` is planned, but it has not shipped.
Restore the whole `.agentgit/` directory from backup when you need queryable
history back.

If there is no usable backup and you only need to continue with new sessions,
rotate the entire store out of the way and initialize a fresh one. Do not move
only `index.db*` aside while leaving the old `objects/` and `refs/` in place:
that creates a mixed store where refs and object files are disconnected from
the new empty index.

```bash
mv .agentgit ".agentgit.corrupt.$(date +%s)"
agentgit init .
```

On Windows PowerShell:

```powershell
Rename-Item .agentgit ".agentgit.corrupt.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
agentgit init .
```

The rotated directory preserves the old bytes for later analysis, but old
sessions will not appear in `agentgit log` until a future reindex/fsck tool
exists.

## Symlinks

### Symptom

A recorded snapshot contains the bytes of a symlink target, or a checkout JSON
file contains ordinary blob content but no symlink metadata.

### Repro

```bash
mkdir -p workspace
printf 'TOKEN=example\n' > /tmp/agentgit-real-env
ln -s /tmp/agentgit-real-env workspace/.env
```

Now record `workspace/.env` as a `stateEntries` item or pass it to a write tool
that triggers `SnapshotGuard`. Node's `fs.readFile` and Python's `open()` follow
the symlink by default, so the blob contains `TOKEN=example`, not "this was a
symlink to `/tmp/agentgit-real-env`".

### Fix

AgentGit trees are flat `(path, blobHash, size)` lists. They do not model
symlinks, permissions, or device files. Choose the behavior before recording:

- To record target bytes, resolve the symlink and pass the file content as a
  normal state entry.
- To preserve the fact that it was a symlink, exclude it from `stateEntries`
  and record the pointer in commit metadata:

  ```ts
  repo.commit({
    sessionId,
    message: "snapshot",
    stateEntries: realFilesOnly,
    metadata: { symlinks: { "workspace/.env": "/tmp/agentgit-real-env" } },
  });
  ```

- For autonomous filesystem walkers, reject symlinks whose real path escapes
  the workspace root.

## Large Blobs

### Symptom

`.agentgit/objects/` grows by hundreds of MB or GB after a short run, and
checkout/export becomes slow.

### Repro

Record a changing 500 MB file on every step:

```ts
for (const chunk of chunks) {
  await wrapped.process(chunk);
  session.recordToolCall(toolCall, [
    { path: "data.csv", content: currentCsv, encoding: "utf-8" },
  ]);
}
```

Every changed content body gets a new blob object. Base64 content is also about
33 percent larger than the raw bytes.

### Fix

There is no global large-blob cutoff today. `SnapshotGuard` has a configurable
`maxBlobBytes`, but the default is unlimited.

Prefer metadata references for large mutable artifacts:

```ts
repo.commit({
  sessionId,
  message: "process dataset",
  stateEntries: [],
  metadata: { inputFile: path.resolve("./data/large-input.csv") },
});
```

If a large file must be tracked, keep the content stable across commits so
content-addressing deduplicates it. Reusing the same `stateEntries` content
writes the blob once; changing one byte creates a new blob.

Chunked blob storage and first-class `agentgit gc` are planned. Until then,
use the size-management workflow below after exporting sessions you need to
archive.

## Windows Path Length

### Symptom

On Windows:

```text
Error: ENAMETOOLONG: name too long, open 'C:\...\ .agentgit\objects\3a\f4e1...'
```

### Repro

Create a project under a very deep path, then run a wrapped agent that writes
objects:

```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\you\OneDrive\Documents\projects\very-deep-monorepo\packages\my-agent\workspace"
Set-Location "C:\Users\you\OneDrive\Documents\projects\very-deep-monorepo\packages\my-agent\workspace"
agentgit init
node your-agent.js
```

Object paths add `.agentgit\objects\<2>\<62>` to the project path, so a parent
directory near the 260-character Win32 limit can fail.

### Fix

Use the shortest repo path your workflow allows:

```powershell
Move-Item "C:\Users\you\OneDrive\Documents\projects\very-deep-monorepo" C:\code\agent
```

Or place the AgentGit store near the drive root:

```ts
const wrapped = wrapAgentJS(agent, { repoDir: "C:\\agentgit\\my-project" });
```

For systems you control, enable Windows long paths and use a recent Node.js
build. When calling low-level Windows tools directly, the extended path prefix
can also help:

```text
\\?\C:\very\long\path\to\.agentgit
```

## `.agentgit/` Size Management

### Symptom

`du -sh .agentgit` is much larger than expected, or CI runners run out of disk
after repeated sessions.

### Repro

```bash
du -sh .agentgit
find .agentgit/objects -type f | wc -l
```

Many small commits can cost more than their JSON size because every commit,
tree, and blob is its own filesystem object.

### Fix

There is no supported partial prune command today. `agentgit gc` is planned,
but until it ships the safe fix is to inventory the store, export what matters,
and rotate whole stores rather than deleting selected rows from SQLite.

Inventory sessions and object count with read-only commands:

```bash
node -e "
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));
const db = new Database('.agentgit/index.db', { readonly: true });
for (const r of db.prepare(
  'SELECT s.id, s.name, s.status, COUNT(c.hash) AS commits ' +
  'FROM sessions s LEFT JOIN commits c ON c.session_id = s.id ' +
  'GROUP BY s.id ORDER BY commits DESC LIMIT 20'
).all()) console.log(r);
db.close();
"

node -e "
const fs = require('fs');
const path = require('path');
const root = path.join('.agentgit', 'objects');
let files = 0;
let bytes = 0;
if (fs.existsSync(root)) {
  for (const shard of fs.readdirSync(root)) {
    const dir = path.join(root, shard);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      const p = path.join(dir, file);
      const st = fs.statSync(p);
      if (st.isFile()) {
        files++;
        bytes += st.size;
      }
    }
  }
}
console.log({ objectFiles: files, objectBytes: bytes });
"
```

Export important sessions before reclaiming space:

```bash
mkdir -p archive
agentgit export <session-name-or-id> > archive/<session-name>.json
```

For CI or disposable local history, rotate the whole store and reinitialize:

```bash
mv .agentgit ".agentgit.archive.$(date +%s)"
agentgit init .
```

On Windows PowerShell:

```powershell
Rename-Item .agentgit ".agentgit.archive.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
agentgit init .
```

After you have verified the exported sessions, move the rotated archive to
external storage or let the CI workspace cleanup remove it. Reclaim space at
the directory level; avoid deleting selected object shards or SQLite rows by
hand.

For a long-lived repository, keep the existing store and wait for first-class
`agentgit gc` instead of running ad hoc SQL. The schema has two important traps:

- `tree_entries.tree_hash` is not a foreign key, so deleting commits or
  sessions does not automatically delete stale tree-entry projections.
- `blobs` rows and blob object files may stay referenced by surviving
  `tree_entries` rows even after the session that originally wrote them is
  gone.

Those details are why the planned `gc` command must compute reachability across
refs, session heads, commits, trees, and blobs before it moves any object file.
