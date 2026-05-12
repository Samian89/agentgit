import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
export class RefStore {
  private readonly refsDir: string;
  private readonly headPath: string;

  constructor(private readonly agentgitDir: string) {
    this.refsDir = join(agentgitDir, "refs");
    this.headPath = join(agentgitDir, "HEAD");
    mkdirSync(this.refsDir, { recursive: true });
  }

  /** Read HEAD as-is (symbolic or bare hash). Returns "" if HEAD does not exist. */
  getHead(): string {
    if (!existsSync(this.headPath)) return "";
    return readFileSync(this.headPath, "utf8").trim();
  }

  /** Write HEAD. target may be "ref: refs/…" or a bare hash. */
  setHead(target: string): void {
    writeFileSync(this.headPath, target, "utf8");
  }

  /**
   * Resolve HEAD to a commit hash, following one level of symbolic indirection.
   * Returns null if HEAD is unset or the pointed-to ref does not exist.
   */
  resolveHead(): Hash | null {
    const head = this.getHead();
    if (!head) return null;
    if (head.startsWith("ref: ")) {
      // HEAD stores absolute ref path from agentgitDir: "refs/sessions/foo"
      // getRef expects path relative to refs/: "sessions/foo"
      const absRef = head.slice(5);
      const relRef = absRef.startsWith("refs/") ? absRef.slice(5) : absRef;
      return this.getRef(relRef);
    }
    return head;
  }

  /** Read a named ref. Returns null if the ref does not exist. */
  getRef(name: string): Hash | null {
    const refPath = join(this.refsDir, ...name.split("/"));
    if (!existsSync(refPath)) return null;
    return readFileSync(refPath, "utf8").trim();
  }

  /** Create or overwrite a named ref. */
  setRef(name: string, hash: Hash): void {
    const parts = name.split("/");
    const refPath = join(this.refsDir, ...parts);
    if (parts.length > 1) {
      mkdirSync(join(this.refsDir, ...parts.slice(0, -1)), { recursive: true });
    }
    writeFileSync(refPath, hash, "utf8");
  }

  /** Delete a named ref (no-op if it does not exist). */
  deleteRef(name: string): void {
    const refPath = join(this.refsDir, ...name.split("/"));
    if (existsSync(refPath)) unlinkSync(refPath);
  }

  /** Return all refs as {name, hash} pairs. */
  listRefs(): Array<{ name: string; hash: Hash }> {
    const result: Array<{ name: string; hash: Hash }> = [];
    this.collectRefs(this.refsDir, "", result);
    return result;
  }

  private collectRefs(
    dir: string,
    prefix: string,
    result: Array<{ name: string; hash: Hash }>,
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        this.collectRefs(full, name, result);
      } else {
        result.push({ name, hash: readFileSync(full, "utf8").trim() });
      }
    }
  }
}
