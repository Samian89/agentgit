import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { logCommand } from "../commands/log.js";

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

describe("logCommand", () => {
  it("prints 'No sessions found.' when no sessions exist", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logCommand(agentgitDir);
    expect(spy).toHaveBeenCalledWith("No sessions found.");
    spy.mockRestore();
  });

  it("prints commits in reverse chronological order", () => {
    const session = repo.createSession("test-session");
    repo.commit({ sessionId: session.id, message: "first commit" });
    repo.commit({ sessionId: session.id, message: "second commit" });
    repo.index.close();

    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    logCommand(agentgitDir);
    spy.mockRestore();

    const messageLines = output.filter((l) => l.includes("commit"));
    expect(messageLines[0]).toContain("second commit");
    expect(messageLines[1]).toContain("first commit");

    repo = Repository.open(agentgitDir);
  });

  it("filters by session name", () => {
    const s1 = repo.createSession("session-alpha");
    const s2 = repo.createSession("session-beta");
    repo.commit({ sessionId: s1.id, message: "alpha commit" });
    repo.commit({ sessionId: s2.id, message: "beta commit" });
    repo.index.close();

    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    logCommand(agentgitDir, { session: "session-alpha" });
    spy.mockRestore();

    const joined = output.join(" ");
    expect(joined).toContain("alpha commit");
    expect(joined).not.toContain("beta commit");

    repo = Repository.open(agentgitDir);
  });
});
