import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository, type LlmCallInput } from "@agentgit/core";
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

  it("prints LLM:, Tokens:, Prompt:, Response:, Status: for LLM commits", () => {
    const session = repo.createSession("llm-replay-session");
    const input: LlmCallInput = {
      sessionId: session.id,
      provider: "anthropic",
      model: "claude-opus",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is the capital of France?" },
      ],
      response: "The capital of France is Paris.",
      usage: { promptTokens: 12, completionTokens: 7, totalTokens: 19 },
      costEstimateUsd: 0.00042,
      startedAt: Date.now(),
      completedAt: Date.now() + 150,
    };
    repo.recordLlmCall(input);
    repo.index.close();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    replayCommand(agentgitDir, session.name);
    vi.restoreAllMocks();

    const joined = output.join("\n");
    expect(joined).toContain("LLM: claude-opus (anthropic)");
    expect(joined).toContain("Tokens: 12 prompt / 7 completion / 19 total");
    expect(joined).toContain("Cost:   ~$0.0004");
    expect(joined).toContain("Duration:");
    expect(joined).toContain("Prompt:");
    expect(joined).toContain("What is the capital of France?");
    expect(joined).toContain("Response:");
    expect(joined).toContain("The capital of France is Paris.");
    expect(joined).toContain("Status: success");

    repo = Repository.open(agentgitDir);
  });

  it("--full bypasses 500-char truncation; default truncates with …", () => {
    const session = repo.createSession("trunc-session");
    const longPrompt = "P".repeat(600);
    const longResponse = "R".repeat(600);
    const input: LlmCallInput = {
      sessionId: session.id,
      provider: "openai",
      model: "gpt-test",
      messages: [{ role: "user", content: longPrompt }],
      response: longResponse,
      usage: null,
      costEstimateUsd: null,
      startedAt: Date.now(),
    };
    repo.recordLlmCall(input);
    repo.index.close();

    // default (truncated)
    const out1: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => out1.push(String(args[0])));
    replayCommand(agentgitDir, session.name);
    vi.restoreAllMocks();
    const j1 = out1.join("\n");
    expect(j1).toContain("…");
    // prompt/response should be truncated in output
    const promptLines = out1.filter((l) => l.includes("P".repeat(100)));
    // since truncated, the full 600 P's should not appear
    expect(j1.includes("P".repeat(501))).toBe(false);

    // with --full
    const out2: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => out2.push(String(args[0])));
    replayCommand(agentgitDir, session.name, { full: true });
    vi.restoreAllMocks();
    const j2 = out2.join("\n");
    expect(j2.includes("P".repeat(600))).toBe(true);
    expect(j2.includes("R".repeat(600))).toBe(true);
    expect(j2).not.toContain("…"); // or at least the truncation … not from our text

    repo = Repository.open(agentgitDir);
  });
});
