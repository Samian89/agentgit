/**
 * Migration 002 — author identity and optional Ed25519 signing.
 *
 * Adds four columns to commits:
 *   author_name, author_email   — committer identity from .agentgit/config.json
 *   signature, public_key       — base64 Ed25519 signature of the commit hash
 *
 * NOTE: keep in sync with adapters/python/agentgit_adapter/migrations.py.
 */
export const MIGRATION_002_SQL = `
ALTER TABLE commits ADD COLUMN author_name  TEXT;
ALTER TABLE commits ADD COLUMN author_email TEXT;
ALTER TABLE commits ADD COLUMN signature    TEXT;
ALTER TABLE commits ADD COLUMN public_key   TEXT;
`;
