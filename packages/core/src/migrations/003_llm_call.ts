/**
 * Migration 003 — LLM call support.
 *
 * Adds `llm_call` TEXT column to the commits table (JSON-serialised LlmCall or NULL,
 * symmetric with the existing `tool_call` column).
 *
 * NOTE: keep in sync with adapters/python/agentgit_adapter/migrations.py.
 */
export const MIGRATION_003_SQL = `
ALTER TABLE commits ADD COLUMN llm_call TEXT;
`;
