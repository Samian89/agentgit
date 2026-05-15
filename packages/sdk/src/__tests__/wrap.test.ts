import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "@agentgit/core";
import type { Guard, GuardContext, GuardResult } from "@agentgit/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitSession, wrapAgentJS } from "../index.js";

// ---------------------------------------------------------------------------
// Mock agent
// ---------------------------------------------------------------------------

class MockAgent {
  readonly calls: string[] = [];

  async run(prompt: string): Promise<string> {
    const r1 = await this.searchDatabase(prompt);
    const r2 = await this.writeFile("output.txt", r1);
    this.calls.push(`run:${prompt}`);
    return `done:${String(r2)}`;
  }

  async searchDatabase(query: string): Promise<string> {
    this.calls.push(`search:${query}`);
    return `results for ${query}`;
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.calls.push(`write:${path}`);
    return `wrote ${path} with ${content}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): { tmpDir: string; repoDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "agentgit-sdk-test-"));
  const repoDir = join(tmpDir, ".agentgit");
  return { tmpDir, repoDir };
}

/** Close all tracked SQLite connections then delete the directory. */
function cleanup(
  tmpDir: string,
  closeables: Array<{ index: { close(): void } }>,
): void {
  for (const c of closeables) {
    try {
      c.index.close();
    } catch {
      // ignore — already closed or never opened
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// wrapAgentJS
// ---------------------------------------------------------------------------

describe("wrapAgentJS", () => {
  let tmpDir: string;
  let repoDir: string;
  let repos: Array<{ index: { close(): void } }>;

  beforeEach(() => {
    ({ tmpDir, repoDir } = makeTmpRepo());
    repos = [];
  });

  afterEach(() => {
    cleanup(tmpDir, repos);
  });

  it("records ≥3 commits for a 3-step session (prompt + 2 tool calls)", async () => {
    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir, sessionName: "test-session" });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("find all users");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    expect(commits.length).toBeGreaterThanOrEqual(3);
  });

  it("prompt commit has no parent; each subsequent commit chains correctly", async () => {
    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("hello world");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    expect(commits.length).toBeGreaterThanOrEqual(3);

    const [promptCommit, toolCommit1, toolCommit2] = commits as [
      typeof commits[0],
      typeof commits[0],
      typeof commits[0],
    ];

    // Prompt commit
    expect(promptCommit.message).toContain("Prompt:");
    expect(promptCommit.toolCall).toBeNull();
    expect(promptCommit.parent).toBeNull();

    // First tool-call commit (searchDatabase)
    expect(toolCommit1.toolCall).not.toBeNull();
    expect(toolCommit1.toolCall?.name).toBe("searchDatabase");
    expect(toolCommit1.toolCall?.input).toBeDefined();
    expect(toolCommit1.toolCall?.output).toBeDefined();
    expect(toolCommit1.toolCall?.status).toBe("success");
    expect(toolCommit1.parent).toBe(promptCommit.hash);

    // Second tool-call commit (writeFile)
    expect(toolCommit2.toolCall?.name).toBe("writeFile");
    expect(toolCommit2.toolCall?.status).toBe("success");
    expect(toolCommit2.parent).toBe(toolCommit1.hash);
  });

  it("guard hooks fire before tool calls and not for the prompt", async () => {
    const guardCalls: string[] = [];
    const trackingGuard: Guard = {
      name: "tracking",
      async check(ctx: GuardContext): Promise<GuardResult> {
        guardCalls.push(ctx.toolCall.name);
        return { outcome: "allow" };
      },
    };

    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir, guards: [trackingGuard] });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("test prompt");

    // Guards should have fired for both tool calls, not for the prompt
    expect(guardCalls).toContain("searchDatabase");
    expect(guardCalls).toContain("writeFile");
    expect(guardCalls.length).toBe(2);
  });

  it("blocking guard prevents tool execution and run() rejects", async () => {
    const blockingGuard: Guard = {
      name: "blocker",
      async check(ctx: GuardContext): Promise<GuardResult> {
        if (ctx.toolCall.name === "writeFile") {
          return { outcome: "block", reason: "write operations not allowed" };
        }
        return { outcome: "allow" };
      },
    };

    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir, guards: [blockingGuard] });
    repos.push(wrapped.agentgit.repo);

    await expect(wrapped.run("test")).rejects.toThrow("blocked by guard");

    // searchDatabase should have succeeded before the block
    expect(agent.calls.some((c) => c.startsWith("search:"))).toBe(true);
    // writeFile should never have executed
    expect(agent.calls.some((c) => c.startsWith("write:"))).toBe(false);
  });

  it("session is retrievable via Repository.getSession", async () => {
    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, {
      repoDir,
      sessionName: "my-session",
      sessionMetadata: { owner: "test" },
    });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("ping");

    const sessionId = wrapped.agentgit.sessionId;
    const verifyRepo = Repository.init(repoDir);
    repos.push(verifyRepo);

    const session = verifyRepo.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.name).toBe("my-session");
    expect(session?.status).toBe("active");
  });

  it("end() transitions session status to completed", async () => {
    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("one step");
    wrapped.agentgit.end("completed");

    const session = wrapped.agentgit.repo.getSession(wrapped.agentgit.sessionId);
    expect(session?.status).toBe("completed");
  });

  it("tool call output is stored on the commit", async () => {
    const agent = new MockAgent();
    const wrapped = await wrapAgentJS(agent, { repoDir });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("data");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    const searchCommit = commits.find((c) => c.toolCall?.name === "searchDatabase");
    expect(searchCommit?.toolCall?.output).toBe("results for data");
  });
});

// ---------------------------------------------------------------------------
// AgentGitSession
// ---------------------------------------------------------------------------

describe("AgentGitSession", () => {
  let tmpDir: string;
  let repoDir: string;
  let repos: Array<{ index: { close(): void } }>;

  beforeEach(() => {
    ({ tmpDir, repoDir } = makeTmpRepo());
    repos = [];
  });

  afterEach(() => {
    cleanup(tmpDir, repos);
  });

  it("records prompt and tool call commits with correct parent linkage", () => {
    const agentSession = AgentGitSession.create(repoDir, "manual-session");
    repos.push(agentSession.repo);

    const promptCommit = agentSession.recordPrompt("what is the weather?");
    expect(promptCommit.message).toContain("Prompt:");
    expect(promptCommit.parent).toBeNull();

    const toolCall = {
      id: randomUUID(),
      name: "getWeather",
      input: { location: "NYC" },
      output: { temp: 72 },
      startedAt: Date.now(),
      completedAt: Date.now(),
      status: "success" as const,
      error: null,
    };

    const toolCommit = agentSession.recordToolCall(toolCall);
    expect(toolCommit.toolCall?.name).toBe("getWeather");
    expect(toolCommit.parent).toBe(promptCommit.hash);

    const commits = agentSession.repo.log(agentSession.id);
    expect(commits.length).toBe(2);
  });

  it("end() updates session status", () => {
    const agentSession = AgentGitSession.create(repoDir, "status-test");
    repos.push(agentSession.repo);

    agentSession.recordPrompt("hello");
    agentSession.end("completed");

    const s = agentSession.getSession();
    expect(s.status).toBe("completed");
  });

  it("getSession returns the live session record", () => {
    const agentSession = AgentGitSession.create(repoDir, "live-test");
    repos.push(agentSession.repo);

    const live = agentSession.getSession();
    expect(live.id).toBe(agentSession.id);
    expect(live.name).toBe("live-test");
  });

  it("runGuards delegates to the guard registry", async () => {
    const seen: string[] = [];
    const guard: Guard = {
      name: "spy",
      async check(ctx: GuardContext): Promise<GuardResult> {
        seen.push(ctx.toolCall.name);
        return { outcome: "allow" };
      },
    };

    const agentSession = AgentGitSession.create(repoDir, "guard-test", {}, [guard]);
    repos.push(agentSession.repo);

    const toolCall = {
      id: randomUUID(),
      name: "doSomething",
      input: {},
      output: null,
      startedAt: Date.now(),
      completedAt: null,
      status: "pending" as const,
      error: null,
    };

    const result = await agentSession.runGuards(toolCall);
    expect(result.outcome).toBe("allow");
    expect(seen).toContain("doSomething");
  });
});
