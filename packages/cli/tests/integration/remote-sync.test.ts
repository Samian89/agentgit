/**
 * CLI integration coverage for `agentgit push`, `fetch`, and `pull` against an
 * in-process remote-server. Mirrors the harness used by
 * `packages/remote-server/tests/roundtrip.test.ts` but drives the three CLI
 * command modules so the user-facing surface (token resolution, exit codes,
 * config persistence) is exercised end-to-end.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Repository } from "@agentgit/core";
import { buildServer, getStorage } from "../../../remote-server/src/server.js";
import { initCommand } from "../../src/commands/init.js";
import { remoteAddCommand } from "../../src/commands/remote.js";
import { pushCommand } from "../../src/commands/push.js";
import { fetchCommand } from "../../src/commands/fetch.js";
import { pullCommand } from "../../src/commands/pull.js";

const SERVER_TOKEN = "cli-sync-test-token";

let tmpDir: string;
let serverDir: string;
let app: FastifyInstance;
let serverUrl: string;
let originalStdoutWrite: typeof process.stdout.write;
let stderrCaptured: string[];

function silenceStdio(): void {
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  stderrCaptured = [];
  (process.stdout.write as unknown as (s: string) => boolean) = (() =>
    true) as typeof process.stdout.write;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrCaptured.push(args.map((a) => String(a)).join(" "));
  });
}

function restoreStdio(): void {
  (process.stdout.write as unknown) = originalStdoutWrite;
  vi.restoreAllMocks();
}

function makeRepoDir(suffix: string): { repoDir: string; agentgitDir: string } {
  const repoDir = join(tmpDir, suffix);
  mkdirSync(repoDir, { recursive: true });
  initCommand(repoDir);
  return { repoDir, agentgitDir: join(repoDir, ".agentgit") };
}

function withRepo<T>(agentgitDir: string, fn: (repo: Repository) => T): T {
  const repo = Repository.open(agentgitDir);
  try {
    return fn(repo);
  } finally {
    repo.index.close();
  }
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentgit-cli-sync-"));
  serverDir = join(tmpDir, "server");
  mkdirSync(serverDir, { recursive: true });

  app = await buildServer({
    dataDir: serverDir,
    tokens: [SERVER_TOKEN],
    logger: false,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("remote-server did not bind to a port");
  }
  serverUrl = `http://127.0.0.1:${addr.port}`;

  silenceStdio();
});

afterEach(async () => {
  restoreStdio();
  try {
    await app.close();
  } catch {
    /* server already closed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("agentgit push/fetch/pull integration", () => {
  it("happy path: push (persisted token) → fetch (--token flag) → pull fast-forward", async () => {
    const a = makeRepoDir("a");
    const b = makeRepoDir("b");

    // Persisted token on A; B has no token configured (we exercise --token).
    expect(
      remoteAddCommand(a.agentgitDir, "origin", serverUrl, { token: SERVER_TOKEN }),
    ).toBe(0);
    expect(remoteAddCommand(b.agentgitDir, "origin", serverUrl, {})).toBe(0);

    const sessionId = withRepo(a.agentgitDir, (repo) => {
      const s = repo.createSession("main");
      repo.commit({
        sessionId: s.id,
        message: "first",
        stateEntries: [{ path: "hello.txt", content: "world" }],
      });
      return s.id;
    });

    // pushCommand resolves token from persisted config.
    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(0);

    // Server-side storage now knows the ref.
    const storage = getStorage(app);
    const refsOnServer = storage.listRefs();
    expect(refsOnServer.find((r) => r.name === `sessions/${sessionId}`)).toBeDefined();
    const serverHeadAfterFirstPush = refsOnServer.find(
      (r) => r.name === `sessions/${sessionId}`,
    )!.target;

    // fetchCommand on B uses the --token flag (persisted token is absent).
    expect(
      await fetchCommand(b.agentgitDir, "origin", undefined, { token: SERVER_TOKEN }),
    ).toBe(0);
    withRepo(b.agentgitDir, (repo) => {
      expect(repo.refs.getRef(`remotes/origin/sessions/${sessionId}`)).toBe(
        serverHeadAfterFirstPush,
      );
      // Objects landed locally too.
      expect(repo.objects.has(serverHeadAfterFirstPush)).toBe(true);
    });

    // First pull seeds the local session ref on B.
    expect(
      await pullCommand(b.agentgitDir, "origin", `sessions/${sessionId}`, {
        token: SERVER_TOKEN,
      }),
    ).toBe(0);
    withRepo(b.agentgitDir, (repo) => {
      expect(repo.refs.getRef(`sessions/${sessionId}`)).toBe(serverHeadAfterFirstPush);
    });

    // A advances the session with a fast-forward commit and re-pushes.
    const advancedHead = withRepo(a.agentgitDir, (repo) => {
      const c2 = repo.commit({
        sessionId,
        message: "second",
        stateEntries: [{ path: "hello.txt", content: "world!" }],
      });
      return c2.hash;
    });
    expect(advancedHead).not.toBe(serverHeadAfterFirstPush);
    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(0);

    // B pulls the FF update — local session ref must advance.
    expect(
      await pullCommand(b.agentgitDir, "origin", `sessions/${sessionId}`, {
        token: SERVER_TOKEN,
      }),
    ).toBe(0);
    withRepo(b.agentgitDir, (repo) => {
      expect(repo.refs.getRef(`sessions/${sessionId}`)).toBe(advancedHead);
    });

    // A second FF pull is a no-op (upToDate path).
    expect(
      await pullCommand(b.agentgitDir, "origin", `sessions/${sessionId}`, {
        token: SERVER_TOKEN,
      }),
    ).toBe(0);
  });

  it("--token flag overrides a wrong persisted token", async () => {
    const a = makeRepoDir("a");
    expect(
      remoteAddCommand(a.agentgitDir, "origin", serverUrl, {
        token: "this-token-is-wrong",
      }),
    ).toBe(0);

    const sessionId = withRepo(a.agentgitDir, (repo) => {
      const s = repo.createSession("main");
      repo.commit({
        sessionId: s.id,
        message: "first",
        stateEntries: [{ path: "f", content: "x" }],
      });
      return s.id;
    });

    // Without the override the push would 401; the explicit flag wins.
    expect(
      await pushCommand(a.agentgitDir, "origin", sessionId, {
        token: SERVER_TOKEN,
      }),
    ).toBe(0);

    const storage = getStorage(app);
    expect(
      storage.listRefs().find((r) => r.name === `sessions/${sessionId}`),
    ).toBeDefined();
  });

  it("returns non-zero exit when the persisted token is rejected (401)", async () => {
    const a = makeRepoDir("a");
    expect(
      remoteAddCommand(a.agentgitDir, "origin", serverUrl, {
        token: "definitely-not-the-server-token",
      }),
    ).toBe(0);

    const sessionId = withRepo(a.agentgitDir, (repo) => {
      const s = repo.createSession("main");
      repo.commit({
        sessionId: s.id,
        message: "first",
        stateEntries: [{ path: "f", content: "x" }],
      });
      return s.id;
    });

    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(1);
    expect(stderrCaptured.join("")).toMatch(/401|unauthorized/i);

    // fetchCommand on a clean repo with the bad token also exits non-zero.
    const b = makeRepoDir("b");
    expect(
      remoteAddCommand(b.agentgitDir, "origin", serverUrl, {
        token: "still-wrong",
      }),
    ).toBe(0);
    expect(await fetchCommand(b.agentgitDir, "origin", undefined)).toBe(1);
  });

  it("returns non-zero exit when push is non-fast-forward (ref CAS would conflict)", async () => {
    const a = makeRepoDir("a");
    expect(
      remoteAddCommand(a.agentgitDir, "origin", serverUrl, { token: SERVER_TOKEN }),
    ).toBe(0);

    // c1 → c2 (linear). Push so server lands on c2.
    const { sessionId, c1Hash } = withRepo(a.agentgitDir, (repo) => {
      const s = repo.createSession("main");
      const first = repo.commit({
        sessionId: s.id,
        message: "c1",
        stateEntries: [{ path: "a", content: "1" }],
      });
      repo.commit({
        sessionId: s.id,
        message: "c2",
        stateEntries: [{ path: "a", content: "2" }],
      });
      return { sessionId: s.id, c1Hash: first.hash };
    });
    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(0);

    // Build a sibling commit c1' branching off c1 (diverges from server's c2),
    // then point the session head at it. The next push must refuse: c2 is not
    // an ancestor of c1', so the local FF guard trips before the CAS even
    // hits the wire — same non-zero outcome the user sees on a 409.
    const sibling = withRepo(a.agentgitDir, (repo) => {
      return repo.commit({
        sessionId,
        message: "c1-sibling",
        parentHash: c1Hash,
        stateEntries: [{ path: "b", content: "sibling" }],
      });
    });
    withRepo(a.agentgitDir, (repo) => {
      repo.index.updateSessionHead(sessionId, sibling.hash, Date.now());
    });

    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(1);
    expect(stderrCaptured.join("")).toMatch(/non-fast-forward|FF|conflict/i);
  });

  it("pull also accepts a --token flag override", async () => {
    const a = makeRepoDir("a");
    const b = makeRepoDir("b");
    expect(
      remoteAddCommand(a.agentgitDir, "origin", serverUrl, { token: SERVER_TOKEN }),
    ).toBe(0);
    // B has no token persisted at all.
    expect(remoteAddCommand(b.agentgitDir, "origin", serverUrl, {})).toBe(0);

    const sessionId = withRepo(a.agentgitDir, (repo) => {
      const s = repo.createSession("main");
      repo.commit({
        sessionId: s.id,
        message: "only",
        stateEntries: [{ path: "f", content: "v" }],
      });
      return s.id;
    });
    expect(await pushCommand(a.agentgitDir, "origin", sessionId)).toBe(0);

    // No token configured + no --token → should be an immediate non-zero.
    expect(await pullCommand(b.agentgitDir, "origin", `sessions/${sessionId}`)).toBe(1);

    // With the flag, pull succeeds and seeds the local session ref.
    expect(
      await pullCommand(b.agentgitDir, "origin", `sessions/${sessionId}`, {
        token: SERVER_TOKEN,
      }),
    ).toBe(0);
    withRepo(b.agentgitDir, (repo) => {
      expect(repo.refs.getRef(`sessions/${sessionId}`)).not.toBeNull();
    });
  });
});
