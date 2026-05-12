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

/**
 * SHA-256 of the canonical JSON representation of obj.
 * The `hash` field is stripped before hashing so the digest is stable.
 */
export function sha256(obj: unknown): string {
  let target = obj;
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    if ("hash" in record) {
      const { hash: _h, ...rest } = record;
      target = rest;
    }
  }
  return createHash("sha256").update(canonicalJson(target), "utf8").digest("hex");
}
