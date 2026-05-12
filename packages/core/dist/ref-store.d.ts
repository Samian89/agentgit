import type { Hash } from "./types.js";
/**
 * File-based ref storage mirroring git's refs/ layout.
 *
 * HEAD file contains either:
 *   "ref: refs/sessions/<sessionId>"  — symbolic ref
 *   "<64-char hex>"                   — detached HEAD
 *
 * Each named ref lives at .agentgit/refs/<name> containing a bare commit hash.
 */
export declare class RefStore {
    private readonly agentgitDir;
    private readonly refsDir;
    private readonly headPath;
    constructor(agentgitDir: string);
    /** Read HEAD as-is (symbolic or bare hash). Returns "" if HEAD does not exist. */
    getHead(): string;
    /** Write HEAD. target may be "ref: refs/…" or a bare hash. */
    setHead(target: string): void;
    /**
     * Resolve HEAD to a commit hash, following one level of symbolic indirection.
     * Returns null if HEAD is unset or the pointed-to ref does not exist.
     */
    resolveHead(): Hash | null;
    /** Read a named ref. Returns null if the ref does not exist. */
    getRef(name: string): Hash | null;
    /** Create or overwrite a named ref. */
    setRef(name: string, hash: Hash): void;
    /** Delete a named ref (no-op if it does not exist). */
    deleteRef(name: string): void;
    /** Return all refs as {name, hash} pairs. */
    listRefs(): Array<{
        name: string;
        hash: Hash;
    }>;
    private collectRefs;
}
//# sourceMappingURL=ref-store.d.ts.map