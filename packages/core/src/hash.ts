import { createHash } from "node:crypto";

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(record).sort()) {
      sorted[k] = record[k];
    }
    return sorted;
  }
  return value;
}

/** Serialise obj to canonical JSON with lexicographically sorted keys at every level. */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, sortedReplacer);
}

/** Fields stripped from objects before hashing — they are derived/attached afterwards. */
const NON_CONTENT_FIELDS = new Set(["hash", "signature", "publicKey"]);

/**
 * SHA-256 of the canonical JSON representation of obj.
 * The `hash`, `signature`, and `publicKey` fields are stripped before hashing
 * so the digest is stable regardless of whether a signature is attached.
 */
export function sha256(obj: unknown): string {
  let target = obj;
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    let stripped = false;
    for (const [k, v] of Object.entries(record)) {
      if (NON_CONTENT_FIELDS.has(k)) {
        stripped = true;
        continue;
      }
      filtered[k] = v;
    }
    if (stripped) target = filtered;
  }
  return createHash("sha256").update(canonicalJson(target), "utf8").digest("hex");
}
