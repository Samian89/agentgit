import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { initCommand } from "../../src/commands/init.js";
import { mergeBaseCommand } from "../../src/commands/merge-base.js";
import { cherryPickCommand } from "../../src/commands/cherry-pick.js";

let tmpDir: string;
let agentgitDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-cli-merge-"));
  agentgitDir = join(tmpDir, ".agentgit");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("agentgit merge-base CLI", () => {
  it("prints the LCA hash and exits 0", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = repo.commit({
      sessionId: sA.id,
      message: "c1",
      parentHash: null,
      stateEntries: [{ path: "a", content: "v1" }],
    });
    const c2 = repo.commit({
      sessionId: sA.id,
      message: "c2",
      parentHash: c1.hash,
      stateEntries: [{ path: "a", content: "v2" }],
    });
    const c3 = repo.commit({
      sessionId: sB.id,
      message: "c3",
      parentHash: c1.hash,
      stateEntries: [{ path: "b", content: "vB" }],
    });
    repo.createBranch("featA", c2.hash);
    repo.createBranch("featB", c3.hash);
    repo.index.close();

    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      out.push(String(msg));
    });

    expect(mergeBaseCommand(agentgitDir, "featA", "featB")).toBe(0);
    expect(out[0]).toBe(c1.hash);
  });

  it("exits non-zero when a ref is unknown", () => {
    initCommand(tmpDir);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mergeBaseCommand(agentgitDir, "nope", "alsoNope")).toBe(1);
  });
});

describe("agentgit cherry-pick CLI", () => {
  it("replays source commits onto target and exits 0", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = repo.commit({
      sessionId: sA.id,
      message: "c1",
      parentHash: null,
      stateEntries: [{ path: "a", content: "v1" }],
    });
    const c2 = repo.commit({
      sessionId: sA.id,
      message: "c2",
      parentHash: c1.hash,
      stateEntries: [
        { path: "a", content: "v1" },
        { path: "b", content: "vB" },
      ],
    });
    const c3 = repo.commit({
      sessionId: sB.id,
      message: "c3",
      parentHash: c1.hash,
      stateEntries: [
        { path: "a", content: "v1" },
        { path: "c", content: "vC" },
      ],
    });
    repo.createBranch("featA", c2.hash);
    repo.createBranch("featB", c3.hash);
    repo.index.close();

    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      cherryPickCommand(agentgitDir, "featA", { onto: "featB" }),
    ).toBe(0);

    const repo2 = Repository.open(agentgitDir);
    const head = repo2.getBranch("featB")!;
    // Branch advanced past c3.
    expect(head).not.toBe(c3.hash);
    const commits = repo2.index.getCommitsBySession(sB.id);
    expect(commits.length).toBe(2);
    const newest = commits[commits.length - 1]!;
    expect(newest.hash).toBe(head);
    expect(newest.parent).toBe(c3.hash);
    expect(newest.metadata.cherryPickedFrom).toBe(c2.hash);
    repo2.index.close();
  });

  it("exits 1 and writes CONFLICT/<path> on path-level conflict", () => {
    initCommand(tmpDir);
    const repo = Repository.open(agentgitDir);
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = repo.commit({
      sessionId: sA.id,
      message: "c1",
      parentHash: null,
      stateEntries: [{ path: "shared.txt", content: "base" }],
    });
    const c2 = repo.commit({
      sessionId: sA.id,
      message: "c2",
      parentHash: c1.hash,
      stateEntries: [{ path: "shared.txt", content: "source-version" }],
    });
    const c3 = repo.commit({
      sessionId: sB.id,
      message: "c3",
      parentHash: c1.hash,
      stateEntries: [{ path: "shared.txt", content: "target-version" }],
    });
    repo.createBranch("src", c2.hash);
    repo.createBranch("dst", c3.hash);
    repo.index.close();

    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      errs.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      cherryPickCommand(agentgitDir, "src", { onto: "dst" }),
    ).toBe(1);

    // Conflict directory + source-side blob present.
    const conflictPath = join(agentgitDir, "CONFLICT", "shared.txt");
    expect(existsSync(conflictPath)).toBe(true);
    expect(readFileSync(conflictPath, "utf-8")).toBe("source-version");
    expect(errs.some((e) => e.includes("shared.txt"))).toBe(true);

    // Target branch untouched.
    const repo2 = Repository.open(agentgitDir);
    expect(repo2.getBranch("dst")).toBe(c3.hash);
    expect(repo2.index.getCommitsBySession(sB.id)).toHaveLength(1);
    repo2.index.close();
  });
});
