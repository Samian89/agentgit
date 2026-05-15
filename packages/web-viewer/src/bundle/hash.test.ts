import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts top-level keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts keys at every nesting level (not just the top)", () => {
    const out = canonicalJson({ outer: { z: 1, a: 2 }, alpha: { y: 3, b: 4 } });
    expect(out).toBe('{"alpha":{"b":4,"y":3},"outer":{"a":2,"z":1}}');
  });

  it("preserves array element order (arrays are sequences, not sets)", () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("sorts keys inside objects nested in arrays", () => {
    const out = canonicalJson({ items: [{ z: 1, a: 2 }, { b: 3, a: 4 }] });
    expect(out).toBe('{"items":[{"a":2,"z":1},{"a":4,"b":3}]}');
  });

  it("passes primitive values through unchanged", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(true)).toBe("true");
  });

  it("is deterministic across permutations of the same logical object", () => {
    const a = canonicalJson({ a: 1, b: { y: 2, x: 3 }, c: [4, 5] });
    const b = canonicalJson({ c: [4, 5], a: 1, b: { x: 3, y: 2 } });
    expect(a).toBe(b);
  });
});

describe("sha256", () => {
  it("returns a 64-character lowercase hex string", async () => {
    const h = await sha256({ msg: "hello" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same digest regardless of input key order (canonicalisation)", async () => {
    const a = await sha256({ a: 1, b: 2, c: 3 });
    const b = await sha256({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("strips the non-content fields hash / signature / publicKey before hashing", async () => {
    const base = { type: "commit", message: "x", tree: "t" };
    const withHashField = { ...base, hash: "deadbeef" };
    const withSignature = { ...base, signature: "anything-here" };
    const withPublicKey = { ...base, publicKey: "key-bytes" };
    const baseDigest = await sha256(base);
    expect(await sha256(withHashField)).toBe(baseDigest);
    expect(await sha256(withSignature)).toBe(baseDigest);
    expect(await sha256(withPublicKey)).toBe(baseDigest);
  });

  it("does NOT strip non-content fields nested inside child objects", async () => {
    // The stripping is intentionally top-level only (mirrors core/src/hash.ts).
    // A nested `hash` is part of the content and must affect the digest.
    const a = await sha256({ child: { value: 1 } });
    const b = await sha256({ child: { value: 1, hash: "irrelevant-here" } });
    expect(a).not.toBe(b);
  });

  it("distinguishes objects that differ only in a content field", async () => {
    const a = await sha256({ message: "v1" });
    const b = await sha256({ message: "v2" });
    expect(a).not.toBe(b);
  });

  it("hashes arrays without applying the field-stripping logic", async () => {
    // sha256 only filters when the *top-level* value is a non-array object.
    // For an array, the digest is over the raw canonicalJson of the array.
    const arr = [1, 2, 3];
    const digest = await sha256(arr);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(await sha256([3, 2, 1]));
  });

  it("hashes the all-zero / empty object to a stable digest", async () => {
    const a = await sha256({});
    const b = await sha256({});
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
