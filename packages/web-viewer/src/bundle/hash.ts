/**
 * Browser-safe SHA-256 over the canonical JSON of an object. Stays in sync
 * with packages/core/src/hash.ts — `hash`, `signature`, and `publicKey` are
 * stripped before hashing, and keys are sorted lexicographically at every
 * nesting level.
 */

const NON_CONTENT_FIELDS = new Set(["hash", "signature", "publicKey"]);

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

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, sortedReplacer);
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

export async function sha256(obj: unknown): Promise<string> {
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
  const data = new TextEncoder().encode(canonicalJson(target));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}
