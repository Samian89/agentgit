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
history back. If you only need to continue with new sessions, move the broken
index files aside and create an empty index:

```bash
mkdir -p .agentgit/broken-index
mv .agentgit/index.db* .agentgit/broken-index/
agentgit init .
```

Existing object files and refs remain on disk, but old sessions will not appear
in `agentgit log` until a future reindex/fsck tool exists.

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

Export important sessions first:

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

mkdir -p archive
agentgit export <session-name-or-id> > archive/<session-name>.json
```

Then use this maintenance script. It defaults to dry-run mode. The script
avoids the known trap in this schema: deleting a session directly can fail
because `commits.parent` is `ON DELETE RESTRICT`, and deleting commits does not
remove `tree_entries` because `tree_entries.tree_hash` is not a foreign key.
It deletes stale `tree_entries` before orphaned `blobs` rows, then unlinks
unreferenced object files only after the SQLite transaction has committed.

```bash
node -e "
const dryRun = true; // set false after reviewing the dry-run output
const fs = require('fs');
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));
const db = new Database('.agentgit/index.db');
db.pragma('foreign_keys = ON');

const cutoffMs = Date.now() - 7 * 86400 * 1000;
const hashRe = /^[a-f0-9]{64}$/;
const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
function objectPath(hash) {
  return path.join('.agentgit', 'objects', hash.slice(0, 2), hash.slice(2));
}
function listObjectHashes() {
  const root = path.join('.agentgit', 'objects');
  if (!fs.existsSync(root)) return [];
  const hashes = [];
  for (const shard of fs.readdirSync(root)) {
    const dir = path.join(root, shard);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) hashes.push(shard + file);
  }
  return hashes.filter((h) => hashRe.test(h));
}
function collectHashes(value, out) {
  if (typeof value === 'string') {
    if (hashRe.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectHashes(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectHashes(v, out);
  }
}
function deleteIn(table, column, values) {
  if (!values.length) return 0;
  return db.prepare('DELETE FROM ' + table + ' WHERE ' + column + ' IN (' + placeholders(values.length) + ')').run(...values).changes;
}
function commitsForSessions(ids) {
  if (!ids.length) return [];
  return db.prepare(
    'SELECT hash, tree, session_id FROM commits WHERE session_id IN (' + placeholders(ids.length) + ')'
  ).all(...ids);
}
function deletableSessionIds(candidateIds) {
  const deletable = new Set(candidateIds);
  while (deletable.size > 0) {
    const rows = commitsForSessions([...deletable]);
    if (rows.length === 0) break;
    const hashes = rows.map((r) => r.hash);
    const blocked = db.prepare(
      'SELECT DISTINCT p.session_id AS session_id FROM commits child JOIN commits p ON child.parent = p.hash ' +
      'WHERE p.hash IN (' + placeholders(hashes.length) + ') AND child.hash NOT IN (' + placeholders(hashes.length) + ')'
    ).all(...hashes, ...hashes).map((r) => r.session_id);
    const before = deletable.size;
    for (const id of blocked) deletable.delete(id);
    if (deletable.size === before) break;
  }
  return [...deletable];
}
function protectedHashesFromRemainingCommits() {
  const protectedHashes = new Set();
  for (const r of db.prepare('SELECT metadata, tool_call FROM commits').all()) {
    try { collectHashes(JSON.parse(r.metadata || '{}'), protectedHashes); } catch {}
    try { if (r.tool_call) collectHashes(JSON.parse(r.tool_call), protectedHashes); } catch {}
  }
  return protectedHashes;
}
function unreferencedObjects(protectedHashes) {
  const live = new Set(protectedHashes);
  for (const r of db.prepare('SELECT hash, tree FROM commits').all()) {
    live.add(r.hash);
    live.add(r.tree);
  }
  for (const r of db.prepare('SELECT tree_hash, blob_hash FROM tree_entries').all()) {
    live.add(r.tree_hash);
    live.add(r.blob_hash);
  }
  for (const r of db.prepare('SELECT hash FROM blobs').all()) live.add(r.hash);
  return listObjectHashes().filter((h) => !live.has(h));
}
function orphanBlobHashes(protectedHashes) {
  return db.prepare(
    'SELECT hash FROM blobs WHERE NOT EXISTS (SELECT 1 FROM tree_entries WHERE tree_entries.blob_hash = blobs.hash)'
  ).all().map((r) => r.hash).filter((h) => !protectedHashes.has(h));
}
function dryRunAnalysis(candidateIds, deletableIds, doomedRows) {
  const doomedHashes = new Set(doomedRows.map((r) => r.hash));
  const refs = doomedHashes.size
    ? db.prepare('SELECT COUNT(*) AS n FROM refs WHERE target IN (' + placeholders(doomedHashes.size) + ')').get(...doomedHashes).n
    : 0;
  const remainingCommits = doomedHashes.size
    ? db.prepare('SELECT hash, tree, metadata, tool_call FROM commits WHERE hash NOT IN (' + placeholders(doomedHashes.size) + ')').all(...doomedHashes)
    : db.prepare('SELECT hash, tree, metadata, tool_call FROM commits').all();
  const remainingTrees = new Set(remainingCommits.map((r) => r.tree));
  const staleTreeEntries = remainingTrees.size
    ? db.prepare('SELECT COUNT(*) AS n FROM tree_entries WHERE tree_hash NOT IN (' + placeholders(remainingTrees.size) + ')').get(...remainingTrees).n
    : db.prepare('SELECT COUNT(*) AS n FROM tree_entries').get().n;
  const remainingTreeEntries = remainingTrees.size
    ? db.prepare('SELECT tree_hash, blob_hash FROM tree_entries WHERE tree_hash IN (' + placeholders(remainingTrees.size) + ')').all(...remainingTrees)
    : [];
  const remainingTreeBlobs = new Set(remainingTreeEntries.map((r) => r.blob_hash));
  const protectedHashes = new Set();
  for (const r of remainingCommits) {
    try { collectHashes(JSON.parse(r.metadata || '{}'), protectedHashes); } catch {}
    try { if (r.tool_call) collectHashes(JSON.parse(r.tool_call), protectedHashes); } catch {}
  }
  const blobRows = db.prepare('SELECT hash FROM blobs').all().map((r) => r.hash);
  const orphanBlobs = blobRows.filter((h) => !remainingTreeBlobs.has(h) && !protectedHashes.has(h));
  const remainingBlobRows = new Set(blobRows.filter((h) => !orphanBlobs.includes(h)));
  const live = new Set(protectedHashes);
  for (const r of remainingCommits) {
    live.add(r.hash);
    live.add(r.tree);
  }
  for (const r of remainingTreeEntries) {
    live.add(r.tree_hash);
    live.add(r.blob_hash);
  }
  for (const h of remainingBlobRows) live.add(h);
  const objects = listObjectHashes().filter((h) => !live.has(h)).length;
  return {
    sessions: deletableIds.length,
    commits: doomedHashes.size,
    refs,
    treeEntries: staleTreeEntries,
    blobs: orphanBlobs.length,
    objects,
    blocked: candidateIds.length - deletableIds.length,
  };
}

const tx = db.transaction(() => {
  const candidates = db.prepare(
    \"SELECT id, name FROM sessions WHERE status IN ('abandoned','failed') AND updated_at < ?\"
  ).all(cutoffMs);
  if (candidates.length === 0) return { sessions: 0, commits: 0, refs: 0, treeEntries: 0, blobs: 0, objects: 0, blocked: 0 };

  const candidateIds = candidates.map((s) => s.id);
  const deletableIds = deletableSessionIds(candidateIds);
  const doomedRows = commitsForSessions(deletableIds);
  const doomed = new Set(doomedRows.map((r) => r.hash));

  if (dryRun) {
    return dryRunAnalysis(candidateIds, deletableIds, doomedRows);
  }

  let refs = 0;
  if (doomed.size) {
    refs = db.prepare('DELETE FROM refs WHERE target IN (' + placeholders(doomed.size) + ')').run(...doomed).changes;
  }

  let commits = 0;
  while (doomed.size) {
    const leaves = [];
    for (const h of doomed) {
      const child = db.prepare('SELECT 1 FROM commits WHERE parent = ? LIMIT 1').get(h);
      if (!child) leaves.push(h);
    }
    if (leaves.length === 0) throw new Error('cannot prune: commit parent cycle or external child remains');
    commits += deleteIn('commits', 'hash', leaves);
    for (const h of leaves) doomed.delete(h);
  }

  const sessions = deleteIn('sessions', 'id', deletableIds);

  const treeEntries = db.prepare(
    'DELETE FROM tree_entries WHERE NOT EXISTS (SELECT 1 FROM commits WHERE commits.tree = tree_entries.tree_hash)'
  ).run().changes;

  const protectedHashes = protectedHashesFromRemainingCommits();
  const orphanBlobs = orphanBlobHashes(protectedHashes);
  const blobs = deleteIn('blobs', 'hash', orphanBlobs);
  const objectsToDelete = unreferencedObjects(protectedHashes);
  return { sessions, commits, refs, treeEntries, blobs, objects: objectsToDelete.length, blocked: candidateIds.length - deletableIds.length, objectsToDelete };
});

const result = tx();
if (!dryRun && result.objectsToDelete) {
  for (const hash of result.objectsToDelete) fs.unlinkSync(objectPath(hash));
  delete result.objectsToDelete;
}
console.log(dryRun ? '[dry run]' : '[applied]', result);
db.close();
"
```

After applying the cleanup, reclaim unused SQLite pages:

```bash
node -e "
const path = require('path');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(process.cwd(), 'packages/core'), process.cwd()] }));
const db = new Database('.agentgit/index.db');
db.exec('VACUUM');
db.close();
"
```

If the dry run reports `blocked`, those sessions have commits that are parents
of commits in another session. Keep them until first-class `agentgit gc` can
reason about reachability across refs and sessions.
