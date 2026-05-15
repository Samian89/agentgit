import pako from "pako";
import { describe, expect, it } from "vitest";
import { readBundle } from "./unpack.js";
import { sha256 } from "./hash.js";
import {
  BUNDLE_FORMAT_VERSION,
  VIEWER_SCHEMA_VERSION,
  type BundleManifest,
  type Commit,
  type Ref,
  type Session,
  type TreeEntry,
} from "./types.js";

const BLOCK = 512;

function makeTarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const enc = new TextEncoder();
  header.set(enc.encode(name), 0);
  const writeOctal = (offset: number, length: number, value: number) => {
    const digits = length - 1;
    const str = value.toString(8).padStart(digits, "0");
    for (let i = 0; i < digits; i++) header[offset + i] = str.charCodeAt(i);
    header[offset + digits] = 0;
  };
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, size);
  writeOctal(136, 12, 0);
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  header[156] = 0x30;
  header.set(enc.encode("ustar"), 257);
  header[263] = 0x30;
  header[264] = 0x30;
  let cksum = 0;
  for (let i = 0; i < BLOCK; i++) cksum += header[i]!;
  writeOctal(148, 8, cksum);
  return header;
}

function writeTar(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  let total = BLOCK * 2;
  for (const e of entries) {
    total += BLOCK + Math.ceil(e.data.length / BLOCK) * BLOCK;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of entries) {
    out.set(makeTarHeader(e.name, e.data.length), offset);
    offset += BLOCK;
    out.set(e.data, offset);
    offset += Math.ceil(e.data.length / BLOCK) * BLOCK;
  }
  return out;
}

const enc = new TextEncoder();

interface BuiltBundle {
  bytes: Uint8Array;
  commitHash: string;
  treeHash: string;
  blobHash: string;
  sessionId: string;
}

interface BuildOptions {
  formatVersion?: number;
  schemaVersion?: number;
  generator?: string;
  manifestSessionIds?: string[];
  mutateCommit?: (c: Record<string, unknown>) => Record<string, unknown>;
  mutateObjectPath?: (path: string, hash: string) => string;
  omitManifest?: boolean;
}

async function buildBundle(opts: BuildOptions = {}): Promise<BuiltBundle> {
  const sessionId = "session-1";
  const blob = { type: "blob", content: "hello world" };
  const blobHash = await sha256(blob);

  const treeEntries: TreeEntry[] = [
    { path: "a.txt", blobHash, size: blob.content.length },
  ];
  const tree = { type: "tree", entries: treeEntries };
  const treeHash = await sha256(tree);

  const commitBody: Record<string, unknown> = {
    type: "commit",
    tree: treeHash,
    parent: null,
    sessionId,
    timestamp: 1_700_000_000,
    message: "initial",
    toolCall: null,
    metadata: {},
    author: null,
  };
  const commitHash = await sha256(commitBody);
  const commit: Commit = {
    hash: commitHash,
    type: "commit",
    tree: treeHash,
    parent: null,
    sessionId,
    timestamp: 1_700_000_000,
    message: "initial",
    toolCall: null,
    metadata: {},
    author: null,
    signature: null,
    publicKey: null,
  };

  const session: Session = {
    id: sessionId,
    name: "Test session",
    createdAt: 1_000,
    updatedAt: 2_000,
    head: commitHash,
    status: "completed",
    metadata: {},
  };
  const refs: Ref[] = [
    { name: "session/session-1", target: commitHash, type: "session-head", updatedAt: 2_000 },
  ];
  const manifest: BundleManifest = {
    formatVersion: opts.formatVersion ?? BUNDLE_FORMAT_VERSION,
    schemaVersion: opts.schemaVersion ?? VIEWER_SCHEMA_VERSION,
    sessionIds: opts.manifestSessionIds ?? [sessionId],
    createdAt: 1_500,
    generator: opts.generator ?? "agentgit-test/1.0",
  };

  const storedCommit = opts.mutateCommit
    ? opts.mutateCommit({ ...commitBody, hash: commitHash, signature: null, publicKey: null })
    : { ...commitBody, hash: commitHash, signature: null, publicKey: null };

  const entries: Array<{ name: string; data: Uint8Array }> = [];
  if (!opts.omitManifest) {
    entries.push({ name: "manifest.json", data: enc.encode(JSON.stringify(manifest)) });
  }
  entries.push({ name: "commits.jsonl", data: enc.encode(JSON.stringify(storedCommit) + "\n") });
  entries.push({ name: "refs.json", data: enc.encode(JSON.stringify(refs)) });
  entries.push({ name: "sessions.json", data: enc.encode(JSON.stringify([session])) });

  const pushObject = (hash: string, body: unknown) => {
    const path =
      opts.mutateObjectPath
        ? opts.mutateObjectPath(`objects/${hash.slice(0, 2)}/${hash.slice(2)}`, hash)
        : `objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    entries.push({ name: path, data: enc.encode(JSON.stringify(body)) });
  };
  pushObject(blobHash, blob);
  pushObject(treeHash, tree);
  pushObject(commitHash, { ...commitBody, hash: commitHash });

  const tar = writeTar(entries);
  const gz = pako.gzip(tar);
  return { bytes: gz, commitHash, treeHash, blobHash, sessionId };
}

describe("readBundle", () => {
  it("parses a valid minimal bundle and verifies object hashes", async () => {
    const built = await buildBundle();
    const result = await readBundle(built.bytes);

    expect(result.manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(result.manifest.schemaVersion).toBe(VIEWER_SCHEMA_VERSION);
    expect(result.manifest.generator).toBe("agentgit-test/1.0");
    expect(result.manifest.sessionIds).toEqual([built.sessionId]);

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.hash).toBe(built.commitHash);
    expect(result.commits[0]!.tree).toBe(built.treeHash);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe(built.sessionId);
    expect(result.sessions[0]!.head).toBe(built.commitHash);

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]!.target).toBe(built.commitHash);

    expect(result.objects.has(built.commitHash)).toBe(true);
    expect(result.objects.has(built.treeHash)).toBe(true);
    expect(result.objects.has(built.blobHash)).toBe(true);
  });

  it("rejects bundles with a missing manifest", async () => {
    const built = await buildBundle({ omitManifest: true });
    await expect(readBundle(built.bytes)).rejects.toThrow(/missing manifest/);
  });

  it("rejects bundles whose formatVersion exceeds the viewer's", async () => {
    const built = await buildBundle({ formatVersion: BUNDLE_FORMAT_VERSION + 1 });
    await expect(readBundle(built.bytes)).rejects.toThrow(/formatVersion/);
  });

  it("rejects bundles whose schemaVersion exceeds the viewer's", async () => {
    const built = await buildBundle({ schemaVersion: VIEWER_SCHEMA_VERSION + 1 });
    await expect(readBundle(built.bytes)).rejects.toThrow(/schemaVersion/);
  });

  it("rejects bundles where a commit's content hash does not match its filename", async () => {
    const built = await buildBundle({
      mutateCommit: (c) => ({ ...c, message: "tampered after hashing" }),
    });
    await expect(readBundle(built.bytes)).rejects.toThrow(/failed hash verification/);
  });

  it("rejects bundles where manifest.sessionIds disagrees with sessions.json", async () => {
    const built = await buildBundle({ manifestSessionIds: ["session-1", "ghost"] });
    await expect(readBundle(built.bytes)).rejects.toThrow(/ghost/);
  });

  it("rejects gzip input that does not decompress", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await expect(readBundle(garbage)).rejects.toThrow();
  });
});
