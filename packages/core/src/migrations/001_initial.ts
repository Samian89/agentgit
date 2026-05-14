/**
 * Migration 001 — initial v0.1 schema.
 *
 * This SQL mirrors the original DDL shipped with v0.1 of AgentGit. It is
 * applied as a single block when migrating an empty DB up to version 1.
 *
 * NOTE: keep in sync with adapters/python/agentgit_adapter/migrations.py.
 */
export const MIGRATION_001_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT    REFERENCES commits(hash) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,
    tree        TEXT    NOT NULL,
    parent      TEXT    REFERENCES commits(hash) ON DELETE RESTRICT,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp   INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    tool_call   TEXT,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commits_session_id ON commits(session_id);
CREATE INDEX IF NOT EXISTS idx_commits_parent     ON commits(parent);
CREATE INDEX IF NOT EXISTS idx_commits_timestamp  ON commits(timestamp);

CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime_type   TEXT,
    encoding    TEXT    NOT NULL DEFAULT 'base64'
                        CHECK (encoding IN ('base64', 'utf-8'))
);

CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,
    target      TEXT    NOT NULL REFERENCES commits(hash) ON DELETE RESTRICT,
    type        TEXT    NOT NULL DEFAULT 'branch'
                        CHECK (type IN ('branch', 'tag', 'session-head')),
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target);
CREATE INDEX IF NOT EXISTS idx_refs_type   ON refs(type);

CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    blob_hash   TEXT    NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);

CREATE INDEX IF NOT EXISTS idx_tree_entries_blob_hash ON tree_entries(blob_hash);
`;
