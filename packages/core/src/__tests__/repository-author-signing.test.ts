import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import { saveConfig } from "../config.js";
import { generateKeyPair } from "../signing.js";
import { canonicalJson } from "../hash.js";

let dir: string;
let agentgitDir: string;
let repo: Repository;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-author-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  agentgitDir = join(dir, ".agentgit");
  repo = Repository.init(agentgitDir);
});

afterEach(() => {
  repo.index.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Repository — author from config", () => {
  it("picks up user.name / user.email from .agentgit/config.json", () => {
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "alice@example.com" },
    });
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "hello" });
    expect(commit.author).toEqual({ name: "Alice", email: "alice@example.com" });

    // Persisted in SQLite and rehydrated on read.
    const fetched = repo.index.getCommit(commit.hash);
    expect(fetched?.author).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("leaves author null when no identity is configured", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "hello" });
    expect(commit.author).toBeNull();
  });

  it("explicit author in CommitInput overrides config", () => {
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "alice@example.com" },
    });
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "hello",
      author: { name: "Bob", email: "bob@example.com" },
    });
    expect(commit.author).toEqual({ name: "Bob", email: "bob@example.com" });
  });
});

describe("Repository — signing and verifyCommit", () => {
  it("signs commits when signing keys are configured and verify returns 'valid'", () => {
    const kp = generateKeyPair();
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "a@x.com" },
      signing: { enabled: true, privateKey: kp.privateKey, publicKey: kp.publicKey },
    });

    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "signed" });
    expect(commit.signature).not.toBeNull();
    expect(commit.publicKey).toBe(kp.publicKey);

    const result = repo.verifyCommit(commit.hash);
    expect(result.status).toBe("valid");
  });

  it("verify returns 'unsigned' when no signature is attached", () => {
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "plain" });
    const result = repo.verifyCommit(commit.hash);
    expect(result.status).toBe("unsigned");
  });

  it("verify returns 'tampered' when the object file is mutated", () => {
    const kp = generateKeyPair();
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "a@x.com" },
      signing: { privateKey: kp.privateKey, publicKey: kp.publicKey },
    });
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "signed" });

    const objPath = join(
      agentgitDir,
      "objects",
      commit.hash.slice(0, 2),
      commit.hash.slice(2),
    );
    const body = JSON.parse(readFileSync(objPath, "utf8")) as Record<
      string,
      unknown
    >;
    body.message = "tampered!";
    writeFileSync(objPath, canonicalJson(body), "utf8");

    const result = repo.verifyCommit(commit.hash);
    expect(result.status).toBe("tampered");
  });

  it("verify returns 'invalid' when signature is corrupted", () => {
    const kp = generateKeyPair();
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "a@x.com" },
      signing: { privateKey: kp.privateKey, publicKey: kp.publicKey },
    });
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "signed" });

    // Flip a bit in the stored signature via a separate raw DB connection.
    repo.index.close();
    const corrupted = Buffer.from(commit.signature!, "base64");
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    const raw = new Database(join(agentgitDir, "index.db"));
    raw
      .prepare(`UPDATE commits SET signature = ? WHERE hash = ?`)
      .run(corrupted.toString("base64"), commit.hash);
    raw.close();

    repo = Repository.open(agentgitDir);
    const result = repo.verifyCommit(commit.hash);
    expect(result.status).toBe("invalid");
  });

  it("verify returns 'tampered' when a SQLite content column is mutated (not the object file)", () => {
    const kp = generateKeyPair();
    saveConfig(agentgitDir, {
      user: { name: "Alice", email: "a@x.com" },
      signing: { privateKey: kp.privateKey, publicKey: kp.publicKey },
    });
    const session = repo.createSession("s1");
    const commit = repo.commit({ sessionId: session.id, message: "original message" });

    // Change the message column in SQLite without touching the object file or
    // the signature. The object-store check would still pass, but the SQLite
    // re-hash must catch this.
    repo.index.close();
    const raw = new Database(join(agentgitDir, "index.db"));
    raw
      .prepare(`UPDATE commits SET message = ? WHERE hash = ?`)
      .run("injected message", commit.hash);
    raw.close();

    repo = Repository.open(agentgitDir);
    const result = repo.verifyCommit(commit.hash);
    expect(result.status).toBe("tampered");
  });

  it("verify returns 'not-found' for an unknown hash", () => {
    const result = repo.verifyCommit("0".repeat(64));
    expect(result.status).toBe("not-found");
  });
});
