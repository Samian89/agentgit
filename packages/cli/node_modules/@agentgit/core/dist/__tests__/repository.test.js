import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
let dir;
let repo;
beforeEach(() => {
    dir = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    repo = Repository.init(join(dir, ".agentgit"));
});
afterEach(() => {
    repo.index.close();
    rmSync(dir, { recursive: true, force: true });
});
describe("Repository.init", () => {
    it("creates a repository without throwing", () => {
        expect(repo).toBeInstanceOf(Repository);
    });
    it("is idempotent — calling init twice does not throw", () => {
        const repo2 = Repository.init(join(dir, ".agentgit"));
        repo2.index.close();
        expect(repo2).toBeInstanceOf(Repository);
    });
});
describe("Repository.createSession", () => {
    it("returns a session with an id and active status", () => {
        const session = repo.createSession("fix-bug");
        expect(session.id).toBeDefined();
        expect(session.status).toBe("active");
        expect(session.head).toBeNull();
    });
    it("persists the session to the index", () => {
        const session = repo.createSession("fix-bug");
        const got = repo.getSession(session.id);
        expect(got?.name).toBe("fix-bug");
    });
    it("getSession returns null for an unknown id", () => {
        expect(repo.getSession("nonexistent")).toBeNull();
    });
});
describe("Repository.commit", () => {
    it("returns a commit with a 64-char hash", () => {
        const session = repo.createSession("s1");
        const commit = repo.commit({
            sessionId: session.id,
            message: "first commit",
            stateEntries: [{ path: "file.txt", content: "hello" }],
        });
        expect(commit.hash).toHaveLength(64);
        expect(commit.hash).toMatch(/^[0-9a-f]{64}$/);
    });
    it("persists commit to object store and SQLite index", () => {
        const session = repo.createSession("s1");
        const commit = repo.commit({
            sessionId: session.id,
            message: "first",
            stateEntries: [{ path: "a.txt", content: "data" }],
        });
        expect(repo.objects.has(commit.hash)).toBe(true);
        expect(repo.index.getCommit(commit.hash)).not.toBeNull();
    });
    it("updates the session head after committing", () => {
        const session = repo.createSession("s1");
        const commit = repo.commit({ sessionId: session.id, message: "c1" });
        expect(repo.getSession(session.id)?.head).toBe(commit.hash);
    });
    it("links parent commits correctly", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({ sessionId: session.id, message: "c1" });
        const c2 = repo.commit({ sessionId: session.id, message: "c2" });
        expect(c2.parent).toBe(c1.hash);
    });
    it("root commit has null parent", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({ sessionId: session.id, message: "root" });
        expect(c1.parent).toBeNull();
    });
    it("is deterministic — same content produces the same tree hash", () => {
        const session1 = repo.createSession("s1");
        const c1 = repo.commit({
            sessionId: session1.id,
            message: "same",
            stateEntries: [{ path: "f.txt", content: "abc" }],
            metadata: {},
        });
        // Build a second repo with its own session — tree hash must still match.
        const dir2 = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
        mkdirSync(dir2, { recursive: true });
        const repo2 = Repository.init(join(dir2, ".agentgit"));
        const session2 = repo2.createSession("s2");
        const c2 = repo2.commit({
            sessionId: session2.id,
            message: "same",
            stateEntries: [{ path: "f.txt", content: "abc" }],
            metadata: {},
        });
        repo2.index.close();
        rmSync(dir2, { recursive: true, force: true });
        // Different session/parent → different commit hash, but identical tree content
        // must produce the same tree hash (content-addressed).
        expect(c1.tree).toBe(c2.tree);
    });
});
describe("Repository.log", () => {
    it("returns commits in ascending timestamp order", () => {
        const session = repo.createSession("s1");
        repo.commit({ sessionId: session.id, message: "c1" });
        repo.commit({ sessionId: session.id, message: "c2" });
        repo.commit({ sessionId: session.id, message: "c3" });
        const commits = repo.log(session.id);
        expect(commits.map((c) => c.message)).toEqual(["c1", "c2", "c3"]);
    });
    it("returns [] for a session with no commits", () => {
        const session = repo.createSession("empty");
        expect(repo.log(session.id)).toEqual([]);
    });
});
describe("Repository.ancestors", () => {
    it("returns commit hashes newest-first", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({ sessionId: session.id, message: "c1" });
        const c2 = repo.commit({ sessionId: session.id, message: "c2" });
        const c3 = repo.commit({ sessionId: session.id, message: "c3" });
        expect(repo.ancestors(c3.hash)).toEqual([c3.hash, c2.hash, c1.hash]);
    });
});
describe("Repository.diff", () => {
    it("reports added files", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({ sessionId: session.id, message: "empty" });
        const c2 = repo.commit({
            sessionId: session.id,
            message: "add file",
            stateEntries: [{ path: "new.txt", content: "hello" }],
        });
        const diff = repo.diff(c1.hash, c2.hash);
        expect(diff.added).toHaveLength(1);
        expect(diff.added[0]?.path).toBe("new.txt");
        expect(diff.removed).toHaveLength(0);
        expect(diff.modified).toHaveLength(0);
    });
    it("reports removed files", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({
            sessionId: session.id,
            message: "with file",
            stateEntries: [{ path: "old.txt", content: "bye" }],
        });
        const c2 = repo.commit({ sessionId: session.id, message: "remove file" });
        const diff = repo.diff(c1.hash, c2.hash);
        expect(diff.removed).toHaveLength(1);
        expect(diff.removed[0]?.path).toBe("old.txt");
    });
    it("reports modified files", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({
            sessionId: session.id,
            message: "v1",
            stateEntries: [{ path: "f.txt", content: "old" }],
        });
        const c2 = repo.commit({
            sessionId: session.id,
            message: "v2",
            stateEntries: [{ path: "f.txt", content: "new-content" }],
        });
        const diff = repo.diff(c1.hash, c2.hash);
        expect(diff.modified).toHaveLength(1);
        expect(diff.modified[0]?.path).toBe("f.txt");
    });
    it("reports empty diff for identical trees", () => {
        const session = repo.createSession("s1");
        const c1 = repo.commit({
            sessionId: session.id,
            message: "v1",
            stateEntries: [{ path: "f.txt", content: "same" }],
        });
        // Force same content → same blob hash
        const c2 = repo.commit({
            sessionId: session.id,
            message: "v2",
            stateEntries: [{ path: "f.txt", content: "same" }],
        });
        const diff = repo.diff(c1.hash, c2.hash);
        expect(diff.added).toHaveLength(0);
        expect(diff.removed).toHaveLength(0);
        expect(diff.modified).toHaveLength(0);
    });
});
describe("Repository branches", () => {
    it("createBranch sets a file ref and upserts SQLite ref", () => {
        const session = repo.createSession("s1");
        const commit = repo.commit({ sessionId: session.id, message: "c1" });
        repo.createBranch("feature-x", commit.hash);
        expect(repo.getBranch("feature-x")).toBe(commit.hash);
        expect(repo.index.getRef("sessions/feature-x")?.target).toBe(commit.hash);
    });
    it("getBranch returns null for unknown branches", () => {
        expect(repo.getBranch("nonexistent")).toBeNull();
    });
});
//# sourceMappingURL=repository.test.js.map