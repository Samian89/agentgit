import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { sha256 } from "./hash.js";
import {
  MIGRATIONS,
  TARGET_VERSION,
  getCurrentVersion,
  openRawIndexDb,
} from "./migrations/index.js";
import type { Hash } from "./types.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export type FsckIssueType =
  | "corrupt-object"
  | "missing-object"
  | "orphan-index-row"
  | "orphan-object"
  | "schema-version-mismatch"
  | "schema-version-incomplete"
  | "schema-version-pending"
  | "missing-table"
  | "missing-index-db"
  | "integrity-check-failed"
  | "foreign-keys-disabled"
  | "fk-violation"
  | "unreadable-object"
  | "dangling-session-head"
  | "type-mismatch";

export interface FsckIssue {
  type: FsckIssueType;
  /** Object hash involved, if any. */
  hash?: Hash;
  /** Filesystem path involved, if any. */
  path?: string;
  /** Human-readable description of the problem. */
  message: string;
  /** Set when `--repair` performed a fix for this issue. */
  repaired?: boolean;
}

export interface FsckStats {
  /** Total object files scanned in `.agentgit/objects/`. */
  objects: number;
  /** Rows in the commits table. */
  commits: number;
  /** Rows in the blobs table. */
  blobs: number;
  /** Rows in the refs table. */
  refs: number;
}

export interface FsckReport {
  /** True iff no errors were detected (warnings do not affect ok). */
  ok: boolean;
  errors: FsckIssue[];
  warnings: FsckIssue[];
  stats: FsckStats;
  /** Echo of the schema version check for downstream consumers. */
  schema: { current: number; target: number };
}

export interface FsckOptions {
  /** Move corrupt files to `objects.corrupt/` and drop orphan index rows. */
  repair?: boolean;
}

// Tables we expect to be present in a fully-migrated DB. Keep in sync with the
// bundled migrations under `./migrations/`.
const REQUIRED_TABLES = [
  "schema_version",
  "sessions",
  "commits",
  "blobs",
  "refs",
  "tree_entries",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listShardedObjects(dir: string): Hash[] {
  if (!existsSync(dir)) return [];
  const out: Hash[] = [];
  for (const shard of readdirSync(dir)) {
    if (shard.length !== 2) continue;
    const shardPath = join(dir, shard);
    let st;
    try {
      st = statSync(shardPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const file of readdirSync(shardPath)) {
      if (file.length !== 62) continue;
      out.push(shard + file);
    }
  }
  return out;
}

function objectPath(rootDir: string, hash: Hash): string {
  return join(rootDir, hash.slice(0, 2), hash.slice(2));
}

function moveToQuarantine(srcPath: string, hash: Hash, corruptDir: string): string {
  const dst = objectPath(corruptDir, hash);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(srcPath, dst);
  return dst;
}

function writeRecoveryNote(corruptDir: string, issues: FsckIssue[]): void {
  if (issues.length === 0) return;
  const lines = [
    "# agentgit fsck --repair recovery note",
    `# generated: ${new Date().toISOString()}`,
    "#",
    "# The files in this directory failed object-integrity checks during",
    "# `agentgit fsck --repair`. Each line below records the offending hash",
    "# (filename) and what was wrong with it. To recover, restore the exact",
    "# bytes for each hash from a backup or another copy of the same store.",
    "# Editing a file here will not change its filename — the canonical hash",
    "# of the file's contents must equal its filename.",
    "",
  ];
  for (const issue of issues) {
    lines.push(`- ${issue.hash ?? "<unknown>"}\t${issue.message}`);
  }
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(join(corruptDir, "RECOVERY.md"), lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// fsck entry point
// ---------------------------------------------------------------------------

/**
 * Verify the integrity of `.agentgit/`. Three phases:
 *
 *   1. Object integrity — for every file under `.agentgit/objects/`, parse
 *      its JSON body, recompute SHA-256 of the canonical form, and assert it
 *      equals the filename. Mismatches → error; `--repair` moves the file to
 *      `.agentgit/objects.corrupt/<2>/<62>` and writes a `RECOVERY.md` note.
 *
 *   2. Index / store cross-check —
 *      • Every `commits.hash`, `commits.tree`, `commits.parent`,
 *        `blobs.hash`, `tree_entries.blob_hash`, `refs.target`, and
 *        `sessions.head` must exist as an object file under
 *        `.agentgit/objects/` (missing-object). Objects merely present in
 *        `objects.gc/` / `objects.corrupt/` are NOT live and still count as
 *        missing — those directories exist precisely because the objects
 *        have been quarantined out of the live store.
 *      • Every referenced object's on-disk `type` matches the role the
 *        index assigns it: commit refs point at `type:"commit"`, tree refs
 *        at `type:"tree"`, blob refs at `type:"blob"` (type-mismatch).
 *      • Every object file must be matched by the appropriate index row
 *        (orphan-object — warning, not error).
 *      • `PRAGMA foreign_keys` reports ON.
 *      • `PRAGMA foreign_key_check` reports no violations.
 *      • `PRAGMA integrity_check` reports `ok` (full SQLite consistency).
 *
 *   3. Schema — every bundled migration is recorded in `schema_version`,
 *      `MAX(version)` equals `TARGET_VERSION`, every required table exists,
 *      AND pending migrations are NOT silently applied (fsck opens the DB
 *      with `openRawIndexDb`, which skips the migration runner; pending
 *      migrations surface as a `schema-version-pending` error so users see
 *      the drift instead of having it auto-fixed).
 *
 * With `--repair`, fsck performs only safe fixes (quarantine corrupt files,
 * drop refs / tree_entries rows pointing at objects that truly do not exist
 * anywhere). It NEVER deletes an object file — corrupt files are moved, not
 * removed. The report still records the underlying issues; the `ok` flag
 * still reflects whether errors were found.
 *
 * Takes `agentgitDir` as a path (not a `Repository`) so the function can
 * open its own raw DB connection that does NOT run migrations. Calling
 * `Repository.open()` first would silently bring the schema up to date and
 * defeat the schema-version check.
 */
export function fsck(agentgitDir: string, options: FsckOptions = {}): FsckReport {
  const repair = options.repair === true;
  const objectsDir = join(agentgitDir, "objects");
  const gcDir = join(agentgitDir, "objects.gc");
  const corruptDir = join(agentgitDir, "objects.corrupt");
  const dbPath = join(agentgitDir, "index.db");

  const errors: FsckIssue[] = [];
  const warnings: FsckIssue[] = [];

  // Bail out early if the DB does not exist — every other check assumes it.
  if (!existsSync(dbPath)) {
    errors.push({
      type: "missing-index-db",
      path: dbPath,
      message: `index.db not found at ${dbPath}`,
    });
    return {
      ok: false,
      errors,
      warnings,
      stats: { objects: 0, commits: 0, blobs: 0, refs: 0 },
      schema: { current: 0, target: TARGET_VERSION },
    };
  }

  // openRawIndexDb deliberately skips runMigrations — fsck must observe the
  // schema as it actually is on disk, not silently upgrade it mid-diagnosis.
  const db = openRawIndexDb(dbPath);
  try {
    return runFsckChecks({
      db,
      objectsDir,
      gcDir,
      corruptDir,
      repair,
      errors,
      warnings,
    });
  } finally {
    db.close();
  }
}

interface FsckCheckContext {
  db: Database.Database;
  objectsDir: string;
  gcDir: string;
  corruptDir: string;
  repair: boolean;
  errors: FsckIssue[];
  warnings: FsckIssue[];
}

function runFsckChecks(ctx: FsckCheckContext): FsckReport {
  const { db, objectsDir, gcDir, corruptDir, repair, errors, warnings } = ctx;

  // ----- Phase 1: object integrity -----
  const onDisk = listShardedObjects(objectsDir);
  const corruptIssues: FsckIssue[] = [];
  // Hashes whose file is still in `objects/` AND whose recomputed digest
  // matches the filename. This is the "live, valid" set — any index row
  // pointing at a hash that is NOT in this set is considered to reference a
  // missing object, even if the bytes happen to live in `objects.gc/` or
  // `objects.corrupt/`.
  const validOnDisk = new Set<Hash>();
  // Parsed bodies for surviving objects, used to classify type and (for
  // trees) to learn which tree hashes are referenced by commit rows below.
  const parsed = new Map<Hash, Record<string, unknown>>();

  for (const hash of onDisk) {
    const path = objectPath(objectsDir, hash);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const issue: FsckIssue = {
        type: "unreadable-object",
        hash,
        path,
        message: `failed to parse object body: ${message}`,
      };
      if (repair) {
        try {
          issue.path = moveToQuarantine(path, hash, corruptDir);
          issue.repaired = true;
          corruptIssues.push(issue);
        } catch {
          // best-effort; leave as un-repaired error
        }
      }
      errors.push(issue);
      continue;
    }

    const digest = sha256(body);
    if (digest !== hash) {
      const issue: FsckIssue = {
        type: "corrupt-object",
        hash,
        path,
        message: `object body hashes to ${digest}, expected ${hash}`,
      };
      if (repair) {
        try {
          issue.path = moveToQuarantine(path, hash, corruptDir);
          issue.repaired = true;
          corruptIssues.push(issue);
        } catch {
          // best-effort
        }
      }
      errors.push(issue);
      continue;
    }

    validOnDisk.add(hash);
    parsed.set(hash, body);
  }

  if (repair && corruptIssues.length > 0) {
    writeRecoveryNote(corruptDir, corruptIssues);
  }

  // ----- Phase 2: index / store cross-check -----

  // Strict detection — only live, digest-verified objects count.
  const existsOnDisk = (hash: Hash): boolean => validOnDisk.has(hash);
  // Repair gate — a row pointing at a hash that lives ANYWHERE on disk
  // (live, quarantined, or pending hard-delete) must not be dropped; the
  // user should restore from the quarantine instead.
  const gcSet = new Set(listShardedObjects(gcDir));
  const corruptSet = new Set(listShardedObjects(corruptDir));
  const existsAnywhere = (hash: Hash): boolean =>
    validOnDisk.has(hash) || gcSet.has(hash) || corruptSet.has(hash);

  // Lookup helper for on-disk object type (only defined when the file lives
  // in `objects/` and digest-validated above).
  const onDiskType = (hash: Hash): string | undefined => {
    const body = parsed.get(hash);
    if (!body) return undefined;
    const t = body.type;
    return typeof t === "string" ? t : undefined;
  };
  const checkType = (
    hash: Hash,
    expected: "commit" | "tree" | "blob",
    contextMessage: string,
  ): void => {
    if (!existsOnDisk(hash)) return; // missing-object already reported
    const actual = onDiskType(hash);
    if (actual === expected) return;
    errors.push({
      type: "type-mismatch",
      hash,
      message: `${contextMessage} — on-disk object has type '${actual ?? "<unknown>"}', expected '${expected}'`,
    });
  };

  // 2-pre. Required tables exist. If a table is missing, skip the queries
  // that would otherwise raise SqliteError and let the missing-table error
  // be the actionable signal.
  const tablePresence = new Map<string, boolean>();
  for (const t of REQUIRED_TABLES) {
    const row = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(t);
    const exists = row !== undefined;
    tablePresence.set(t, exists);
    if (!exists) {
      errors.push({
        type: "missing-table",
        message: `required table '${t}' is missing from index.db`,
      });
    }
  }

  const commitRows = tablePresence.get("commits")
    ? (db
        .prepare(`SELECT hash, tree, parent FROM commits`)
        .all() as Array<{ hash: string; tree: string; parent: string | null }>)
    : [];
  const blobRows = tablePresence.get("blobs")
    ? (db.prepare(`SELECT hash FROM blobs`).all() as Array<{ hash: string }>)
    : [];
  const refRows = tablePresence.get("refs")
    ? (db
        .prepare(`SELECT name, target FROM refs`)
        .all() as Array<{ name: string; target: string }>)
    : [];
  const treeEntryRows = tablePresence.get("tree_entries")
    ? (db
        .prepare(`SELECT tree_hash, path, blob_hash FROM tree_entries`)
        .all() as Array<{ tree_hash: string; path: string; blob_hash: string }>)
    : [];
  const sessionRows = tablePresence.get("sessions")
    ? (db
        .prepare(`SELECT id, head FROM sessions WHERE head IS NOT NULL`)
        .all() as Array<{ id: string; head: string }>)
    : [];

  const commitHashes = new Set(commitRows.map((r) => r.hash));
  const blobHashes = new Set(blobRows.map((r) => r.hash));
  const treesReferenced = new Set<Hash>();
  for (const c of commitRows) treesReferenced.add(c.tree);

  // 2a. Missing object: index row points at a file that does not exist in
  // the LIVE store. Objects in `objects.gc/` or `objects.corrupt/` do not
  // satisfy this check — they are not live data.
  const orphanedIndexRows: FsckIssue[] = [];

  for (const c of commitRows) {
    if (!existsOnDisk(c.hash)) {
      orphanedIndexRows.push({
        type: "missing-object",
        hash: c.hash,
        message: `commits row references missing commit object ${c.hash}`,
      });
    } else {
      checkType(c.hash, "commit", `commits row hash ${c.hash}`);
    }
    if (!existsOnDisk(c.tree)) {
      orphanedIndexRows.push({
        type: "missing-object",
        hash: c.tree,
        message: `commit ${c.hash} references missing tree object ${c.tree}`,
      });
    } else {
      checkType(c.tree, "tree", `commit ${c.hash} tree ${c.tree}`);
    }
    if (c.parent !== null) {
      if (!existsOnDisk(c.parent)) {
        orphanedIndexRows.push({
          type: "missing-object",
          hash: c.parent,
          message: `commit ${c.hash} references missing parent commit ${c.parent}`,
        });
      } else {
        checkType(c.parent, "commit", `commit ${c.hash} parent ${c.parent}`);
      }
    }
  }
  for (const b of blobRows) {
    if (!existsOnDisk(b.hash)) {
      orphanedIndexRows.push({
        type: "missing-object",
        hash: b.hash,
        message: `blobs row references missing blob object ${b.hash}`,
      });
    } else {
      checkType(b.hash, "blob", `blobs row hash ${b.hash}`);
    }
  }
  // Set of every tree hash for which a tree object exists on disk (and is
  // digest-valid). Combined with `treesReferenced` below, this lets us
  // detect tree_entries rows whose `tree_hash` points at nothing at all.
  const treesOnDisk = new Set<Hash>();
  for (const [hash, body] of parsed) {
    if (body.type === "tree") treesOnDisk.add(hash);
  }

  for (const t of treeEntryRows) {
    if (!existsOnDisk(t.blob_hash)) {
      orphanedIndexRows.push({
        type: "missing-object",
        hash: t.blob_hash,
        message: `tree_entries row (tree ${t.tree_hash}, path '${t.path}') references missing blob ${t.blob_hash}`,
      });
    } else {
      checkType(
        t.blob_hash,
        "blob",
        `tree_entries row (tree ${t.tree_hash}, path '${t.path}') blob ${t.blob_hash}`,
      );
    }
    // tree_entries.tree_hash has no FK constraint in the v1 schema, so
    // stale projections can outlive the commit that gave them meaning.
    // The troubleshooting doc warns about exactly this trap. Two flavours:
    //   • tree_hash references a tree that is also missing on disk — the
    //     row is completely orphaned and almost certainly indicates a
    //     half-cleanup. Reported as an `orphan-index-row` ERROR.
    //   • tree_hash references a tree that still exists on disk but no
    //     commit points at it any more — a stale projection from a
    //     deleted commit. Reported as `orphan-index-row` ERROR as well;
    //     the row is unreachable from any live record and `agentgit gc`
    //     cannot clean it up via the object store alone (it has no FK).
    if (!treesReferenced.has(t.tree_hash)) {
      const detail = treesOnDisk.has(t.tree_hash)
        ? "tree object exists on disk but no commit references it (stale projection from a deleted commit)"
        : "no commit references it and no tree object exists on disk";
      orphanedIndexRows.push({
        type: "orphan-index-row",
        hash: t.tree_hash,
        message: `tree_entries row (tree ${t.tree_hash}, path '${t.path}') points at an unknown tree — ${detail}`,
      });
    }
  }
  for (const r of refRows) {
    if (!existsOnDisk(r.target)) {
      orphanedIndexRows.push({
        type: "missing-object",
        hash: r.target,
        message: `refs row '${r.name}' references missing commit ${r.target}`,
      });
    } else {
      checkType(r.target, "commit", `refs row '${r.name}' target ${r.target}`);
    }
  }
  for (const s of sessionRows) {
    if (!existsOnDisk(s.head)) {
      orphanedIndexRows.push({
        type: "dangling-session-head",
        hash: s.head,
        message: `session ${s.id} head points to missing commit ${s.head}`,
      });
    } else {
      checkType(s.head, "commit", `session ${s.id} head ${s.head}`);
    }
  }
  errors.push(...orphanedIndexRows);

  // 2b. Orphan objects: file on disk that no index row references.
  for (const [hash, body] of parsed) {
    const type = body.type as string | undefined;
    if (type === "commit") {
      if (!commitHashes.has(hash)) {
        warnings.push({
          type: "orphan-object",
          hash,
          message: `commit object on disk has no row in commits table`,
        });
      }
    } else if (type === "blob") {
      if (!blobHashes.has(hash)) {
        warnings.push({
          type: "orphan-object",
          hash,
          message: `blob object on disk has no row in blobs table`,
        });
      }
    } else if (type === "tree") {
      if (!treesReferenced.has(hash)) {
        warnings.push({
          type: "orphan-object",
          hash,
          message: `tree object on disk is not referenced by any commit`,
        });
      }
    }
  }

  // 2c. PRAGMA foreign_keys must be ON. Repository.open() always enables it,
  // so this asserts the assumption rather than guarding against drift, but
  // a future caller that swaps in their own connection could miss the
  // pragma — surface the gap loudly.
  const fkPragma = db.pragma("foreign_keys", { simple: true });
  if (fkPragma !== 1 && fkPragma !== "1") {
    errors.push({
      type: "foreign-keys-disabled",
      message: `PRAGMA foreign_keys is ${String(fkPragma)} (expected 1); FK constraints are not enforced`,
    });
  }

  // 2d. PRAGMA foreign_key_check
  const fkViolations = db.prepare(`PRAGMA foreign_key_check`).all() as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  for (const v of fkViolations) {
    errors.push({
      type: "fk-violation",
      message: `foreign key violation in table '${v.table}' (rowid ${v.rowid}) -> parent '${v.parent}'`,
    });
  }

  // 2e. PRAGMA integrity_check — catches B-tree / page-level corruption
  // that nothing else above would notice.
  const integrity = db
    .prepare(`PRAGMA integrity_check`)
    .all() as Array<{ integrity_check: string }>;
  for (const row of integrity) {
    if (row.integrity_check !== "ok") {
      errors.push({
        type: "integrity-check-failed",
        message: `SQLite integrity_check reported: ${row.integrity_check}`,
      });
    }
  }

  // ----- Phase 3: schema version -----
  //
  // Because fsck opens via openRawIndexDb (which intentionally skips
  // runMigrations), the value we read here is the *actual* on-disk
  // schema state, not the post-auto-migration state. That is exactly
  // what we need to detect a stale repo — if Repository.open() had run
  // migrations first, this check would always report success.
  const current = getCurrentVersion(db);
  if (current < TARGET_VERSION) {
    errors.push({
      type: "schema-version-pending",
      message: `schema_version is ${current}; bundled target is ${TARGET_VERSION}. Run 'agentgit migrate' (fsck does not auto-apply migrations).`,
    });
  } else if (current > TARGET_VERSION) {
    errors.push({
      type: "schema-version-mismatch",
      message: `schema_version is ${current}, newer than the bundled target ${TARGET_VERSION}; upgrade agentgit.`,
    });
  }

  // Even when MAX(version) == TARGET_VERSION, an audit row may be missing
  // for an intermediate migration (e.g., the DB was hand-edited). Flag every
  // bundled migration whose version is absent from schema_version.
  if (tablePresence.get("schema_version")) {
    const recordedRows = db
      .prepare(`SELECT version FROM schema_version`)
      .all() as Array<{ version: number }>;
    const recorded = new Set(recordedRows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (!recorded.has(m.version)) {
        errors.push({
          type: "schema-version-incomplete",
          message: `schema_version is missing an audit row for migration ${m.version} (${m.name})`,
        });
      }
    }
  }

  // ----- Repair pass for orphan index rows -----
  if (repair && orphanedIndexRows.length > 0) {
    repairOrphanedRows(db, orphanedIndexRows, existsAnywhere);
  }

  const stats: FsckStats = {
    objects: onDisk.length,
    commits: commitRows.length,
    blobs: blobRows.length,
    refs: refRows.length,
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats,
    schema: { current, target: TARGET_VERSION },
  };
}

/**
 * Safe-only repair for orphan rows: drop `refs` and `tree_entries` rows
 * whose target object truly does not exist anywhere (objects/, objects.gc/,
 * objects.corrupt/). We deliberately do NOT delete `commits` or `blobs`
 * rows here because those have inbound FK constraints whose cascading
 * effects can lose history the user might still want to recover.
 */
function repairOrphanedRows(
  db: Database.Database,
  issues: FsckIssue[],
  existsAnywhere: (hash: Hash) => boolean,
): void {
  for (const issue of issues) {
    if (issue.type !== "missing-object" || typeof issue.hash !== "string") continue;
    if (existsAnywhere(issue.hash)) continue;
    // Detect which kind of orphan this is from the message prefix.
    if (issue.message.startsWith("refs row ")) {
      const m = /'([^']+)'/.exec(issue.message);
      if (m) {
        db.prepare(`DELETE FROM refs WHERE name = ?`).run(m[1]);
        issue.repaired = true;
      }
    } else if (issue.message.startsWith("tree_entries row ")) {
      const m = /tree ([0-9a-f]{64}), path '([^']+)'/.exec(issue.message);
      if (m) {
        db.prepare(
          `DELETE FROM tree_entries WHERE tree_hash = ? AND path = ?`,
        ).run(m[1], m[2]);
        issue.repaired = true;
      }
    }
    // commits / blobs / sessions left intact — too dangerous to
    // cascade-delete here.
  }
}
