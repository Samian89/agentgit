import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefStore } from "../ref-store.js";
const FAKE_HASH = "a".repeat(64);
const FAKE_HASH_2 = "b".repeat(64);
let dir;
let refs;
beforeEach(() => {
    dir = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    refs = new RefStore(dir);
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});
describe("RefStore HEAD", () => {
    it("returns '' when HEAD does not exist", () => {
        expect(refs.getHead()).toBe("");
    });
    it("stores and retrieves a symbolic HEAD", () => {
        refs.setHead("ref: refs/sessions/main");
        expect(refs.getHead()).toBe("ref: refs/sessions/main");
    });
    it("stores and retrieves a detached HEAD", () => {
        refs.setHead(FAKE_HASH);
        expect(refs.getHead()).toBe(FAKE_HASH);
    });
    it("resolveHead returns null when HEAD is unset", () => {
        expect(refs.resolveHead()).toBeNull();
    });
    it("resolveHead follows a symbolic ref", () => {
        refs.setRef("sessions/main", FAKE_HASH);
        refs.setHead("ref: refs/sessions/main");
        expect(refs.resolveHead()).toBe(FAKE_HASH);
    });
    it("resolveHead returns the bare hash for a detached HEAD", () => {
        refs.setHead(FAKE_HASH);
        expect(refs.resolveHead()).toBe(FAKE_HASH);
    });
    it("resolveHead returns null when the pointed-to ref does not exist", () => {
        refs.setHead("ref: refs/sessions/nonexistent");
        expect(refs.resolveHead()).toBeNull();
    });
});
describe("RefStore named refs", () => {
    it("returns null for a ref that does not exist", () => {
        expect(refs.getRef("sessions/main")).toBeNull();
    });
    it("sets and gets a simple ref", () => {
        refs.setRef("sessions/main", FAKE_HASH);
        expect(refs.getRef("sessions/main")).toBe(FAKE_HASH);
    });
    it("overwrites an existing ref", () => {
        refs.setRef("sessions/main", FAKE_HASH);
        refs.setRef("sessions/main", FAKE_HASH_2);
        expect(refs.getRef("sessions/main")).toBe(FAKE_HASH_2);
    });
    it("handles nested ref names", () => {
        refs.setRef("sessions/my-agent/branch-1", FAKE_HASH);
        expect(refs.getRef("sessions/my-agent/branch-1")).toBe(FAKE_HASH);
    });
    it("deletes a ref", () => {
        refs.setRef("sessions/main", FAKE_HASH);
        refs.deleteRef("sessions/main");
        expect(refs.getRef("sessions/main")).toBeNull();
    });
    it("deleteRef is a no-op for non-existent ref", () => {
        expect(() => refs.deleteRef("sessions/nonexistent")).not.toThrow();
    });
});
describe("RefStore.listRefs", () => {
    it("returns empty array when no refs exist", () => {
        expect(refs.listRefs()).toEqual([]);
    });
    it("returns all refs", () => {
        refs.setRef("sessions/main", FAKE_HASH);
        refs.setRef("tags/v1", FAKE_HASH_2);
        const list = refs.listRefs();
        expect(list).toHaveLength(2);
        expect(list.map((r) => r.name)).toContain("sessions/main");
        expect(list.map((r) => r.name)).toContain("tags/v1");
    });
    it("returns correct hash per ref", () => {
        refs.setRef("sessions/a", FAKE_HASH);
        const [entry] = refs.listRefs();
        expect(entry?.hash).toBe(FAKE_HASH);
    });
});
//# sourceMappingURL=ref-store.test.js.map