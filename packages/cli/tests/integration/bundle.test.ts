import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository, readTar, writeTar } from "@agentgit/core";
import { initCommand } from "../../src/commands/init.js";
import {
  bundleCreateCommand,
  bundleImportCommand,
} from "../../src/commands/bundle.js";

let srcTmp: string;
let dstTmp: string;
let srcAgentgit: string;
let dstAgentgit: string;

beforeEach(() => {
  srcTmp = mkdtempSync(join(tmpdir(), "agentgit-bundle-cli-src-"));
  dstTmp = mkdtempSync(join(tmpdir(), "agentgit-bundle-cli-dst-"));
  srcAgentgit = join(srcTmp, ".agentgit");
  dstAgentgit = join(dstTmp, ".agentgit");
});

afterEach(() => {
  rmSync(srcTmp, { recursive: true, force: true });
  rmSync(dstTmp, { recursive: true, force: true });
});

function commitTwo(repo: Repository, sessionName: string): {
  id: string;
  hashes: string[];
} {
  const s = repo.createSession(sessionName);
  const c1 = repo.commit({
    sessionId: s.id,
    message: "one",
    stateEntries: [{ path: "x.txt", content: "first" }],
  });
  const c2 = repo.commit({
    sessionId: s.id,
    message: "two",
    stateEntries: [{ path: "x.txt", content: "first-and-second" }],
  });
  return { id: s.id, hashes: [c1.hash, c2.hash] };
}

describe("agentgit bundle create/import CLI", () => {
  it("create writes a .agentgit-bundle and import on a fresh repo replays it", () => {
    initCommand(srcTmp);
    initCommand(dstTmp);

    const srcRepo = Repository.open(srcAgentgit);
    const { id, hashes } = commitTwo(srcRepo, "demo");
    srcRepo.index.close();

    const bundlePath = join(srcTmp, "demo.agentgit-bundle");
    expect(
      bundleCreateCommand(srcAgentgit, [id], { output: bundlePath }),
    ).toBe(0);
    expect(readdirSync(srcTmp)).toContain("demo.agentgit-bundle");

    expect(bundleImportCommand(dstAgentgit, bundlePath)).toBe(0);
    const dstRepo = Repository.open(dstAgentgit);
    try {
      const restoredHashes = dstRepo.log(id).map((c) => c.hash);
      expect(restoredHashes).toEqual(hashes);
    } finally {
      dstRepo.index.close();
    }
  });

  it("import refuses a tampered bundle and does not write anything", () => {
    initCommand(srcTmp);
    initCommand(dstTmp);

    const srcRepo = Repository.open(srcAgentgit);
    const { id } = commitTwo(srcRepo, "tampered");
    srcRepo.index.close();

    const bundlePath = join(srcTmp, "tampered.agentgit-bundle");
    expect(
      bundleCreateCommand(srcAgentgit, [id], { output: bundlePath }),
    ).toBe(0);

    // Flip a byte inside an object body.
    const gz = readFileSync(bundlePath);
    const tar = gunzipSync(gz);
    const entries = readTar(new Uint8Array(tar));
    const objEntry = entries.find((e) => e.name.startsWith("objects/"));
    expect(objEntry).toBeDefined();
    objEntry!.data[3] = objEntry!.data[3]! ^ 0xff;
    writeFileSync(bundlePath, gzipSync(Buffer.from(writeTar(entries))));

    expect(bundleImportCommand(dstAgentgit, bundlePath)).toBe(1);

    const dstRepo = Repository.open(dstAgentgit);
    try {
      expect(dstRepo.index.listSessions()).toHaveLength(0);
    } finally {
      dstRepo.index.close();
    }
  });

  it("create refuses unknown sessions", () => {
    initCommand(srcTmp);
    expect(bundleCreateCommand(srcAgentgit, ["does-not-exist"], {})).toBe(1);
  });

  it("import refuses a non-existent file", () => {
    initCommand(dstTmp);
    expect(
      bundleImportCommand(dstAgentgit, join(dstTmp, "nope.agentgit-bundle")),
    ).toBe(1);
  });
});
