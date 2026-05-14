/**
 * Minimal POSIX ustar tar writer/reader.
 *
 * Used by the `.agentgit-bundle` format. Operates on Uint8Array so the same
 * code runs unchanged in Node and the browser. Only the subset of features
 * needed by AgentGit is implemented:
 *   - regular files only (typeflag '0')
 *   - filename ≤ 100 bytes (no long-link extensions)
 *   - no symlinks, devices, sparse files, ownership metadata, or PAX headers
 *
 * Bundles produced by this module are still legal ustar archives and can be
 * extracted with `tar -xf` for inspection.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK_SIZE = 512;
const TYPEFLAG_FILE = 0x30; // ASCII '0'

function writeOctal(
  buf: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  // POSIX: `length-1` octal digits, NUL-terminated.
  const digits = length - 1;
  const str = value.toString(8).padStart(digits, "0");
  for (let i = 0; i < digits; i++) buf[offset + i] = str.charCodeAt(i);
  buf[offset + digits] = 0;
}

function writeString(
  buf: Uint8Array,
  offset: number,
  maxLen: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > maxLen) {
    throw new Error(
      `tar: string too long (max ${maxLen}, got ${bytes.length}): ${value}`,
    );
  }
  buf.set(bytes, offset);
}

function makeHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);

  // Checksum field: filled with spaces while the checksum is being computed.
  for (let i = 148; i < 156; i++) header[i] = 0x20;

  header[156] = TYPEFLAG_FILE;
  writeString(header, 257, 6, "ustar");
  // version "00" (two ASCII zeroes, no NUL terminator)
  header[263] = 0x30;
  header[264] = 0x30;

  let cksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) cksum += header[i]!;
  writeOctal(header, 148, 8, cksum);

  return header;
}

/** Build a ustar archive from `entries`. Returns the raw uncompressed bytes. */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  let total = 0;
  for (const e of entries) {
    total += BLOCK_SIZE + Math.ceil(e.data.length / BLOCK_SIZE) * BLOCK_SIZE;
  }
  // Two zero blocks mark end-of-archive.
  total += BLOCK_SIZE * 2;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of entries) {
    out.set(makeHeader(e.name, e.data.length), offset);
    offset += BLOCK_SIZE;
    out.set(e.data, offset);
    offset += Math.ceil(e.data.length / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return out;
}

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

/** Parse a ustar archive into its file entries. */
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
