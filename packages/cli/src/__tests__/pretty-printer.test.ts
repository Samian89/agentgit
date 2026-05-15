import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repository, type LlmCallInput } from "@agentgit/core";
import { printLog } from "../pretty-printer.js";

let testDir: string;
let agentgitDir: string;
let repo: Repository;

const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  testDir = join(tmpdir(), `agentgit-pp-test-${crypto.randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  agentgitDir = join(testDir, ".agentgit");
  repo = Repository.init(agentgitDir);
});

afterEach(() => {
  repo.index.close();
  rmSync(testDir, { recursive: true, force: true });
});

function makeLlmInput(overrides: Partial<LlmCallInput> = {}): LlmCallInput {
  return {
    sessionId: "",
    provider: "test-provider",
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    response: "hi",
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    costEstimateUsd: 0.0001,
    startedAt: FIXED_NOW,
    completedAt: FIXED_NOW + 50,
    ...overrides,
  };
}

describe("printLog", () => {
  it("renders llm: prefix and token/cost summary for LlmCall-only commits", () => {
    const session = repo.createSession("llm-only-session");
    const input = makeLlmInput({ sessionId: session.id, model: "claude-3", costEstimateUsd: 0.00123 });
    const commit = repo.recordLlmCall(input);

    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    const commits = repo.log(session.id);
    printLog(commits);
    spy.mockRestore();

    const joined = output.join("\n");
    expect(joined).toContain("llm: claude-3 (8 tok ~$0.0012)");
    expect(joined).not.toContain("tool:");
  });

  it("renders both tool: and llm: lines when a commit carries both", () => {
    const session = repo.createSession("both-session");
    const llm = makeLlmInput({ sessionId: session.id, model: "gpt-4o", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } });
    const toolCall = {
      id: "tc1",
      name: "search",
      input: { q: "x" },
      output: "y",
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW + 10,
      status: "success" as const,
      error: null,
    };
    const commit = repo.commit({
      sessionId: session.id,
      message: "both",
      toolCall,
      llmCall: {
        id: "lc1",
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "user", content: "q" }],
        response: "a",
        usage: llm.usage!,
        costEstimateUsd: null,
        startedAt: FIXED_NOW,
        completedAt: FIXED_NOW + 20,
        durationMs: 20,
        status: "success",
        error: null,
      },
    });

    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      output.push(String(args[0]));
    });

    const commits = repo.log(session.id);
    printLog(commits);
    spy.mockRestore();

    const joined = output.join("\n");
    expect(joined).toContain("tool: search (success)");
    expect(joined).toContain("llm: gpt-4o (30 tok)");
    // no cost since null
  });
});
