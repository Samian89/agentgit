# Schema Migrations Infrastructure + Author Identity

## Goal
Introduce a numbered, versioned migration system for the SQLite index so future schema changes are safe and reversible-aware, and ship the first non-trivial migration: an `author { name, email, key_id? }` field on commits along with `agentgit config user.name|user.email`, optional Ed25519 commit signing, and a `schema_version` row used by both the TS core and the Python adapter.

## Context
- Today every `CREATE TABLE` uses `IF NOT EXISTS` (see `packages/core/src/schema.sql`). There is no schema version table, no migration runner, no way to apply a v0.2 change to an existing `index.db`.
- The Python adapter (`adapters/python/agentgit_adapter/adapter.py`) embeds a byte-equivalent `_SCHEMA_DDL`. Any DDL change must apply identically in both runtimes.
- `Commit` (`packages/core/src/types.ts`) currently has no `author`. Tool calls are recorded anonymously.
- The `commits` table has `tool_call TEXT` and `metadata TEXT` JSON blobs; the natural place for `author` is a first-class column on commits (queryable for the UI/log) plus a field on the canonical `Commit` object (so it participates in the hash).
- Adding `author` to the canonical `Commit` object *changes the hash output* for all new commits. Existing on-disk commits stay valid but new commits will hash differently. Document this as the v0.1 → v0.2 break.

## Technical Approach
1. **Migration runner (`packages/core/src/migrations/`)**
   - `migrations/000_initial.sql` — current `schema.sql` content verbatim (creates `schema_version` table at the end with `version=1`).
   - `migrations/001_author.sql` — `ALTER TABLE commits ADD COLUMN author TEXT;` and bump `schema_version` to 2.
   - `runner.ts` exports `runMigrations(db: Database)` that:
     - Reads `PRAGMA user_version` (or `SELECT MAX(version) FROM schema_version`).
     - Applies every migration with version > current inside a single transaction each.
     - Refuses to open a DB whose version is *higher* than the bundled migrations (downgrade refusal).
   - `SqliteIndex` constructor calls `runMigrations` instead of executing `schema.sql` directly.
2. **Author field on Commit (canonical object)**
   - Extend `Commit` type with `author: { name: string; email: string; keyId?: string } | null`.
   - `Repository.commit` accepts `author?` in `CommitInput`; if not provided, reads `.agentgit/config.json` (see spec 003) for `user.name` / `user.email`; if neither set, persists `null` and the UI/log shows `(unsigned, no author)`.
   - Insert into the new `commits.author` SQLite column as JSON.
3. **CLI: `agentgit config <key> [value]`**
   - Git-style. Reads/writes `.agentgit/config.json` (user scope) and `~/.agentgitconfig` (global scope) with `--global` flag.
   - Keys initially: `user.name`, `user.email`, `signing.enabled`, `signing.keyPath`.
4. **Optional signing (Ed25519, picked because Node's `crypto` ships it with no native deps and key generation is one-liner)**
   - `agentgit config signing.keyPath /path/to/ed25519.key` plus `signing.enabled true` enables it.
   - On commit, sign `commitHash` with the private key; store `{ algo: "ed25519", publicKey, signature }` in `commit.metadata.signature` (NOT in the canonical hashed body — signature contains the hash).
   - `agentgit log` shows `(signed)` / `(unsigned)`. `agentgit verify <hash>` (new sub-command) re-verifies.
   - Justification document in `docs/architecture.md` (linked from spec 001): Ed25519 vs sigstore vs GPG — picked Ed25519 for zero external dependencies and offline-first ethos.
5. **Python parity**
   - Update `_SCHEMA_DDL` to include `schema_version` table and the v2 ALTER (applied via a small Python migration list).
   - `adapter.py` runs the same migrations on init.
6. **`agentgit migrate` CLI command**
   - Prints current schema version + pending migrations + applies them.
   - `--check` flag returns non-zero if migrations pending.

## Acceptance Criteria
- [ ] `packages/core/src/migrations/` exists with at least `000_initial.sql`, `001_author.sql`, and a `runner.ts`.
- [ ] A v0.1 fixture `index.db` (no `schema_version`, no `author` column) can be opened by the runner and ends up at version 2 with the `author` column.
- [ ] Opening a v0.3 fixture (version=99) raises a clear "newer DB than this client supports — refusing to downgrade" error and does not mutate the DB.
- [ ] `Commit` type includes `author`; new commits include it; old commits round-trip without it.
- [ ] `agentgit config user.name "Alice"` and `agentgit config user.email "a@b.com"` persist to `.agentgit/config.json` and are picked up by subsequent commits.
- [ ] `agentgit log` shows author per commit.
- [ ] Signing: generating an Ed25519 keypair, enabling signing, then `agentgit verify <hash>` returns success for a signed commit and failure for a tampered one.
- [ ] Python adapter's `_SCHEMA_DDL` is updated; Python tests still pass; a Python-created DB and a TS-created DB are schema-identical (compare `sqlite_master` dumps).
- [ ] `agentgit migrate` CLI command exists with `--check`.

## Files to Touch
- packages/core/src/migrations/000_initial.sql  (create — current schema.sql)
- packages/core/src/migrations/001_author.sql  (create)
- packages/core/src/migrations/runner.ts  (create)
- packages/core/src/sqlite-index.ts  (modify — call runner)
- packages/core/src/schema.sql  (delete or leave as legacy reference)
- packages/core/src/types.ts  (modify — add author to Commit)
- packages/core/src/repository.ts  (modify — author resolution + persistence)
- packages/cli/src/commands/config.ts  (create)
- packages/cli/src/commands/migrate.ts  (create)
- packages/cli/src/commands/verify.ts  (create)
- packages/cli/src/index.ts  (modify — wire new commands)
- packages/core/src/signing.ts  (create — Ed25519 sign/verify helpers)
- adapters/python/agentgit_adapter/adapter.py  (modify — schema parity)
- packages/core/src/__tests__/migrations.test.ts  (create)

## Test Strategy
- New `migrations.test.ts` covers: fresh DB ends at latest version; v0.1 fixture migrates cleanly; v-too-new fixture refuses.
- `signing.test.ts` covers: sign + verify round-trip; tampered signature fails.
- Update `packages/core/src/__tests__/hash.test.ts` fixtures for the new `Commit` shape.
- Python: `adapters/python/tests/` gain a test that compares `sqlite_master` output between Python-created and TS-created DBs (fixture).
