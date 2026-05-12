import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../hash.js";
describe("canonicalJson", () => {
    it("sorts top-level keys lexicographically", () => {
        const result = canonicalJson({ z: 1, a: 2, m: 3 });
        expect(result).toBe('{"a":2,"m":3,"z":1}');
    });
    it("sorts nested object keys recursively", () => {
        const result = canonicalJson({ b: { d: 4, c: 3 }, a: 2 });
        expect(result).toBe('{"a":2,"b":{"c":3,"d":4}}');
    });
    it("preserves array order", () => {
        const result = canonicalJson({ arr: [3, 1, 2] });
        expect(result).toBe('{"arr":[3,1,2]}');
    });
    it("is deterministic regardless of insertion order", () => {
        const a = canonicalJson({ x: 1, y: 2 });
        const b = canonicalJson({ y: 2, x: 1 });
        expect(a).toBe(b);
    });
    it("handles null values", () => {
        expect(canonicalJson({ a: null })).toBe('{"a":null}');
    });
});
describe("sha256", () => {
    it("returns 64-character lowercase hex string", () => {
        const hash = sha256({ type: "blob", content: "hello" });
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
    it("is deterministic for the same content", () => {
        const obj = { type: "blob", content: "hello", size: 5 };
        expect(sha256(obj)).toBe(sha256(obj));
    });
    it("differs for different content", () => {
        expect(sha256({ content: "hello" })).not.toBe(sha256({ content: "world" }));
    });
    it("strips the hash field before computing the digest", () => {
        const withHash = { type: "blob", content: "hi", hash: "deadbeef" };
        const withoutHash = { type: "blob", content: "hi" };
        expect(sha256(withHash)).toBe(sha256(withoutHash));
    });
    it("produces the same hash regardless of key insertion order", () => {
        const a = sha256({ type: "blob", content: "x", size: 1 });
        const b = sha256({ size: 1, content: "x", type: "blob" });
        expect(a).toBe(b);
    });
});
//# sourceMappingURL=hash.test.js.map