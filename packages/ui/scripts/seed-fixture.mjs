import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "../src/__tests__/fixtures");
mkdirSync(fixtureDir, { recursive: true });

const db = new Database(join(fixtureDir, "index.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
    head        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS commits (
    hash        TEXT    NOT NULL PRIMARY KEY,
    tree        TEXT    NOT NULL,
    parent      TEXT,
    session_id  TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
    message     TEXT    NOT NULL,
    tool_call   TEXT,
    metadata    TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS blobs (
    hash        TEXT    NOT NULL PRIMARY KEY,
    size        INTEGER NOT NULL,
    mime_type   TEXT,
    encoding    TEXT    NOT NULL DEFAULT 'base64' CHECK (encoding IN ('base64', 'utf-8'))
);
CREATE TABLE IF NOT EXISTS tree_entries (
    tree_hash   TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    blob_hash   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    PRIMARY KEY (tree_hash, path)
);
CREATE TABLE IF NOT EXISTS refs (
    name        TEXT    NOT NULL PRIMARY KEY,
    target      TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'branch' CHECK (type IN ('branch', 'tag', 'session-head')),
    updated_at  INTEGER NOT NULL
);
`);

const SESSION_ID = "fixture-session-001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const TREE_A = "c".repeat(64);
const TREE_B = "d".repeat(64);
const BLOB_A = "e".repeat(64);
const BLOB_B = "f".repeat(64);

const tc1 = JSON.stringify({
  id: "tc-1",
  name: "read_file",
  input: { path: "/tmp/main.py" },
  output: "print('hello')",
  startedAt: 1700000000000,
  completedAt: 1700000000100,
  status: "success",
  error: null,
});
const tc2 = JSON.stringify({
  id: "tc-2",
  name: "write_file",
  input: { path: "/tmp/main.py", content: "print('world')" },
  output: "ok",
  startedAt: 1700000001000,
  completedAt: 1700000001100,
  status: "success",
  error: null,
});

db.prepare("INSERT OR REPLACE INTO blobs VALUES (?,?,?,?)").run(BLOB_A, 14, "text/plain", "utf-8");
db.prepare("INSERT OR REPLACE INTO blobs VALUES (?,?,?,?)").run(BLOB_B, 16, "text/plain", "utf-8");
db.prepare("INSERT OR REPLACE INTO tree_entries VALUES (?,?,?,?)").run(TREE_A, "files/main.py", BLOB_A, 14);
db.prepare("INSERT OR REPLACE INTO tree_entries VALUES (?,?,?,?)").run(TREE_B, "files/main.py", BLOB_B, 16);
db.prepare("INSERT OR REPLACE INTO commits VALUES (?,?,?,?,?,?,?,?)").run(
  HASH_A, TREE_A, null, SESSION_ID, 1700000000000, "read_file: read /tmp/main.py", tc1, "{}",
);
db.prepare("INSERT OR REPLACE INTO commits VALUES (?,?,?,?,?,?,?,?)").run(
  HASH_B, TREE_B, HASH_A, SESSION_ID, 1700000001000, "write_file: write /tmp/main.py", tc2, "{}",
);
db.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?)").run(
  SESSION_ID, "fixture-session", "active", HASH_B, 1700000000000, 1700000002000, "{}",
);

db.close();
console.log("Fixture DB created:", join(fixtureDir, "index.db"));
