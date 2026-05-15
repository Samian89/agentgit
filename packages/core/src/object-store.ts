import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson, sha256 } from "./hash.js";
import type { Reporter } from "./telemetry/reporter.js";
import { safeRecord } from "./telemetry/reporter.js";
import type { Hash } from "./types.js";

/**
 * Content-addressed file store under .agentgit/objects/.
 * Objects are sharded: objects/<2-char prefix>/<62-char suffix>.
 * Files contain the canonical JSON of the object without the `hash` field.
 *
 * @public
 */
export class ObjectStore {
  /**
   * @param objectsDir - absolute path to the `.agentgit/objects` directory.
   * @param reporter - optional telemetry sink; emit no spans when `null`.
   */
  constructor(
    private readonly objectsDir: string,
    private readonly reporter: Reporter | null = null,
  ) {
    mkdirSync(objectsDir, { recursive: true });
  }

  private objectPath(hash: Hash): string {
    const prefix = hash.slice(0, 2);
    const suffix = hash.slice(2);
    return join(this.objectsDir, prefix, suffix);
  }

  /**
   * Write obj to the store, returning its deterministic SHA-256 hash.
   * Idempotent: if the object already exists the file is not overwritten.
   * The `hash` field is stripped before computing the canonical digest.
   */
  write(obj: Record<string, unknown>): Hash {
    const t0 = performance.now();
    const stripped = Object.fromEntries(
      Object.entries(obj).filter(
        ([k]) => k !== "hash" && k !== "signature" && k !== "publicKey",
      ),
    );
    const hash = sha256(stripped);
    const path = this.objectPath(hash);

    let wrote = false;
    if (!existsSync(path)) {
      mkdirSync(join(this.objectsDir, hash.slice(0, 2)), { recursive: true });
      writeFileSync(path, canonicalJson(stripped), "utf8");
      wrote = true;
    }

    safeRecord(this.reporter, {
      name: "objectstore.write",
      durationMs: performance.now() - t0,
      // Privacy: no object body, hash, or type label. Boolean dedupe signal only.
      attrs: { deduped: !wrote },
    });

    return hash;
  }

  /**
   * Read and parse the object identified by hash.
   * The returned object does NOT include a `hash` field; callers should attach it.
   */
  read(hash: Hash): Record<string, unknown> {
    const t0 = performance.now();
    const path = this.objectPath(hash);
    if (!existsSync(path)) {
      throw new Error(`Object not found: ${hash}`);
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    safeRecord(this.reporter, {
      name: "objectstore.read",
      durationMs: performance.now() - t0,
      // Privacy: no hash, body, or type label.
    });
    return parsed;
  }

  /** Return true if the object identified by hash exists in the store. */
  has(hash: Hash): boolean {
    return existsSync(this.objectPath(hash));
  }
}
