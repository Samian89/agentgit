import type { Hash } from "./types.js";
/**
 * Content-addressed file store under .agentgit/objects/.
 * Objects are sharded: objects/<2-char prefix>/<62-char suffix>.
 * Files contain the canonical JSON of the object without the `hash` field.
 */
export declare class ObjectStore {
    private readonly objectsDir;
    constructor(objectsDir: string);
    private objectPath;
    /**
     * Write obj to the store, returning its deterministic SHA-256 hash.
     * Idempotent: if the object already exists the file is not overwritten.
     * The `hash` field is stripped before computing the canonical digest.
     */
    write(obj: Record<string, unknown>): Hash;
    /**
     * Read and parse the object identified by hash.
     * The returned object does NOT include a `hash` field; callers should attach it.
     */
    read(hash: Hash): Record<string, unknown>;
    /** Return true if the object identified by hash exists in the store. */
    has(hash: Hash): boolean;
}
//# sourceMappingURL=object-store.d.ts.map