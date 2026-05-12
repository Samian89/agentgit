/** Serialise obj to canonical JSON with lexicographically sorted keys at every level. */
export declare function canonicalJson(obj: unknown): string;
/**
 * SHA-256 of the canonical JSON representation of obj.
 * The `hash` field is stripped before hashing so the digest is stable.
 */
export declare function sha256(obj: unknown): string;
//# sourceMappingURL=hash.d.ts.map