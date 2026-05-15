import { existsSync } from "node:fs";
import { join } from "node:path";
import { migrationStatus, openRawIndexDb, runMigrations } from "@agentgit/core";

export interface MigrateCommandOptions {
  /** When true, do not mutate the DB; report pending and exit non-zero if any. */
  check?: boolean;
}

/**
 * `agentgit migrate [--check]`
 *
 * Without --check: brings the index.db up to the latest bundled schema version.
 * With    --check: reports current/target versions and exits non-zero if any
 *                  migration is pending. Never writes to the DB.
 */
export function migrateCommand(
  agentgitDir: string,
  options: MigrateCommandOptions = {},
): number {
  const dbPath = join(agentgitDir, "index.db");
  if (!existsSync(dbPath)) {
    console.error(`fatal: no index.db found at ${dbPath}`);
    return 1;
  }

  const db = openRawIndexDb(dbPath);

  try {
    if (options.check) {
      const status = migrationStatus(db);
      console.log(`current schema version: ${status.current}`);
      console.log(`target  schema version: ${status.target}`);
      if (status.current > status.target) {
        console.error(
          `database schema version ${status.current} is newer than this build supports (${status.target}); upgrade agentgit.`,
        );
        return 1;
      }
      if (status.pending.length === 0) {
        console.log("database is up to date.");
        return 0;
      }
      console.log(`pending migrations: ${status.pending.length}`);
      for (const m of status.pending) {
        console.log(`  - ${m.version} ${m.name}`);
      }
      return 1;
    }

    const before = migrationStatus(db);
    const after = runMigrations(db);
    const applied = after.current - before.current;
    if (applied === 0) {
      console.log(`database already at schema version ${after.current}.`);
    } else {
      console.log(
        `applied ${applied} migration(s); now at schema version ${after.current}.`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
