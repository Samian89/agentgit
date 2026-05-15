/**
 * Browser copy of the minimal POSIX ustar reader used by `.agentgit-bundle`.
 * Mirrors packages/core/src/bundle/tar.ts so the web viewer has no Node
 * dependencies (no `node:fs`, no `better-sqlite3`).
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK_SIZE = 512;

function parseOctal(buf: Uint8Array, offset: number, length: number): number {
  let s = "";
  for (let i = 0; i < length; i++) {
    const c = buf[offset + i]!;
    if (c === 0 || c === 0x20) break;
    s += String.fromCharCode(c);
  }
  return s === "" ? 0 : parseInt(s, 8);
}

function readCString(buf: Uint8Array, offset: number, maxLen: number): string {
  let end = offset;
  const limit = offset + maxLen;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function isAllZero(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

export function readTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    if (isAllZero(header)) break;

    const name = readCString(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    offset += BLOCK_SIZE;

    if (offset + size > buf.length) {
      throw new Error(
        `tar: entry '${name}' size ${size} exceeds buffer length`,
      );
    }
    const data = buf.slice(offset, offset + size);
    out.push({ name, data });
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return out;
}
