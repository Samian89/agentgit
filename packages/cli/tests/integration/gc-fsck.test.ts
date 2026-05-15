import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository, canonicalJson } from "@agentgit/core";
import { initCommand } from "../../src/commands/init.js";
import { gcCommand, parseDuration } from "../../src/commands/gc.js";
import { fsckCommand } from "../../src/commands/fsck.js";

let tmpDir: string;
let agentgitDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-cli-gc-fsck-"));
  agentgitDir = join(tmpDir, ".agentgit");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function objectFile(hash: string): string {
  return join(agentgitDir, "objects", hash.slice(0, 2), hash.slice(2));
}
function gcFile(hash: string): string {
  return join(agentgitDir, "objects.gc", hash.slice(0, 2), hash.slice(2));
}
function corruptFile(hash: string): string {
  return join(agentgitDir, "objects.corrupt", hash.slice(0, 2), hash.slice(2));
}

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  return {
    out,
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("agentgit gc CLI", () => {
  it("--dry-run reports actions without modifying the filesystem", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    repo.updateSessionStatus(session.id, "completed");
    const orphan = repo.objects.write({
      type: "blob",
      content: "orphan",
      size: 6,
      encoding: "utf-8",
      mimeType: null,
    });
    repo.index.close();

    expect(gcCommand(agentgitDir, { dryRun: true })).toBe(0);
    expect(existsSync(objectFile(orphan))).toBe(true);
    expect(existsSync(gcFile(orphan))).toBe(false);
  });

  it("soft-deletes orphans and reachable objects survive", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    repo.createBranch("main", commit.hash);
    repo.updateSessionStatus(session.id, "completed");
    const orphan = repo.objects.write({
      type: "blob",
      content: "orphan",
      size: 6,
      encoding: "utf-8",
      mimeType: null,
    });
    repo.index.close();

    expect(gcCommand(agentgitDir, {})).toBe(0);
    expect(existsSync(objectFile(orphan))).toBe(false);
    expect(existsSync(gcFile(orphan))).toBe(true);
    expect(existsSync(objectFile(commit.hash))).toBe(true);
  });

  it("refuses to run with an active session and no --force", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("active");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "f.txt", content: "f" }],
    });
    repo.index.close();

    expect(gcCommand(agentgitDir, {})).toBe(1);
    expect(gcCommand(agentgitDir, { force: true })).toBe(0);
  });

  it("--prune-older-than=0d hard-deletes the soft-deleted set", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    repo.commit({ sessionId: session.id, message: "c1" });
    repo.updateSessionStatus(session.id, "completed");
    const orphan = repo.objects.write({
      type: "blob",
      content: "z",
      size: 1,
      encoding: "utf-8",
      mimeType: null,
    });
    repo.index.close();

    expect(gcCommand(agentgitDir, {})).toBe(0);
    expect(existsSync(gcFile(orphan))).toBe(true);

    // Sleep just enough so the deletedAt timestamp is strictly older than now.
    const t0 = Date.now();
    while (Date.now() === t0) {
      // busy-wait one ms
    }
    expect(gcCommand(agentgitDir, { pruneOlderThan: "0d" })).toBe(0);
    expect(existsSync(gcFile(orphan))).toBe(false);
  });

  it("parseDuration accepts all supported units", () => {
    expect(parseDuration("0d")).toBe(0);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("7")).toBe(7 * 86_400_000);
    expect(() => parseDuration("nope")).toThrow();
  });
});

describe("agentgit fsck CLI", () => {
  it("exits 0 on a healthy repo", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "ok" }],
    });
    repo.index.close();

    expect(fsckCommand(agentgitDir, {})).toBe(0);
  });

  it("--json emits parseable JSON matching the documented schema", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "ok" }],
    });
    repo.index.close();

    const captured = captureStdout();
    try {
      expect(fsckCommand(agentgitDir, { json: true })).toBe(0);
    } finally {
      captured.restore();
    }
    const json = captured.out.join("");
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.stats).toMatchObject({
      objects: expect.any(Number),
      commits: 1,
      blobs: 1,
      refs: 0,
    });
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it("detects a corrupt object and --repair quarantines it", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    const blobHash = repo.index.getTreeEntries(commit.tree)[0]!.blobHash;
    repo.index.close();

    const blobPath = objectFile(blobHash);
    const parsed = JSON.parse(readFileSync(blobPath, "utf8")) as Record<
      string,
      unknown
    >;
    parsed.content = "tampered";
    writeFileSync(blobPath, canonicalJson(parsed), "utf8");

    // No --repair: corruption detected, exit 1.
    expect(fsckCommand(agentgitDir, {})).toBe(1);
    expect(existsSync(blobPath)).toBe(true);

    // --repair: still exit 1 (corruption is still reported), but file moved.
    expect(fsckCommand(agentgitDir, { repair: true })).toBe(1);
    expect(existsSync(blobPath)).toBe(false);
    expect(existsSync(corruptFile(blobHash))).toBe(true);
    const recovery = join(agentgitDir, "objects.corrupt", "RECOVERY.md");
    expect(existsSync(recovery)).toBe(true);
  });

  it("--json emits valid JSON even when index.db is missing", () => {
    // No initCommand call — agentgitDir does not exist yet. The CLI must
    // still emit valid JSON describing the failure mode (callers piping
    // through jq must always receive parseable output).
    const captured = captureStdout();
    let code: number;
    try {
      code = fsckCommand(agentgitDir, { json: true });
    } finally {
      captured.restore();
    }
    expect(code).toBe(1);
    const out = captured.out.join("");
    // Must not be plain "fatal: ..." text — must be parseable JSON.
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].type).toBe("missing-index-db");
  });

  it("--json detects orphaned index rows pointing to missing objects", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const session = repo.createSession("s1");
    const commit = repo.commit({
      sessionId: session.id,
      message: "c1",
      stateEntries: [{ path: "a.txt", content: "hello" }],
    });
    repo.index.close();

    rmSync(objectFile(commit.hash));

    const captured = captureStdout();
    let code: number;
    try {
      code = fsckCommand(agentgitDir, { json: true });
    } finally {
      captured.restore();
    }
    expect(code).toBe(1);
    const parsed = JSON.parse(captured.out.join(""));
    expect(parsed.ok).toBe(false);
    const missing = parsed.errors.find(
      (e: { type: string; hash?: string }) =>
        e.type === "missing-object" && e.hash === commit.hash,
    );
    expect(missing).toBeDefined();
  });
});
