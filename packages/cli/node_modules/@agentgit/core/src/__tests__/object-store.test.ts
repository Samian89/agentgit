import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectStore } from "../object-store.js";
import { sha256 } from "../hash.js";

let dir: string;
let store: ObjectStore;

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  store = new ObjectStore(join(dir, "objects"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ObjectStore.write", () => {
  it("returns a deterministic 64-char SHA-256 hex hash", () => {
    const hash = store.write({ type: "blob", content: "hello", size: 5 });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same hash for identical content regardless of key order", () => {
    const h1 = store.write({ type: "blob", content: "hi", size: 2 });
    const h2 = store.write({ size: 2, content: "hi", type: "blob" });
    expect(h1).toBe(h2);
  });

  it("strips the hash field when computing the digest", () => {
    const withHash = store.write({ type: "blob", content: "hi", hash: "deadbeef" });
    const withoutHash = store.write({ type: "blob", content: "hi" });
    expect(withHash).toBe(withoutHash);
  });

  it("is idempotent — writing the same object twice does not throw", () => {
    const obj = { type: "blob", content: "idempotent", size: 10 };
    const h1 = store.write(obj);
    const h2 = store.write(obj);
    expect(h1).toBe(h2);
  });

  it("matches sha256() of the content without hash field", () => {
    const obj = { type: "blob", content: "test", size: 4 };
    const hash = store.write(obj);
    expect(hash).toBe(sha256(obj));
  });
});

describe("ObjectStore.read", () => {
  it("round-trips an object back to its original content", () => {
    const obj = { type: "blob", content: "round-trip", size: 10, encoding: "utf-8" };
    const hash = store.write(obj);
    const result = store.read(hash);
    expect(result).toEqual(obj);
  });

  it("throws for an unknown hash", () => {
    const fakeHash = "a".repeat(64);
    expect(() => store.read(fakeHash)).toThrow(/not found/i);
  });

  it("stores object without the hash field", () => {
    const obj = { type: "blob", content: "no-hash", hash: "shouldbestripped" };
    const hash = store.write(obj);
    const result = store.read(hash);
    expect(result).not.toHaveProperty("hash");
  });
});

describe("ObjectStore.has", () => {
  it("returns false for missing objects", () => {
    expect(store.has("b".repeat(64))).toBe(false);
  });

  it("returns true after writing an object", () => {
    const hash = store.write({ type: "blob", content: "exists" });
    expect(store.has(hash)).toBe(true);
  });
});
