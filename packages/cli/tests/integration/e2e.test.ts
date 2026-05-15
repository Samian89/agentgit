import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolCall, LlmCallInput } from "@agentgit/core";
import { Repository } from "@agentgit/core";
import { AgentGitSession, wrapAgentJS } from "@agentgit/sdk";
import { diffCommand } from "../../src/commands/diff.js";
import { exportCommand } from "../../src/commands/export.js";
import { logCommand } from "../../src/commands/log.js";
import { replayCommand } from "../../src/commands/replay.js";

// ---------------------------------------------------------------------------
// Zod schema for ReplayExport validation
// ---------------------------------------------------------------------------

const ReplayStateEntrySchema = z.object({
  path: z.string(),
  blobHash: z.string(),
  size: z.number(),
});

const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  output: z.unknown(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  status: z.enum(["pending", "success", "error"]),
  error: z.string().nullable(),
});

const ReplayCommitSchema = z.object({
  hash: z.string(),
  timestamp: z.number(),
  message: z.string(),
  toolCall: ToolCallSchema.nullable(),
  stateSnapshot: z.array(ReplayStateEntrySchema),
});

const ReplayExportSchema = z.object({
  version: z.literal("1"),
  sessionId: z.string(),
  sessionName: z.string(),
  exportedAt: z.number(),
  commits: z.array(ReplayCommitSchema),
});

// ---------------------------------------------------------------------------
// Mock agent — 3 tool calls so wrapAgentJS records 4 commits (prompt + 3)
// ---------------------------------------------------------------------------

class MockAgent {
  async run(prompt: string): Promise<string> {
    const data = await this.readFile("input.txt");
    const processed = await this.processData(data);
    await this.writeFile("output.txt", processed);
    return `done:${prompt}`;
  }

  async readFile(path: string): Promise<string> {
    return `content of ${path}`;
  }

  async processData(data: string): Promise<string> {
    return `processed: ${data}`;
  }

  async writeFile(_path: string, _content: string): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): { tmpDir: string; agentgitDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "agentgit-e2e-"));
  return { tmpDir, agentgitDir: join(tmpDir, ".agentgit") };
}

function makeTc(name: string): ToolCall {
  return {
    id: randomUUID(),
    name,
    input: { step: name },
    output: `result of ${name}`,
    startedAt: Date.now(),
    completedAt: Date.now(),
    status: "success",
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("E2E integration", () => {
  let tmpDir: string;
  let agentgitDir: string;
  let repos: Array<{ index: { close(): void } }>;

  beforeEach(() => {
    ({ tmpDir, agentgitDir } = makeTmpRepo());
    repos = [];
  });

  afterEach(() => {
    for (const r of repos) {
      try {
        r.index.close();
      } catch {
        // already closed
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 1 — wrapAgentJS records ≥3 commits with correct parent linkage
  // -----------------------------------------------------------------------

  it("wrapAgentJS records ≥3 commits with correct parent linkage", async () => {
    const agent = new MockAgent();
    const wrapped = wrapAgentJS(agent, {
      repoDir: agentgitDir,
      sessionName: "sdk-e2e-session",
    });
    repos.push(wrapped.agentgit.repo);

    await wrapped.run("analyze input and produce output");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    // prompt + readFile + processData + writeFile = 4
    expect(commits.length).toBeGreaterThanOrEqual(3);

    // Prompt commit is first, has no parent
    expect(commits[0].parent).toBeNull();
    expect(commits[0].message).toMatch(/^Prompt:/);

    // Every subsequent commit chains to the previous
    for (let i = 1; i < commits.length; i++) {
      expect(commits[i].parent).toBe(commits[i - 1].hash);
    }

    // All non-prompt commits carry a tool call
    for (const c of commits.slice(1)) {
      expect(c.toolCall).not.toBeNull();
      expect(c.toolCall?.status).toBe("success");
    }
  });

  // -----------------------------------------------------------------------
  // Test 2 — content-addressed hash is deterministic across repos
  // -----------------------------------------------------------------------

  it("content-addressed blob hash is deterministic across separate repos", () => {
    const content = "deterministic content for hash test";
    const path = "state.txt";

    const { tmpDir: aDirTmp, agentgitDir: aDirRepo } = makeTmpRepo();
    const repoA = Repository.init(aDirRepo);
    const sessionA = repoA.createSession("hash-test-a");
    const commitA = repoA.commit({
      sessionId: sessionA.id,
      message: "step 1",
      stateEntries: [{ path, content }],
    });

    const { tmpDir: bDirTmp, agentgitDir: bDirRepo } = makeTmpRepo();
    const repoB = Repository.init(bDirRepo);
    const sessionB = repoB.createSession("hash-test-b");
    const commitB = repoB.commit({
      sessionId: sessionB.id,
      message: "step 1",
      stateEntries: [{ path, content }],
    });

    const entriesA = repoA.index.getTreeEntries(commitA.tree);
    const entriesB = repoB.index.getTreeEntries(commitB.tree);
    expect(entriesA[0].blobHash).toBe(entriesB[0].blobHash);

    repoA.index.close();
    repoB.index.close();
    rmSync(aDirTmp, { recursive: true, force: true });
    rmSync(bDirTmp, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Test 3 — diffCommand outputs non-empty diff between two commits
  // -----------------------------------------------------------------------

  it("diffCommand produces non-empty output between commits with different state", () => {
    const session = AgentGitSession.create(agentgitDir, "diff-e2e");

    const c1 = session.recordPrompt("search for files", [
      { path: "input.txt", content: "raw data" },
    ]);

    const c2 = session.recordToolCall(makeTc("processFiles"), [
      { path: "input.txt", content: "raw data" },
      { path: "output.txt", content: "processed: raw data" },
    ]);

    // diffCommand opens its own connection; close ours first
    session.repo.index.close();

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    diffCommand(agentgitDir, c1.hash, c2.hash);
    vi.restoreAllMocks();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/output\.txt/);

    repos.push(Repository.open(agentgitDir));
  });

  // -----------------------------------------------------------------------
  // Test 4 — exportCommand JSON validates against ReplayExport zod schema
  // -----------------------------------------------------------------------

  it("exportCommand JSON validates against ReplayExport zod schema", () => {
    const SESSION_NAME = "export-e2e-session";
    const session = AgentGitSession.create(agentgitDir, SESSION_NAME);

    session.recordPrompt("step 1");
    session.recordToolCall(makeTc("queryDatabase"), [
      { path: "results.json", content: '{"count":42}' },
    ]);
    session.recordToolCall(makeTc("writeReport"), [
      { path: "results.json", content: '{"count":42}' },
      { path: "report.txt", content: "Report: 42 items" },
    ]);
    session.end("completed");

    // exportCommand opens its own connection; close ours first
    session.repo.index.close();

    let captured = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured += String(chunk);
      return true;
    });
    exportCommand(agentgitDir, SESSION_NAME);
    vi.restoreAllMocks();

    const json: unknown = JSON.parse(captured);
    const result = ReplayExportSchema.safeParse(json);
    expect(
      result.success,
      result.success ? "" : `Zod error: ${JSON.stringify(result.error.issues)}`,
    ).toBe(true);

    if (result.success) {
      expect(result.data.version).toBe("1");
      expect(result.data.sessionName).toBe(SESSION_NAME);
      expect(result.data.commits.length).toBeGreaterThanOrEqual(3);
      const withToolCall = result.data.commits.filter((c) => c.toolCall !== null);
      expect(withToolCall.length).toBeGreaterThanOrEqual(2);
    }

    // exportCommand closes the repo; reopen for cleanup
    repos.push(Repository.open(agentgitDir));
  });

  // -----------------------------------------------------------------------
  // Test 5 — logCommand and replayCommand render LlmCall commits (via recordLlmCall)
  // -----------------------------------------------------------------------

  it("log shows llm: lines, --llm-only/--tool-only filter; replay shows LLM block with tokens/prompt/response", () => {
    const repo = Repository.init(agentgitDir);
    const session = repo.createSession("llm-e2e-session");

    // tool commit
    repo.commit({
      sessionId: session.id,
      message: "tool step",
      toolCall: makeTc("searchWeb"),
      stateEntries: [],
    });

    // LLM commit via recordLlmCall (from spec 001)
    const llmInput: LlmCallInput = {
      sessionId: session.id,
      provider: "anthropic",
      model: "claude-e2e",
      messages: [{ role: "user", content: "Summarize the news" }],
      response: "Summary: markets up.",
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      costEstimateUsd: 0.00055,
      startedAt: Date.now() - 100,
      completedAt: Date.now(),
    };
    repo.recordLlmCall(llmInput);

    repo.index.close();

    // Test logCommand output contains both tool: and llm:
    const logLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logLines.push(args.map(String).join(" ")));
    logCommand(agentgitDir);
    vi.restoreAllMocks();
    const logOut = logLines.join("\n");
    expect(logOut).toContain("tool: searchWeb (success)");
    expect(logOut).toContain("llm: claude-e2e (30 tok ~$0.0006)");

    // --llm-only filters out the tool commit
    const logLlmOnly: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logLlmOnly.push(args.map(String).join(" ")));
    logCommand(agentgitDir, { llmOnly: true });
    vi.restoreAllMocks();
    const llmOnlyOut = logLlmOnly.join("\n");
    expect(llmOnlyOut).toContain("llm: claude-e2e");
    expect(llmOnlyOut).not.toContain("searchWeb");

    // --tool-only filters out the llm commit
    const logToolOnly: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logToolOnly.push(args.map(String).join(" ")));
    logCommand(agentgitDir, { toolOnly: true });
    vi.restoreAllMocks();
    const toolOnlyOut = logToolOnly.join("\n");
    expect(toolOnlyOut).toContain("tool: searchWeb");
    expect(toolOnlyOut).not.toContain("claude-e2e");

    // Test replayCommand shows LLM block
    const replayLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => replayLines.push(args.map(String).join(" ")));
    replayCommand(agentgitDir, session.name);
    vi.restoreAllMocks();
    const replayOut = replayLines.join("\n");
    expect(replayOut).toContain("LLM: claude-e2e (anthropic)");
    expect(replayOut).toContain("Tokens: 20 prompt / 10 completion / 30 total");
    expect(replayOut).toContain("Prompt:");
    expect(replayOut).toContain("Summarize the news");
    expect(replayOut).toContain("Response:");
    expect(replayOut).toContain("Summary: markets up.");
    expect(replayOut).toContain("Status: success");

    // reopen for afterEach cleanup
    repos.push(Repository.open(agentgitDir));
  });
});
