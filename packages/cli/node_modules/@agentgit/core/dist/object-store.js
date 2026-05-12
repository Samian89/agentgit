import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./hash.js";
/**
 * Content-addressed file store under .agentgit/objects/.
 * Objects are sharded: objects/<2-char prefix>/<62-char suffix>.
 * Files contain the canonical JSON of the object without the `hash` field.
 */
export class ObjectStore {
    objectsDir;
    constructor(objectsDir) {
        this.objectsDir = objectsDir;
        mkdirSync(objectsDir, { recursive: true });
    }
    objectPath(hash) {
        const prefix = hash.slice(0, 2);
        const suffix = hash.slice(2);
        return join(this.objectsDir, prefix, suffix);
    }
    /**
     * Write obj to the store, returning its deterministic SHA-256 hash.
     * Idempotent: if the object already exists the file is not overwritten.
     * The `hash` field is stripped before computing the canonical digest.
     */
    write(obj) {
        const withoutHash = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "hash"));
        const hash = sha256(withoutHash);
        const path = this.objectPath(hash);
        if (!existsSync(path)) {
            mkdirSync(join(this.objectsDir, hash.slice(0, 2)), { recursive: true });
            writeFileSync(path, canonicalJson(withoutHash), "utf8");
        }
        return hash;
    }
    /**
     * Read and parse the object identified by hash.
     * The returned object does NOT include a `hash` field; callers should attach it.
     */
    read(hash) {
        const path = this.objectPath(hash);
        if (!existsSync(path)) {
            throw new Error(`Object not found: ${hash}`);
        }
        return JSON.parse(readFileSync(path, "utf8"));
    }
    /** Return true if the object identified by hash exists in the store. */
    has(hash) {
        return existsSync(this.objectPath(hash));
    }
}
//# sourceMappingURL=object-store.js.map