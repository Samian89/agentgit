/**
 * Schema DDL is now managed by the migration runner under ./migrations/.
 * Callers should invoke `runMigrations(db)` to bring a DB up to date instead
 * of executing this string directly. It is kept here as the concatenation of
 * every bundled migration for compatibility with tooling that wants a full
 * snapshot of the current schema.
 */
import { MIGRATIONS } from "./migrations/index.js";

export const SCHEMA_DDL = MIGRATIONS.map((m) => m.up).join("\n");
