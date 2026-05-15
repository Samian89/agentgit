import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import type { Hash, ToolCall } from "../types.js";

let dir: string;
let agentgitDir: string;
let repo: Repository;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-cherry-pick-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  agentgitDir = join(dir, ".agentgit");
  repo = Repository.init(agentgitDir);
});

afterEach(() => {
  try {
    repo.index.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: crypto.randomUUID(),
    name,
    input,
    output: { ok: true },
    startedAt: Date.now(),
    completedAt: Date.now(),
    status: "success",
    error: null,
  };
}

function commit(
  sessionId: string,
  message: string,
  parent: Hash | null,
  files: Record<string, string>,
  toolCall: ToolCall | null = null,
): Hash {
  return repo.commit({
    sessionId,
    message,
    parentHash: parent,
    stateEntries: Object.entries(files).map(([path, content]) => ({
      path,
      content,
    })),
    toolCall,
  }).hash;
}

describe("cherryPick — happy path", () => {
  it("replays source commits onto target with new hashes and matching tool calls", () => {
    // base: c1 (a=v1)
    // source A: c1 -> c2 (adds b=vB) -> c3 (modifies b)
    // target B: c1 -> c4 (adds c=vC)
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "a.txt": "v1" });

    // Source chain
    const tc2 = makeToolCall("write_file", { path: "b.txt" });
    const c2 = commit(sA.id, "c2", c1, { "a.txt": "v1", "b.txt": "vB" }, tc2);
    const tc3 = makeToolCall("write_file", { path: "b.txt", revision: 2 });
    const c3 = commit(sA.id, "c3", c2, { "a.txt": "v1", "b.txt": "vB2" }, tc3);

    // Target chain forking off c1
    const c4 = commit(sB.id, "c4", c1, { "a.txt": "v1", "c.txt": "vC" });
    repo.createBranch("featureA", c3);
    repo.createBranch("main", c4);

    const result = repo.cherryPick({
      sourceRef: "featureA",
      targetRef: "main",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return; // narrow

    expect(result.mergeBase).toBe(c1);
    expect(result.newCommits).toHaveLength(2);
    // Fresh hashes
    expect(result.newCommits).not.toContain(c2);
    expect(result.newCommits).not.toContain(c3);

    const [n1, n2] = result.newCommits;
    const newCommit1 = repo.index.getCommit(n1!)!;
    const newCommit2 = repo.index.getCommit(n2!)!;

    // Parents: first new commit parents the target head; chain continues.
    expect(newCommit1.parent).toBe(c4);
    expect(newCommit2.parent).toBe(n1);

    // Tool calls are preserved verbatim.
    expect(newCommit1.toolCall).toEqual(tc2);
    expect(newCommit2.toolCall).toEqual(tc3);

    // Messages are preserved.
    expect(newCommit1.message).toBe("c2");
    expect(newCommit2.message).toBe("c3");

    // Metadata records the cherry-pick provenance.
    expect(newCommit1.metadata.cherryPickedFrom).toBe(c2);
    expect(newCommit2.metadata.cherryPickedFrom).toBe(c3);

    // Resulting state at new head: combines b.txt (from source) and c.txt
    // (from target).
    const finalTree = new Map(
      repo.index.getTreeEntries(newCommit2.tree).map((e) => [e.path, e]),
    );
    expect(finalTree.has("a.txt")).toBe(true);
    expect(finalTree.has("b.txt")).toBe(true);
    expect(finalTree.has("c.txt")).toBe(true);

    // The session that received the new commits is the target session B.
    expect(result.sessionId).toBe(sB.id);

    // Target branch ref has advanced.
    expect(repo.getBranch("main")).toBe(result.newHead);
  });

  it("creates a new session when --session is given", () => {
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "a.txt": "v1" });
    const c2 = commit(sA.id, "c2", c1, { "a.txt": "v2" });
    const c3 = commit(sB.id, "c3", c1, { "a.txt": "v1", "b.txt": "vB" });
    repo.createBranch("src", c2);
    repo.createBranch("dst", c3);

    const result = repo.cherryPick({
      sourceRef: "src",
      targetRef: "dst",
      sessionName: "picked",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sessionId).not.toBe(sA.id);
    expect(result.sessionId).not.toBe(sB.id);

    const session = repo.getSession(result.sessionId);
    expect(session?.name).toBe("picked");
  });
});

describe("cherryPick — conflict", () => {
  it("aborts non-zero, lists conflict paths, and leaves target untouched", () => {
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "shared.txt": "base" });

    // Source modifies shared.txt one way.
    const c2 = commit(sA.id, "c2", c1, { "shared.txt": "source-version" });
    // Target modifies shared.txt differently.
    const c3 = commit(sB.id, "c3", c1, { "shared.txt": "target-version" });

    repo.createBranch("src", c2);
    repo.createBranch("dst", c3);

    const result = repo.cherryPick({
      sourceRef: "src",
      targetRef: "dst",
    });

    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts).toEqual(["shared.txt"]);
    expect(result.mergeBase).toBe(c1);

    // Source-side blob materialised under .agentgit/CONFLICT/<path>.
    const conflictFile = join(agentgitDir, "CONFLICT", "shared.txt");
    expect(existsSync(conflictFile)).toBe(true);
    expect(readFileSync(conflictFile, "utf-8")).toBe("source-version");

    // Target session head unchanged; no extra commits were inserted.
    const sessionAfter = repo.getSession(sB.id)!;
    expect(sessionAfter.head).toBe(c3);
    expect(repo.index.getCommitsBySession(sB.id)).toHaveLength(1);

    // Target branch ref untouched.
    expect(repo.getBranch("dst")).toBe(c3);
  });
});

describe("cherryPick — mid-chain conflict invisible at source head", () => {
  it("detects a conflict on a path that source modified then reverted", () => {
    // base:           shared.txt = "base"
    // source c2:      shared.txt = "intermediate"    (modify)
    // source c3:      shared.txt = "base"            (revert — source head = base)
    // target c4:      shared.txt = "target-mod"
    //
    // The source-head tree is byte-identical to the merge base for
    // shared.txt, so a whole-tree comparison would see no source change and
    // miss the conflict. Per-step detection catches it: step c2 wants to
    // mutate shared.txt from "base" → "intermediate", but the simulated
    // target state has "target-mod", not "base".
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "shared.txt": "base" });
    const c2 = commit(sA.id, "c2", c1, { "shared.txt": "intermediate" });
    const c3 = commit(sA.id, "c3", c2, { "shared.txt": "base" });
    const c4 = commit(sB.id, "c4", c1, { "shared.txt": "target-mod" });

    repo.createBranch("src", c3);
    repo.createBranch("dst", c4);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts).toEqual(["shared.txt"]);
    expect(result.conflictingStep).toBe(c2);

    // CONFLICT/<path> holds the source step's *desired* blob ("intermediate"),
    // not the source-head blob ("base").
    const conflictFile = join(agentgitDir, "CONFLICT", "shared.txt");
    expect(existsSync(conflictFile)).toBe(true);
    expect(readFileSync(conflictFile, "utf-8")).toBe("intermediate");

    // Target untouched.
    expect(repo.getBranch("dst")).toBe(c4);
    expect(repo.index.getCommitsBySession(sB.id)).toHaveLength(1);
  });

  it("detects a conflict on a path source added then removed", () => {
    // base:           {}
    // source c2:      adds tmp.txt = "src-add"
    // source c3:      removes tmp.txt    (source head has no tmp.txt)
    // target c4:      adds tmp.txt = "target-add"
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "keep.txt": "k" });
    const c2 = commit(sA.id, "c2", c1, {
      "keep.txt": "k",
      "tmp.txt": "src-add",
    });
    const c3 = commit(sA.id, "c3", c2, { "keep.txt": "k" });
    const c4 = commit(sB.id, "c4", c1, {
      "keep.txt": "k",
      "tmp.txt": "target-add",
    });

    repo.createBranch("src", c3);
    repo.createBranch("dst", c4);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts).toEqual(["tmp.txt"]);
    expect(result.conflictingStep).toBe(c2);

    // Target untouched.
    expect(repo.getBranch("dst")).toBe(c4);
    expect(repo.index.getCommitsBySession(sB.id)).toHaveLength(1);
  });
});

describe("cherryPick — disjoint histories", () => {
  it("returns conflict with mergeBase=null and does not crash", () => {
    // Two sessions with no common ancestor commit; both touch the same
    // path. There is no merge base, so the previous implementation's
    // `mergeBase!` non-null assertion would smuggle a null through a
    // `Hash`-typed field and crash any consumer that called `shortHash`
    // on it.
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "shared.txt": "source" });
    const c2 = commit(sB.id, "c2", null, { "shared.txt": "target" });
    repo.createBranch("src", c1);
    repo.createBranch("dst", c2);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.mergeBase).toBeNull();
    expect(result.conflicts).toEqual(["shared.txt"]);
    // Result is consumable: no field is silently null behind a non-null type.
    expect(typeof result.conflictingStep).toBe("string");
    expect(typeof result.conflictDir).toBe("string");
  });
});

describe("cherryPick — path traversal hardening", () => {
  it("does not write conflict files outside the CONFLICT directory", () => {
    // Repository.commit doesn't currently accept ".." paths, but a bundle
    // import, a future adapter, or a hostile store could. Forge a tree
    // entry with a traversal path directly through the index to make
    // sure cherry-pick refuses to materialise it under CONFLICT/.
    //
    // The path has to appear in both source and target trees to land in
    // the conflict set (per-step detection only flags a path when both
    // sides touch it). The simplest way to force that is to forge two
    // disjoint roots that each contain the dangerous path.
    const evilPath = "../../../escaped.txt";

    function forgeRoot(
      sessionId: string,
      content: string,
    ): { commit: Hash; tree: Hash; blob: Hash } {
      const blobHash = repo.objects.write({
        type: "blob",
        content,
        size: Buffer.byteLength(content, "utf-8"),
        encoding: "utf-8",
        mimeType: null,
      });
      const treeHash = repo.objects.write({
        type: "tree",
        entries: [{ path: evilPath, blobHash, size: content.length }],
      });
      const commitBody = {
        type: "commit" as const,
        tree: treeHash,
        parent: null,
        sessionId,
        timestamp: Date.now(),
        message: "evil",
        toolCall: null,
        metadata: {},
        author: null,
      };
      const commitHash = repo.objects.write(
        commitBody as unknown as Record<string, unknown>,
      );
      repo.index.transaction(() => {
        repo.index.insertBlob({
          hash: blobHash,
          type: "blob",
          content,
          size: content.length,
          encoding: "utf-8",
          mimeType: null,
        });
        repo.index.insertTreeEntries(treeHash, [
          { path: evilPath, blobHash, size: content.length },
        ]);
        repo.index.insertCommit({
          hash: commitHash,
          signature: null,
          publicKey: null,
          ...commitBody,
        });
        repo.index.updateSessionHead(sessionId, commitHash, Date.now());
      });
      return { commit: commitHash, tree: treeHash, blob: blobHash };
    }

    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const src = forgeRoot(sA.id, "PWNED-source");
    const tgt = forgeRoot(sB.id, "target-version");
    repo.createBranch("src", src.commit);
    repo.createBranch("dst", tgt.commit);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;

    expect(result.conflicts).toContain(evilPath);
    expect(result.unsafePaths).toContain(evilPath);

    // Nothing was written outside CONFLICT/ — neither at the parent
    // directories of the agentgit dir nor under conflictDir/../...
    const escapedAtTmp = join(dir, "..", "..", "..", "escaped.txt");
    expect(existsSync(escapedAtTmp)).toBe(false);
    expect(
      existsSync(join(result.conflictDir, "..", "..", "..", "escaped.txt")),
    ).toBe(false);
    // CONFLICT/ should be empty (or at least contain no escaped.txt).
    expect(existsSync(join(result.conflictDir, "escaped.txt"))).toBe(false);
  });

  it("rejects Windows drive-relative paths even when not isAbsolute", () => {
    // `C:foo` (no separator after the colon) is NOT recognised as absolute
    // by Node's `path.isAbsolute`, but on Windows it can re-anchor onto
    // drive C's per-drive cwd when fed to `path.resolve`. The safety
    // check rejects it explicitly so the behaviour is identical on
    // POSIX (where it would just be a literal filename) and Windows.
    const drivePath = "C:foo.txt";

    function forgeRoot(sessionId: string, content: string): Hash {
      const blobHash = repo.objects.write({
        type: "blob",
        content,
        size: Buffer.byteLength(content, "utf-8"),
        encoding: "utf-8",
        mimeType: null,
      });
      const treeHash = repo.objects.write({
        type: "tree",
        entries: [{ path: drivePath, blobHash, size: content.length }],
      });
      const commitBody = {
        type: "commit" as const,
        tree: treeHash,
        parent: null,
        sessionId,
        timestamp: Date.now(),
        message: "evil-drive",
        toolCall: null,
        metadata: {},
        author: null,
      };
      const commitHash = repo.objects.write(
        commitBody as unknown as Record<string, unknown>,
      );
      repo.index.transaction(() => {
        repo.index.insertBlob({
          hash: blobHash,
          type: "blob",
          content,
          size: content.length,
          encoding: "utf-8",
          mimeType: null,
        });
        repo.index.insertTreeEntries(treeHash, [
          { path: drivePath, blobHash, size: content.length },
        ]);
        repo.index.insertCommit({
          hash: commitHash,
          signature: null,
          publicKey: null,
          ...commitBody,
        });
        repo.index.updateSessionHead(sessionId, commitHash, Date.now());
      });
      return commitHash;
    }

    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const src = forgeRoot(sA.id, "PWNED-source");
    const tgt = forgeRoot(sB.id, "target-version");
    repo.createBranch("src", src);
    repo.createBranch("dst", tgt);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts).toContain(drivePath);
    expect(result.unsafePaths).toContain(drivePath);
  });

  it("rejects absolute paths in conflict materialisation", () => {
    const absolutePath =
      process.platform === "win32" ? "C:/evil.txt" : "/etc/evil.txt";

    function forgeRoot(sessionId: string, content: string): Hash {
      const blobHash = repo.objects.write({
        type: "blob",
        content,
        size: Buffer.byteLength(content, "utf-8"),
        encoding: "utf-8",
        mimeType: null,
      });
      const treeHash = repo.objects.write({
        type: "tree",
        entries: [{ path: absolutePath, blobHash, size: content.length }],
      });
      const commitBody = {
        type: "commit" as const,
        tree: treeHash,
        parent: null,
        sessionId,
        timestamp: Date.now(),
        message: "evil-abs",
        toolCall: null,
        metadata: {},
        author: null,
      };
      const commitHash = repo.objects.write(
        commitBody as unknown as Record<string, unknown>,
      );
      repo.index.transaction(() => {
        repo.index.insertBlob({
          hash: blobHash,
          type: "blob",
          content,
          size: content.length,
          encoding: "utf-8",
          mimeType: null,
        });
        repo.index.insertTreeEntries(treeHash, [
          { path: absolutePath, blobHash, size: content.length },
        ]);
        repo.index.insertCommit({
          hash: commitHash,
          signature: null,
          publicKey: null,
          ...commitBody,
        });
        repo.index.updateSessionHead(sessionId, commitHash, Date.now());
      });
      return commitHash;
    }

    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const src = forgeRoot(sA.id, "PWNED-source");
    const tgt = forgeRoot(sB.id, "target-version");
    repo.createBranch("src", src);
    repo.createBranch("dst", tgt);

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;

    expect(result.unsafePaths).toContain(absolutePath);
  });
});

describe("cherryPick — apply-pass atomicity", () => {
  it("rolls back every commit when a mid-replay blob read fails", () => {
    // Build a clean two-step source on top of a shared base, with the
    // target forking off the same base.
    const sA = repo.createSession("A");
    const sB = repo.createSession("B");
    const c1 = commit(sA.id, "c1", null, { "a.txt": "v1" });
    const c2 = commit(sA.id, "c2", c1, { "a.txt": "v1", "b.txt": "vB" });
    const c3 = commit(sA.id, "c3", c2, { "a.txt": "v1", "b.txt": "vB2" });
    const c4 = commit(sB.id, "c4", c1, { "a.txt": "v1", "c.txt": "vC" });
    repo.createBranch("src", c3);
    repo.createBranch("dst", c4);

    // Snapshot target state before the cherry-pick.
    const targetSessionBefore = repo.getSession(sB.id)!;
    const commitsBefore = repo.index.getCommitsBySession(sB.id);

    // Sabotage the apply pass: delete the on-disk object file for one of
    // the source-side blobs that the second replayed commit will need
    // to read. The dry-run only inspects the index, so it doesn't notice
    // the file is gone — the failure surfaces in pass 2.
    const c3Tree = repo.index.getCommit(c3)!.tree;
    const bV2Blob = repo.index
      .getTreeEntries(c3Tree)
      .find((e) => e.path === "b.txt")!.blobHash;
    const objectFile = join(
      agentgitDir,
      "objects",
      bV2Blob.slice(0, 2),
      bV2Blob.slice(2),
    );
    rmSync(objectFile, { force: true });

    const result = repo.cherryPick({ sourceRef: "src", targetRef: "dst" });

    // The replay aborted with a clean error and rolled back the
    // SQLite transaction.
    expect(result.status).toBe("error");

    // Target session is untouched: head is still c4, commit count is
    // unchanged, branch ref still points at c4. No partial mutation.
    expect(repo.getSession(sB.id)!.head).toBe(targetSessionBefore.head);
    expect(repo.index.getCommitsBySession(sB.id)).toHaveLength(
      commitsBefore.length,
    );
    expect(repo.getBranch("dst")).toBe(c4);
  });
});

describe("cherryPick — noop edge cases", () => {
  it("is a noop when source equals target", () => {
    const s = repo.createSession("s");
    const c1 = commit(s.id, "c1", null, { "a.txt": "v1" });
    repo.createBranch("main", c1);

    const result = repo.cherryPick({ sourceRef: "main", targetRef: "main" });
    expect(result.status).toBe("noop");
  });

  it("is a noop when source is an ancestor of target", () => {
    const s = repo.createSession("s");
    const c1 = commit(s.id, "c1", null, { "a.txt": "v1" });
    const c2 = commit(s.id, "c2", c1, { "a.txt": "v2" });
    repo.createBranch("old", c1);
    repo.createBranch("new", c2);

    const result = repo.cherryPick({ sourceRef: "old", targetRef: "new" });
    expect(result.status).toBe("noop");
  });
});
