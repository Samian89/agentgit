# AMC-d701c39d — Garbage collection and integrity checker

## 1. What I built (this cycle)

### Reviewer feedback addressed (Review 1, latest)

> fsck misses orphaned tree_entries.tree_hash rows and has a non-JSON
> --json error path

The `--json` error path was fixed last cycle (CLI no longer prints plain
`fatal: …` text on missing index.db; structured `missing-index-db` issue
flows through the same JSON serialiser as the success path; verified by
a CLI integration test).

The remaining gap was that my previous tree_entries.tree_hash orphan
detection only fired in the **completely broken** case — `tree_hash`
references neither a known commit nor an on-disk tree object. That left
**stale projections** silent: the case the troubleshooting doc warns
about, where a commit has been deleted but its tree object and
tree_entries rows remain because `tree_hash` has no FK.

**Fix this cycle.** Broadened the check in `packages/core/src/fsck.ts`
so that every `tree_entries` row whose `tree_hash` is not in
`treesReferenced` (the set of `commits.tree` values) surfaces as an
`orphan-index-row` error. The message now distinguishes the two
flavours:

- *"…stale projection from a deleted commit"* — tree object still on
  disk but no commit references it.
- *"…no commit references it and no tree object exists on disk"* — the
  completely broken case (caught before this cycle too).

A new test exercises the stale-projection path: it commits, then
hand-drops the commit row (with FKs temporarily off to bypass
`sessions.head` RESTRICT) while leaving the tree object and
`tree_entries` rows in place, and asserts the orphan-index-row error is
reported with the "stale projection" message.

### Carry-over (already in place from earlier cycles)

- `fsck` opens its own raw, non-migrating DB via `openRawIndexDb` so
  `Repository.open` cannot silently upgrade the schema mid-diagnosis;
  `schema-version-pending` reports drift without auto-applying.
- Type-validation (`type-mismatch`) on every indexed reference.
- Strict `existsOnDisk` semantics for missing-object detection; the
  looser `existsAnywhere` predicate is the repair gate.
- Required-table presence, `PRAGMA foreign_keys`, `foreign_key_check`,
  `integrity_check`, `schema_version` audit completeness, sessions.head
  cross-check, `missing-index-db` early-bail.
- `--json` always emits parseable JSON regardless of error path.
- `agentgit gc` reachability walk, soft-delete to
  `objects.gc/<2>/<62>` + `manifest.jsonl`, hard-prune after
  `--prune-older-than`, `--dry-run`, `--force`, active-session refusal.
- Documentation cross-links from `docs/troubleshooting.md`.

## 2. Files changed (this cycle)

Modified:
- `packages/core/src/fsck.ts` — broadened the `tree_entries.tree_hash`
  orphan check from "no commit ref AND no tree object" to "no commit
  ref" alone; message now reports whether this is a stale projection or
  a completely-broken row.
- `packages/core/src/__tests__/fsck.test.ts` — added the stale-projection
  test that proves stale tree_entries rows are detected after a commit
  is deleted but its tree object remains on disk.

Files from earlier cycles (unchanged this cycle):
- `packages/core/src/gc.ts`
- `packages/core/src/repository.ts`
- `packages/core/src/sqlite-index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/__tests__/gc.test.ts`
- `packages/cli/src/commands/gc.ts`
- `packages/cli/src/commands/fsck.ts`
- `packages/cli/src/index.ts`
- `packages/cli/tests/integration/gc-fsck.test.ts`
- `docs/troubleshooting.md`

## 3. APIs / types other tickets may consume

No public signatures changed this cycle. Behaviour change: an
`orphan-index-row` issue may now fire for stale `tree_entries` rows in
addition to broken ones; consumers parsing the JSON output should treat
the existing `orphan-index-row` type as covering both flavours and
inspect the message for the textual distinction.

From `@agentgit/core`:

- `fsck(agentgitDir: string, options?: FsckOptions) → FsckReport`
  Path-form; opens its own raw, non-migrating DB.
- `Repository.prototype.fsck(options?: FsckOptions) → FsckReport`
  Delegates to the path-form.
- `gc(repo, options?) → GcResult` and `Repository.prototype.gc(options?)`.
- `reachableObjects(repo) → Set<Hash>`.
- `SqliteIndex.unsafeDb() → Database.Database`.
- `FsckIssueType` union (unchanged this cycle):
  `'corrupt-object' | 'missing-object' | 'orphan-index-row' |
  'orphan-object' | 'schema-version-mismatch' |
  'schema-version-incomplete' | 'schema-version-pending' |
  'missing-table' | 'missing-index-db' | 'integrity-check-failed' |
  'foreign-keys-disabled' | 'fk-violation' | 'unreadable-object' |
  'dangling-session-head' | 'type-mismatch'`
- `FsckReport: { ok, errors, warnings, stats, schema }` (unchanged).
- `FsckOptions: { repair? }` (unchanged).

CLI surface (unchanged):
- `agentgit gc [--prune-older-than=<dur>] [--dry-run] [--force]`
- `agentgit fsck [--json] [--repair]`

## 4. Test output

```
pnpm test
  Test Files  32 passed (32)
  Tests       281 passed (281)

pnpm --filter @agentgit/cli test:integration
  Test Files  5 passed (5)
  Tests       32 passed (32)
```

New test this cycle:
- `fsck.test.ts > orphaned tree_entries.tree_hash rows > flags a stale
  projection — tree object still on disk but no commit references it`.

All previously-passing tests still pass.
