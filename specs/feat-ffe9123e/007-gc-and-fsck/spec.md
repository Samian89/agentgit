# `agentgit gc` and `agentgit fsck` — Reclamation and Integrity

## Goal
Ship two operational commands: `agentgit gc` reclaims unreachable objects with a soft-delete-then-prune model, and `agentgit fsck` verifies every object's hash against its filename and cross-checks the SQLite index against the object store, with `--json` machine output and a safe `--repair` mode.

## Context
- Nothing currently reclaims storage. Long-running projects' `.agentgit/objects/` grows monotonically because abandoned sessions / orphaned blobs are never removed.
- There is no integrity check. A bit-flip or partial-write under crash would silently corrupt the store.
- `ObjectStore` is a sharded filesystem store at `.agentgit/objects/<2>/<62>`. Each filename is the hash of the canonical-JSON body — that property is the foundation for `fsck`'s hash verification.
- Reachability roots = all refs in `RefStore` + every `sessions.head` in the index + every `HEAD`.
- Spec 002's migrations add `schema_version` — `fsck` should also validate the current DB matches the bundled migrations.

## Technical Approach
1. **`agentgit gc [--prune-older-than=30d] [--dry-run]`**
   - Compute reachability:
     - Start from every ref target and every active/completed session head.
     - Walk `commit → parent`, `commit → tree`, `tree → blob` transitively.
   - Identify unreachable object hashes (set difference against the filesystem).
   - **Soft-delete**: move each unreachable file to `.agentgit/objects.gc/<2>/<62>` preserving the shard layout, and write a `.agentgit/objects.gc/manifest.jsonl` entry `{ hash, deletedAt }`.
   - **Hard-delete**: on a subsequent gc run, files in `objects.gc/` older than `--prune-older-than` (default 30d) are removed.
   - `--dry-run` prints the would-be actions and exits 0.
   - Refuse to run if a session is `status='active'` and `--force` is not passed (active session may write more refs during gc).
2. **`agentgit fsck [--json] [--repair]`**
   - Phase 1 — **object integrity**:
     - For every file in `objects/`, read the body, recompute SHA-256 of canonical-JSON, assert the digest equals the filename.
     - Mismatches are reported and (if `--repair`) moved to `.agentgit/objects.corrupt/`.
   - Phase 2 — **index ↔ store cross-check**:
     - Every `commits.hash`, `blobs.hash`, `tree_entries.blob_hash`, `commits.tree`, `commits.parent`, `refs.target` must exist as a file on disk (or be `NULL`).
     - Every file on disk must (for commits/blobs/trees) appear in the appropriate index table — orphans surfaced.
     - FK invariants validated (sanity check that `PRAGMA foreign_keys=ON` and that no FK violation rows exist via `PRAGMA foreign_key_check`).
   - Phase 3 — **schema version check** (spec 002): `schema_version` matches the bundled migrations.
   - JSON output schema: `{ ok: boolean, errors: [...], warnings: [...], stats: { objects, commits, blobs, refs } }`.
   - `--repair` performs only **safe** fixes: move corrupt files aside, drop orphan index rows that point to non-existent objects (after confirming the object truly does not exist anywhere). Never deletes a file unless the user passes `--repair` *and* the file is in `objects.corrupt/`.
3. **Documentation**
   - Cross-link `docs/troubleshooting.md` (spec 001) to both commands' man pages.

## Acceptance Criteria
- [ ] `agentgit gc` on a repo with orphaned blobs moves them to `.agentgit/objects.gc/`; reachable objects untouched; refs still resolve afterwards.
- [ ] Subsequent `agentgit gc --prune-older-than=0d` hard-deletes the soft-deleted set.
- [ ] `agentgit gc --dry-run` makes no filesystem changes.
- [ ] `agentgit fsck` on a healthy repo exits 0 with no errors and a populated stats block.
- [ ] Deliberately corrupting an object file (single byte flip) → `agentgit fsck` reports the mismatch with the exact hash and filename.
- [ ] `agentgit fsck --repair` on the corrupted repo moves the file to `objects.corrupt/`, leaves a recovery note, and exits non-zero (the corruption itself is reported, the repair is the move).
- [ ] `agentgit fsck --json` emits parseable JSON matching the documented schema.
- [ ] `agentgit fsck` detects an orphaned `commits` row (referencing a deleted object) and reports it.

## Files to Touch
- packages/core/src/gc.ts  (create)
- packages/core/src/fsck.ts  (create)
- packages/core/src/repository.ts  (modify — expose gc + fsck)
- packages/cli/src/commands/gc.ts  (create)
- packages/cli/src/commands/fsck.ts  (create)
- packages/cli/src/index.ts  (modify)
- packages/core/src/__tests__/gc.test.ts  (create)
- packages/core/src/__tests__/fsck.test.ts  (create)
- docs/troubleshooting.md  (modify — link both commands)

## Test Strategy
- `gc.test.ts` creates a repo with orphaned objects, asserts soft-delete then hard-delete behavior.
- `fsck.test.ts` covers healthy repo, byte-flipped object, missing object referenced by index, schema-version drift.
- CLI integration test exercises `gc --dry-run`, `gc`, `fsck`, `fsck --json`.
