import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIGRATIONS,
  Repository,
  generateKeyPair,
  loadConfig,
  openRawIndexDb,
  saveConfig,
} from "@agentgit/core";
import { initCommand } from "../../src/commands/init.js";
import { configCommand } from "../../src/commands/config.js";
import { migrateCommand } from "../../src/commands/migrate.js";
import { verifyCommand } from "../../src/commands/verify.js";

let tmpDir: string;
let agentgitDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-cli-"));
  agentgitDir = join(tmpDir, ".agentgit");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentgit config CLI", () => {
  it("persists user.name and user.email to .agentgit/config.json", () => {
    initCommand(tmpDir);
    expect(configCommand(agentgitDir, "user.name", "Alice")).toBe(0);
    expect(configCommand(agentgitDir, "user.email", "alice@example.com")).toBe(0);

    const cfg = loadConfig(agentgitDir);
    expect(cfg.user).toEqual({ name: "Alice", email: "alice@example.com" });
  });

  it("getting a value writes it to stdout", () => {
    initCommand(tmpDir);
    configCommand(agentgitDir, "user.name", "Alice");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    expect(configCommand(agentgitDir, "user.name", undefined)).toBe(0);
    vi.restoreAllMocks();
    expect(out.join("")).toBe("Alice\n");
  });

  it("returns non-zero when key is unset", () => {
    initCommand(tmpDir);
    expect(configCommand(agentgitDir, "user.name", undefined)).toBe(1);
  });

  it("configured identity is picked up on commit", () => {
    initCommand(tmpDir);
    configCommand(agentgitDir, "user.name", "Alice");
    configCommand(agentgitDir, "user.email", "alice@example.com");

    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "hi" });
    expect(commit.author).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    repo.index.close();
  });
});

describe("agentgit migrate CLI", () => {
  it("--check returns 0 when the DB is already at the target version", () => {
    initCommand(tmpDir);
    expect(migrateCommand(agentgitDir, { check: true })).toBe(0);
  });

  it("--check returns non-zero when migrations are pending", () => {
    // Build a v0.1 fixture DB by hand and skip init's auto-migration.
    mkdirSync(agentgitDir, { recursive: true });
    const dbPath = join(agentgitDir, "index.db");
    const db = openRawIndexDb(dbPath);
    db.exec(MIGRATIONS[0]!.up);
    db.close();

    expect(migrateCommand(agentgitDir, { check: true })).toBe(1);
  });

  it("applies pending migrations and the next --check passes", () => {
    mkdirSync(agentgitDir, { recursive: true });
    const dbPath = join(agentgitDir, "index.db");
    const db = openRawIndexDb(dbPath);
    db.exec(MIGRATIONS[0]!.up);
    db.close();

    expect(migrateCommand(agentgitDir, {})).toBe(0);
    expect(migrateCommand(agentgitDir, { check: true })).toBe(0);
  });

  it("--check returns non-zero when DB version is newer than the bundled target", () => {
    initCommand(tmpDir);
    const raw = openRawIndexDb(join(agentgitDir, "index.db"));
    raw
      .prepare(
        `INSERT INTO schema_version (version, name, applied_at) VALUES (?, 'future', 0)`,
      )
      .run(99);
    raw.close();

    expect(migrateCommand(agentgitDir, { check: true })).toBe(1);
  });
});

describe("agentgit verify CLI", () => {
  it("returns 0 for a valid signed commit and 1 for a tampered one", () => {
    initCommand(tmpDir);

    const kp = generateKeyPair();
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "a@x.com" },
      signing: { privateKey: kp.privateKey, publicKey: kp.publicKey },
    });

    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "signed" });
    repo.index.close();

    expect(verifyCommand(agentgitDir, commit.hash)).toBe(0);

    // Corrupt the signature column.
    const raw = openRawIndexDb(join(agentgitDir, "index.db"));
    const sigBuf = Buffer.from(commit.signature!, "base64");
    sigBuf[0] = sigBuf[0] ^ 0xff;
    raw
      .prepare(`UPDATE commits SET signature = ? WHERE hash = ?`)
      .run(sigBuf.toString("base64"), commit.hash);
    raw.close();

    expect(verifyCommand(agentgitDir, commit.hash)).toBe(1);
  });

  it("returns 0 for an unsigned commit (informational)", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "plain" });
    repo.index.close();

    expect(verifyCommand(agentgitDir, commit.hash)).toBe(0);
  });
});
