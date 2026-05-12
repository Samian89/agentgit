import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { branchCommand } from "../commands/branch.js";

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

describe("branchCommand", () => {
  it("creates a branch pointing to a commit", () => {
    const session = repo.createSession("branch-test");
    const commit = repo.commit({ sessionId: session.id, message: "initial" });
    repo.index.close();

    vi.spyOn(console, "log").mockImplementation(() => {});
    branchCommand(agentgitDir, "my-branch", commit.hash);
    vi.restoreAllMocks();

    repo = Repository.open(agentgitDir);
    expect(repo.getBranch("my-branch")).toBe(commit.hash);
  });

  it("prints confirmation message", () => {
    const session = repo.createSession("branch-test");
    const commit = repo.commit({ sessionId: session.id, message: "initial" });
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    branchCommand(agentgitDir, "feature", commit.hash);
    vi.restoreAllMocks();

    expect(output[0]).toContain("feature");
    expect(output[0]).toContain(commit.hash.slice(0, 12));

    repo = Repository.open(agentgitDir);
  });
});
