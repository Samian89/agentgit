import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import { TARGET_VERSION } from "../migrations/index.js";
import { canonicalJson, sha256 } from "../hash.js";
import {
  BUNDLE_FORMAT_VERSION,
  createBundleFile,
  importBundleFile,
  pack,
  unpack,
  readTar,
  writeTar,
} from "../bundle/index.js";

let baseDir: string;
let srcDir: string;
let srcRepo: Repository;

function makeRepo(suffix: string): { dir: string; repo: Repository } {
  const dir = join(baseDir, suffix);
  mkdirSync(dir, { recursive: true });
  const repo = Repository.init(join(dir, ".agentgit"));
  return { dir, repo };
}

beforeEach(() => {
  baseDir = join(tmpdir(), `agentgit-bundle-${crypto.randomUUID()}`);
  mkdirSync(baseDir, { recursive: true });
  const made = makeRepo("src");
  srcDir = made.dir;
  srcRepo = made.repo;
});

afterEach(() => {
  try {
    srcRepo.index.close();
  } catch {
    /* already closed */
  }
  rmSync(baseDir, { recursive: true, force: true });
});

function seedTwoCommits(): { sessionId: string; hashes: string[] } {
  const s = srcRepo.createSession("demo-session");
  const c1 = srcRepo.commit({
    sessionId: s.id,
    message: "first",
    stateEntries: [{ path: "a.txt", content: "alpha" }],
    toolCall: null,
  });
  const c2 = srcRepo.commit({
    sessionId: s.id,
    message: "second",
    stateEntries: [
      { path: "a.txt", content: "alpha" },
      { path: "b.txt", content: "beta" },
    ],
    toolCall: null,
  });
  return { sessionId: s.id, hashes: [c1.hash, c2.hash] };
}

describe("tar writer/reader", () => {
  it("round-trips arbitrary file entries", () => {
    const entries = [
      { name: "manifest.json", data: new TextEncoder().encode("{}") },
      { name: "objects/aa/bb", data: new Uint8Array([1, 2, 3, 4, 5]) },
      {
        name: "commits.jsonl",
        data: new TextEncoder().encode("line1\nline2\n"),
      },
    ];
    const tar = writeTar(entries);
    const parsed = readTar(tar);
    expect(parsed).toHaveLength(entries.length);
    for (let i = 0; i < entries.length; i++) {
      expect(parsed[i]!.name).toBe(entries[i]!.name);
      expect(Array.from(parsed[i]!.data)).toEqual(Array.from(entries[i]!.data));
    }
  });
});

describe("bundle pack/unpack", () => {
  it("packs the manifest with formatVersion + schemaVersion", () => {
    const { sessionId } = seedTwoCommits();
    const result = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    expect(result.manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(result.manifest.schemaVersion).toBe(TARGET_VERSION);
    expect(result.commitCount).toBe(2);
    // 2 commits + 2 trees + 2 blobs (a.txt + b.txt, a.txt is reused so 1 dedup)
    // Actually a.txt is identical across commits → same blob → 2 unique blobs.
    expect(result.objectCount).toBeGreaterThanOrEqual(5);
  });

  it("unpack verifies object hashes and returns commits/refs/sessions", () => {
    const { sessionId } = seedTwoCommits();
    srcRepo.createBranch("demo", srcRepo.getSession(sessionId)!.head!);

    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    const result = unpack(tar, { clientSchemaVersion: TARGET_VERSION });
    expect(result.commits).toHaveLength(2);
    expect(result.sessions.map((s) => s.id)).toEqual([sessionId]);
    expect(result.refs.length).toBeGreaterThan(0);
  });
});

describe("bundle file round-trip", () => {
  it("create → import to fresh repo replays the same commit history", () => {
    const { sessionId, hashes } = seedTwoCommits();
    srcRepo.createBranch("demo", srcRepo.getSession(sessionId)!.head!);
    const bundlePath = join(baseDir, "out.agentgit-bundle");
    const packed = createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });
    expect(packed.bytesWritten).toBeGreaterThan(0);

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      const imported = importBundleFile({ repo: dstRepo, filePath: bundlePath });
      expect(imported.commitsInserted).toBe(2);
      expect(imported.sessionsInserted).toBe(1);

      const restoredCommits = dstRepo.log(sessionId).map((c) => c.hash);
      expect(restoredCommits).toEqual(hashes);

      // Spot-check ref restoration
      const restored = dstRepo.index.listRefs();
      expect(restored.some((r) => r.name === "sessions/demo")).toBe(true);

      // Verify every imported commit (signature/hashes intact)
      for (const h of restoredCommits) {
        const verdict = dstRepo.verifyCommit(h);
        expect(verdict.status === "unsigned" || verdict.status === "valid").toBe(
          true,
        );
      }
    } finally {
      dstRepo.index.close();
    }
  });

  it("import is idempotent — re-importing the same bundle is a no-op", () => {
    const { sessionId } = seedTwoCommits();
    const bundlePath = join(baseDir, "out.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });
    const { repo: dstRepo } = makeRepo("dst");
    try {
      importBundleFile({ repo: dstRepo, filePath: bundlePath });
      const second = importBundleFile({ repo: dstRepo, filePath: bundlePath });
      expect(second.commitsInserted).toBe(0);
      expect(second.sessionsInserted).toBe(0);
    } finally {
      dstRepo.index.close();
    }
  });
});

describe("bundle refuses untrusted input", () => {
  it("refuses a bundle whose schemaVersion exceeds the client", () => {
    const { sessionId } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION + 1,
    });
    expect(() =>
      unpack(tar, { clientSchemaVersion: TARGET_VERSION }),
    ).toThrow(/schemaVersion/);
  });

  it("refuses a bundle whose formatVersion exceeds the client", () => {
    const { sessionId } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    expect(() =>
      unpack(tar, {
        clientSchemaVersion: TARGET_VERSION,
        clientFormatVersion: 0,
      }),
    ).toThrow(/formatVersion/);
  });

  it("refuses a tampered bundle with no partial writes", () => {
    const { sessionId, hashes } = seedTwoCommits();
    const bundlePath = join(baseDir, "tampered.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });

    // Decompress, flip a byte inside an object body, recompress.
    const gz = readFileSync(bundlePath);
    const tar = gunzipSync(gz);
    const entries = readTar(new Uint8Array(tar));
    const objEntry = entries.find((e) => e.name.startsWith("objects/"));
    expect(objEntry).toBeDefined();
    // Flip a byte deep enough inside the object body that it changes content
    const idx = Math.min(5, objEntry!.data.length - 1);
    objEntry!.data[idx] = objEntry!.data[idx]! ^ 0xff;
    const rebuiltTar = writeTar(entries);
    writeFileSync(bundlePath, gzipSync(Buffer.from(rebuiltTar)));

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      expect(() =>
        importBundleFile({ repo: dstRepo, filePath: bundlePath }),
      ).toThrow();
      // No partial writes: log must be empty, no session inserted, and
      // .agentgit/objects/ must contain no object files.
      expect(dstRepo.index.listSessions()).toHaveLength(0);
      expect(dstRepo.index.getCommit(hashes[0]!)).toBeNull();
      expect(countObjectFiles(join(dstDir, ".agentgit", "objects"))).toBe(0);
    } finally {
      dstRepo.index.close();
    }
  });

  it("refuses a bundle whose commit body has been tampered with", () => {
    const { sessionId, hashes } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    const entries = readTar(tar);
    const commitsEntry = entries.find((e) => e.name === "commits.jsonl");
    expect(commitsEntry).toBeDefined();
    const lines = new TextDecoder()
      .decode(commitsEntry!.data)
      .trim()
      .split("\n");
    // Mutate the commit's message but keep the original hash.
    const parsed = JSON.parse(lines[0]!);
    parsed.message = "tampered";
    lines[0] = JSON.stringify(parsed);
    commitsEntry!.data = new TextEncoder().encode(lines.join("\n") + "\n");

    expect(() =>
      unpack(writeTar(entries), { clientSchemaVersion: TARGET_VERSION }),
    ).toThrow(/commit/);

    // Sanity: original hashes still parse as expected
    expect(hashes.every((h) => h.length === 64)).toBe(true);
  });
});

function countObjectFiles(objectsDir: string): number {
  if (!existsSync(objectsDir)) return 0;
  let count = 0;
  for (const shard of readdirSync(objectsDir)) {
    const shardDir = join(objectsDir, shard);
    for (const _ of readdirSync(shardDir)) count++;
  }
  return count;
}

function rebuildBundle(srcTar: Uint8Array, mutator: (entries: ReturnType<typeof readTar>) => void, outPath: string): void {
  const entries = readTar(srcTar);
  mutator(entries);
  writeFileSync(outPath, gzipSync(Buffer.from(writeTar(entries))));
}

describe("bundle reachability validation", () => {
  it("refuses a bundle whose tree references a missing blob", () => {
    const { sessionId } = seedTwoCommits();
    const bundlePath = join(baseDir, "missing-blob.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });

    // Strip one blob object from the tarball, keep everything else.
    const tar = gunzipSync(readFileSync(bundlePath));
    const entries = readTar(new Uint8Array(tar));
    // Read the tree to find one of its blob hashes.
    let blobHashToDrop: string | null = null;
    for (const e of entries) {
      if (!e.name.startsWith("objects/")) continue;
      const body = JSON.parse(new TextDecoder().decode(e.data));
      if (body?.type === "tree" && Array.isArray(body.entries) && body.entries.length > 0) {
        blobHashToDrop = body.entries[0].blobHash;
        break;
      }
    }
    expect(blobHashToDrop).not.toBeNull();
    const dropName =
      `objects/${blobHashToDrop!.slice(0, 2)}/${blobHashToDrop!.slice(2)}`;
    const filtered = entries.filter((e) => e.name !== dropName);
    writeFileSync(bundlePath, gzipSync(Buffer.from(writeTar(filtered))));

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      expect(() =>
        importBundleFile({ repo: dstRepo, filePath: bundlePath }),
      ).toThrow(/missing blob/);
      expect(dstRepo.index.listSessions()).toHaveLength(0);
      expect(countObjectFiles(join(dstDir, ".agentgit", "objects"))).toBe(0);
    } finally {
      dstRepo.index.close();
    }
  });

  it("refuses a bundle whose ref targets a commit not in the bundle", () => {
    const { sessionId } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    const entries = readTar(tar);
    const refsEntry = entries.find((e) => e.name === "refs.json")!;
    const refs = JSON.parse(new TextDecoder().decode(refsEntry.data));
    refs.push({
      name: "dangling",
      target: "0".repeat(64),
      type: "branch",
      updatedAt: Date.now(),
    });
    refsEntry.data = new TextEncoder().encode(JSON.stringify(refs));

    expect(() =>
      unpack(writeTar(entries), { clientSchemaVersion: TARGET_VERSION }),
    ).toThrow(/ref dangling targets missing commit/);
  });

  it("refuses a bundle whose session.head is missing from commits.jsonl", () => {
    const { sessionId } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    const entries = readTar(tar);
    const sessionsEntry = entries.find((e) => e.name === "sessions.json")!;
    const sessions = JSON.parse(new TextDecoder().decode(sessionsEntry.data));
    sessions[0].head = "f".repeat(64);
    sessionsEntry.data = new TextEncoder().encode(JSON.stringify(sessions));

    expect(() =>
      unpack(writeTar(entries), { clientSchemaVersion: TARGET_VERSION }),
    ).toThrow(/session .* head .* missing/);
  });

  it("refuses a bundle whose tree entry has a malformed shape", () => {
    // Build a synthetic bundle by hand so the malformed entry survives every
    // earlier check (object-hash, commit-hash, reachability). Mutating the
    // tree of a real bundle would invalidate the commit that references it,
    // and the commit-hash check would fire before tree-shape validation.
    const enc = new TextEncoder();
    const blobBody = {
      type: "blob",
      content: "x",
      size: 1,
      encoding: "utf-8",
      mimeType: null,
    };
    const blobHash = sha256(blobBody);

    // `size` field intentionally omitted on the tree entry.
    const treeBody = {
      type: "tree",
      entries: [{ path: "a.txt", blobHash }],
    };
    const treeHash = sha256(treeBody);

    const commitBody = {
      type: "commit",
      tree: treeHash,
      parent: null,
      sessionId: "sess-1",
      timestamp: 0,
      message: "x",
      toolCall: null,
      metadata: {},
      author: null,
    };
    const commitHash = sha256(commitBody);
    const commit = {
      hash: commitHash,
      ...commitBody,
      signature: null,
      publicKey: null,
    };

    const session = {
      id: "sess-1",
      name: "s",
      status: "active",
      head: commitHash,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    };

    const manifest = {
      formatVersion: 1,
      schemaVersion: TARGET_VERSION,
      sessionIds: ["sess-1"],
      createdAt: 0,
      generator: "test",
    };

    const entries = [
      { name: "manifest.json", data: enc.encode(canonicalJson(manifest)) },
      {
        name: `objects/${blobHash.slice(0, 2)}/${blobHash.slice(2)}`,
        data: enc.encode(canonicalJson(blobBody)),
      },
      {
        name: `objects/${treeHash.slice(0, 2)}/${treeHash.slice(2)}`,
        data: enc.encode(canonicalJson(treeBody)),
      },
      {
        name: `objects/${commitHash.slice(0, 2)}/${commitHash.slice(2)}`,
        data: enc.encode(canonicalJson(commitBody)),
      },
      {
        name: "commits.jsonl",
        data: enc.encode(JSON.stringify(commit) + "\n"),
      },
      { name: "refs.json", data: enc.encode("[]") },
      { name: "sessions.json", data: enc.encode(JSON.stringify([session])) },
    ];

    expect(() =>
      unpack(writeTar(entries), { clientSchemaVersion: TARGET_VERSION }),
    ).toThrow(/invalid size/);
  });

  it("refuses a bundle whose commit references a missing tree", () => {
    const { sessionId } = seedTwoCommits();
    const bundlePath = join(baseDir, "missing-tree.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });

    // Drop the tree object for the first commit.
    const tar = gunzipSync(readFileSync(bundlePath));
    const entries = readTar(new Uint8Array(tar));
    const commitsLine = entries.find((e) => e.name === "commits.jsonl")!;
    const firstCommit = JSON.parse(
      new TextDecoder()
        .decode(commitsLine.data)
        .split("\n")
        .filter(Boolean)[0]!,
    );
    const treeName =
      `objects/${firstCommit.tree.slice(0, 2)}/${firstCommit.tree.slice(2)}`;
    const filtered = entries.filter((e) => e.name !== treeName);
    writeFileSync(bundlePath, gzipSync(Buffer.from(writeTar(filtered))));

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      expect(() =>
        importBundleFile({ repo: dstRepo, filePath: bundlePath }),
      ).toThrow(/missing tree/);
      expect(dstRepo.index.listSessions()).toHaveLength(0);
      expect(countObjectFiles(join(dstDir, ".agentgit", "objects"))).toBe(0);
    } finally {
      dstRepo.index.close();
    }
  });
});

describe("bundle import disk atomicity", () => {
  it("never writes object files when the bundle is rejected", () => {
    const { sessionId } = seedTwoCommits();
    const bundlePath = join(baseDir, "bad.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });

    // Tamper with the commits.jsonl so unpack-time hash check rejects it.
    rebuildBundle(
      gunzipSync(readFileSync(bundlePath)),
      (entries) => {
        const ce = entries.find((e) => e.name === "commits.jsonl")!;
        const lines = new TextDecoder()
          .decode(ce.data)
          .trim()
          .split("\n");
        const parsed = JSON.parse(lines[0]!);
        parsed.message = "tampered";
        lines[0] = JSON.stringify(parsed);
        ce.data = new TextEncoder().encode(lines.join("\n") + "\n");
      },
      bundlePath,
    );

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      expect(() =>
        importBundleFile({ repo: dstRepo, filePath: bundlePath }),
      ).toThrow();
      expect(countObjectFiles(join(dstDir, ".agentgit", "objects"))).toBe(0);
      expect(dstRepo.index.listSessions()).toHaveLength(0);
    } finally {
      dstRepo.index.close();
    }
  });

  it("writes objects only after the SQLite transaction commits (success path)", () => {
    const { sessionId } = seedTwoCommits();
    const bundlePath = join(baseDir, "happy.agentgit-bundle");
    createBundleFile({
      repo: srcRepo,
      sessionIds: [sessionId],
      outPath: bundlePath,
    });

    const { dir: dstDir, repo: dstRepo } = makeRepo("dst");
    try {
      const result = importBundleFile({ repo: dstRepo, filePath: bundlePath });
      expect(result.objectsWritten).toBeGreaterThan(0);
      expect(countObjectFiles(join(dstDir, ".agentgit", "objects"))).toBe(
        result.objectsWritten,
      );
    } finally {
      dstRepo.index.close();
    }
  });
});

describe("canonical-json safety", () => {
  it("packed object bodies hash back to their filenames", () => {
    const { sessionId } = seedTwoCommits();
    const { tar } = pack({
      repo: srcRepo,
      sessionIds: [sessionId],
      schemaVersion: TARGET_VERSION,
    });
    for (const entry of readTar(tar)) {
      if (!entry.name.startsWith("objects/")) continue;
      const hash = entry.name.slice(8).replace("/", "");
      const body = JSON.parse(new TextDecoder().decode(entry.data));
      expect(sha256(body)).toBe(hash);
      // Canonicalising again should be byte-identical.
      expect(canonicalJson(body)).toBe(new TextDecoder().decode(entry.data));
    }
  });
});
