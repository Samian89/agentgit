-- AgentGit SQLite Schema
-- index.db — metadata index for the .agentgit/ object store
--
-- The object store under .agentgit/objects/ holds the canonical content-addressed
-- blobs/trees/commits as JSON files. This database is a queryable index that mirrors
-- the essential fields of each object so the CLI can answer log/diff/blame queries
-- without deserializing every object file.
--
-- All hash columns store lowercase 64-character SHA-256 hex strings.
-- All timestamp columns store Unix epoch milliseconds as INTEGER.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,  -- UUID v4
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT    REFERENCES commits(hash) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,              -- Unix epoch ms
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'  -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

-- ---------------------------------------------------------------------------
-- commits
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,  -- SHA-256 hex
    tree        TEXT    NOT NULL,              -- SHA-256 hex of associated Tree object
    parent      TEXT    REFERENCES commits(hash) ON DELETE RESTRICT,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp   INTEGER NOT NULL,              -- Unix epoch ms
    message     TEXT    NOT NULL,
    tool_call   TEXT,                          -- JSON-serialised ToolCall or NULL
    metadata    TEXT    NOT NULL DEFAULT '{}'  -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_commits_session_id ON commits(session_id);
CREATE INDEX IF NOT EXISTS idx_commits_parent     ON commits(parent);
CREATE INDEX IF NOT EXISTS idx_commits_timestamp  ON commits(timestamp);

-- ---------------------------------------------------------------------------
-- blobs
-- ---------------------------------------------------------------------------
-- Mirrors the Blob objects in .agentgit/objects/ for fast size/existence lookups.
-- The actual content is NOT stored here; read object files for content.

CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,  -- SHA-256 hex
    size        INTEGER NOT NULL,              -- byte length of original content
    mime_type   TEXT,                          -- MIME type hint or NULL
    encoding    TEXT    NOT NULL DEFAULT 'base64'
                        CHECK (encoding IN ('base64', 'utf-8'))
);

-- ---------------------------------------------------------------------------
-- refs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,  -- e.g. "main", "sessions/abc123"
    target      TEXT    NOT NULL REFERENCES commits(hash) ON DELETE RESTRICT,
    type        TEXT    NOT NULL DEFAULT 'branch'
                        CHECK (type IN ('branch', 'tag', 'session-head')),
    updated_at  INTEGER NOT NULL               -- Unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target);
CREATE INDEX IF NOT EXISTS idx_refs_type   ON refs(type);

-- ---------------------------------------------------------------------------
-- tree_entries
-- ---------------------------------------------------------------------------
-- Denormalised index of Tree entries so blob→path lookups are fast without
-- deserialising tree objects.

CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,              -- SHA-256 hex of the parent Tree
    path        TEXT    NOT NULL,              -- logical path within agent state
    blob_hash   TEXT    NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);

CREATE INDEX IF NOT EXISTS idx_tree_entries_blob_hash ON tree_entries(blob_hash);
