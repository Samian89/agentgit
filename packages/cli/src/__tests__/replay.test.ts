import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository } from "@agentgit/core";
import { replayCommand } from "../commands/replay.js";

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

describe("replayCommand", () => {
  it("prints step-by-step tool calls for a session", () => {
    const session = repo.createSession("replay-session");
    repo.commit({
      sessionId: session.id,
      message: "read file",
      toolCall: {
        id: "tc1",
        name: "readFile",
        input: { path: "/tmp/test.txt" },
        output: "hello",
        startedAt: Date.now(),
        completedAt: Date.now(),
        status: "success",
        error: null,
      },
    });
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    replayCommand(agentgitDir, session.name);
    vi.restoreAllMocks();

    const joined = output.join("\n");
    expect(joined).toContain("readFile");
    expect(joined).toContain("Step 1/1");

    repo = Repository.open(agentgitDir);
  });

  it("handles session with no commits", () => {
    const session = repo.createSession("empty-session");
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    replayCommand(agentgitDir, session.name);
    vi.restoreAllMocks();

    expect(output.some((l) => l.includes("No commits to replay."))).toBe(true);

    repo = Repository.open(agentgitDir);
  });
});
