import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { diffCommand } from "../commands/diff.js";

let testDir: string;
let agentgitDir: string;
let repo: Repository;

beforeEach(() => {
  testDir = join(tmpdir(), `agentgit-cli-test-${crypto.randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  agentgitDir = join(testDir, ".agentgit");
  repo = Repository.init(agentgitDir);
});

afterEach(() => {
  repo.index.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("diffCommand", () => {
  it("shows added files", () => {
    const session = repo.createSession("diff-test");
    const c1 = repo.commit({ sessionId: session.id, message: "empty" });
    const c2 = repo.commit({
      sessionId: session.id,
      message: "add file",
      stateEntries: [{ path: "main.py", content: "print('hello')" }],
    });
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    diffCommand(agentgitDir, c1.hash, c2.hash);
    vi.restoreAllMocks();

    expect(output.some((l) => l.includes("main.py"))).toBe(true);
    expect(output.some((l) => l.includes("+++"))).toBe(true);

    repo = Repository.open(agentgitDir);
  });

  it("shows no differences for identical commits", () => {
    const session = repo.createSession("diff-test");
    const c1 = repo.commit({
      sessionId: session.id,
      message: "step1",
      stateEntries: [{ path: "a.txt", content: "same" }],
    });
    const c2 = repo.commit({
      sessionId: session.id,
      message: "step2",
      stateEntries: [{ path: "a.txt", content: "same" }],
    });
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    diffCommand(agentgitDir, c1.hash, c2.hash);
    vi.restoreAllMocks();

    expect(output.some((l) => l.includes("(no differences)"))).toBe(true);

    repo = Repository.open(agentgitDir);
  });
});
