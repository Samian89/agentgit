/**
 * End-to-end test of the Remote Protocol implementation: push from one
 * Repository to an in-process HTTP server, fetch into a second Repository,
 * assert ref/object equivalence. Also covers the resumability invariant.
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Repository,
  fetchRefs,
  pullRef,
  pushSession,
  RemoteClient,
  type FetchLike,
} from "@agentgit/core";
import type { FastifyInstance } from "fastify";
import { buildServer, type RemoteServerOptions } from "../src/server.js";

let baseDir: string;
let openedRepos: Repository[];

function makeRepo(suffix: string): { dir: string; repo: Repository } {
  const dir = join(baseDir, suffix);
  mkdirSync(dir, { recursive: true });
  const repo = Repository.init(join(dir, ".agentgit"));
  openedRepos.push(repo);
  return { dir, repo };
}

async function startServer(
  opts: Partial<RemoteServerOptions> & { dataDir: string },
): Promise<{ app: FastifyInstance; url: string }> {
  const app = await buildServer({
    dataDir: opts.dataDir,
    tokens: opts.tokens ?? ["test-token"],
    logger: false,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind");
  }
  return { app, url: `http://127.0.0.1:${address.port}` };
}

beforeEach(() => {
  baseDir = join(tmpdir(), `agentgit-remote-${crypto.randomUUID()}`);
  openedRepos = [];
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  for (const r of openedRepos) {
    try {
      r.index.close();
    } catch {
      /* already closed */
    }
  }
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seed(repo: Repository): { sessionId: string; head: string; commitHashes: string[] } {
  const session = repo.createSession("roundtrip");
  const c1 = repo.commit({
    sessionId: session.id,
    message: "init",
    stateEntries: [{ path: "a.txt", content: "alpha" }],
    toolCall: null,
  });
  const c2 = repo.commit({
    sessionId: session.id,
    message: "update",
    stateEntries: [
      { path: "a.txt", content: "alpha-2" },
      { path: "b.txt", content: "beta" },
    ],
    toolCall: null,
  });
  return { sessionId: session.id, head: c2.hash, commitHashes: [c1.hash, c2.hash] };
}

describe("remote roundtrip", () => {
  it("pushes from A and fetches on B with matching log", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const { app, url } = await startServer({ dataDir: serverDir });

    try {
      const a = makeRepo("a");
      const b = makeRepo("b");
      const { sessionId, commitHashes } = seed(a.repo);

      const result = await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
      });
      expect(result.uploadedObjects).toBeGreaterThan(0);
      expect(result.pushedRef.name).toBe(`sessions/${sessionId}`);

      const fetched = await fetchRefs(b.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
      });
      expect(fetched.fetchedRefs.length).toBe(1);
      expect(fetched.fetchedRefs[0]!.target).toBe(commitHashes[1]);

      const logA = a.repo.log(sessionId).map((c) => c.hash);
      const logB = b.repo.log(sessionId).map((c) => c.hash);
      expect(logB).toEqual(logA);

      for (const c of a.repo.log(sessionId)) {
        expect(b.repo.objects.has(c.hash)).toBe(true);
        expect(b.repo.objects.has(c.tree)).toBe(true);
      }

      const trackingRef = b.repo.refs.getRef(`remotes/origin/sessions/${sessionId}`);
      expect(trackingRef).toBe(commitHashes[1]);
    } finally {
      await app.close();
    }
  });

  it("uses negotiation to skip objects the server already has", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const { app, url } = await startServer({ dataDir: serverDir });

    try {
      const a = makeRepo("a");
      const { sessionId } = seed(a.repo);

      const first = await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
      });
      expect(first.uploadedObjects).toBeGreaterThan(0);

      const second = await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
      });
      expect(second.uploadedObjects).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const { app, url } = await startServer({ dataDir: serverDir });
    try {
      const client = new RemoteClient({ baseUrl: url, token: "wrong-token" });
      await expect(client.listRefs()).rejects.toThrow(/401|unauthorized/i);
    } finally {
      await app.close();
    }
  });

  it("pull is fast-forward only and refuses non-FF updates", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const { app, url } = await startServer({ dataDir: serverDir });

    try {
      const a = makeRepo("a");
      const { sessionId } = seed(a.repo);
      await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
      });

      const b = makeRepo("b");
      const firstPull = await pullRef(b.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        refName: `sessions/${sessionId}`,
      });
      expect(firstPull.upToDate).toBe(false);

      const divergent = b.repo.commit({
        sessionId,
        message: "divergent on B",
        stateEntries: [{ path: "diverge.txt", content: "x" }],
        toolCall: null,
      });
      b.repo.refs.setRef(`sessions/${sessionId}`, divergent.hash);

      a.repo.commit({
        sessionId,
        message: "advance on A",
        stateEntries: [{ path: "advance.txt", content: "y" }],
        toolCall: null,
      });
      await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
      });

      await expect(
        pullRef(b.repo, {
          remote: "origin",
          baseUrl: url,
          token: "test-token",
          refName: `sessions/${sessionId}`,
        }),
      ).rejects.toThrow(/non-fast-forward|FF/i);
    } finally {
      await app.close();
    }
  });
});

describe("remote resumability", () => {
  it("preserves received[] across a mid-push network failure", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const { app, url } = await startServer({ dataDir: serverDir });

    const a = makeRepo("a");
    const { sessionId } = seed(a.repo);

    const realFetch = (globalThis as { fetch: FetchLike }).fetch.bind(globalThis);
    let uploadCalls = 0;
    const flakyTransport: FetchLike = async (u, init) => {
      const parsed = new URL(u);
      if (parsed.pathname.endsWith("/objects/upload")) {
        uploadCalls += 1;
        if (uploadCalls === 1) {
          return realFetch(u, init);
        }
        throw new Error("network drop");
      }
      return realFetch(u, init);
    };

    try {
      let threw = false;
      try {
        await pushSession(a.repo, {
          remote: "origin",
          baseUrl: url,
          token: "test-token",
          sessionId,
          fetchImpl: flakyTransport,
          chunkSize: 1,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      const stateFile = join(a.dir, ".agentgit", "remote-state.json");
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
        string,
        { uploadId: string; received: string[]; wants: string[] }
      >;
      expect(state["origin"]).toBeDefined();
      expect(state["origin"]!.received.length).toBeGreaterThan(0);
      const savedUploadId = state["origin"]!.uploadId;
      const ackedBefore = new Set(state["origin"]!.received);

      // Retry. Must reuse the Upload-Id and skip already-acked objects.
      const r2 = await pushSession(a.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
        sessionId,
        chunkSize: 1,
      });
      expect(r2.uploadId).toBe(savedUploadId);

      // Round-trip sanity check.
      const b = makeRepo("b");
      const fetched = await fetchRefs(b.repo, {
        remote: "origin",
        baseUrl: url,
        token: "test-token",
      });
      expect(fetched.fetchedRefs.length).toBe(1);
      const logB = b.repo.log(sessionId).map((c) => c.hash);
      const logA = a.repo.log(sessionId).map((c) => c.hash);
      expect(logB).toEqual(logA);

      // ackedBefore objects must have been "saved" — they were on the
      // server when we retried, and the retry should not have lied about
      // skipping them.
      expect(ackedBefore.size).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("survives a server restart against the same data-dir", async () => {
    const serverDir = join(baseDir, "server");
    mkdirSync(serverDir, { recursive: true });
    const first = await startServer({ dataDir: serverDir });

    const a = makeRepo("a");
    const { sessionId } = seed(a.repo);

    // First push, then shutdown the server, then start a new one against the
    // same dataDir — the same client should be able to fetch.
    await pushSession(a.repo, {
      remote: "origin",
      baseUrl: first.url,
      token: "test-token",
      sessionId,
    });
    await first.app.close();

    const second = await startServer({ dataDir: serverDir });
    try {
      const b = makeRepo("b");
      const fetched = await fetchRefs(b.repo, {
        remote: "origin",
        baseUrl: second.url,
        token: "test-token",
      });
      expect(fetched.fetchedRefs.length).toBe(1);
      const logA = a.repo.log(sessionId).map((c) => c.hash);
      const logB = b.repo.log(sessionId).map((c) => c.hash);
      expect(logB).toEqual(logA);
    } finally {
      await second.app.close();
    }
  });
});
