import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapAgentJS } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers (duplicated from wrap.test.ts to keep this test hermetic)
// ---------------------------------------------------------------------------

function makeTmpRepo(): { tmpDir: string; repoDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "agentgit-sdk-llm-test-"));
  const repoDir = join(tmpDir, ".agentgit");
  return { tmpDir, repoDir };
}

/** Close all tracked SQLite connections then delete the directory. */
function cleanup(tmpDir: string, closeables: Array<{ index: { close(): void } }>): void {
  for (const c of closeables) {
    try {
      c.index.close();
    } catch {
      // ignore
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Mock agents with llm property
// ---------------------------------------------------------------------------

class AnthropicAgent {
  llm: any;
  constructor(llmClient: any) {
    this.llm = llmClient;
  }
  async run(prompt: string): Promise<string> {
    const res = await this.llm.messages.create({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: prompt }],
    });
    const text = Array.isArray(res?.content)
      ? res.content
          .filter((b: any) => b && b.type === "text")
          .map((b: any) => b.text ?? "")
          .join("\n")
      : "";
    return text || "anthropic-ok";
  }
}

class VercelAgent {
  llm: any;
  constructor(ai: any) {
    this.llm = ai;
  }
  async run(prompt: string): Promise<string> {
    const res = await this.llm.generateText({
      model: { modelId: "test-vercel" },
      prompt,
    });
    return res?.text ?? "vercel-ok";
  }
}

class ToolUsingAgentWithLlm {
  llm: any;
  calls: string[] = [];
  constructor(llmClient: any) {
    this.llm = llmClient;
  }
  async run(prompt: string): Promise<string> {
    const r1 = await this.search(prompt);
    // also exercise llm (will be captured via auto)
    await this.llm.messages.create({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "side llm" }],
    });
    this.calls.push(`run:${prompt}`);
    return `done:${r1}`;
  }
  async search(q: string): Promise<string> {
    this.calls.push(`search:${q}`);
    return `results:${q}`;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapAgentJS LLM auto-capture", () => {
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

  it("auto-wraps Anthropic-shaped agent.llm and records LlmCall commit with provider 'anthropic'", async () => {
    const mockAnth = {
      messages: {
        create: async (_params: any) => ({
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Anthropic response here" }],
          usage: { input_tokens: 11, output_tokens: 22 },
        }),
      },
    };
    const agent = new AnthropicAgent(mockAnth);
    const wrapped = wrapAgentJS(agent, { repoDir, sessionName: "anth-session" });
    repos.push(wrapped.agentgit.repo);

    // Allow the fire-and-forget dynamic-import + wrap to settle
    await new Promise((r) => setTimeout(r, 0));

    await wrapped.run("tell me about agentgit");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    const llmCommits = commits.filter((c: any) => c.llmCall && c.llmCall.provider === "anthropic");
    expect(llmCommits.length).toBeGreaterThanOrEqual(1);
    const llmC = llmCommits[0];
    expect(llmC.llmCall.model).toBe("claude-opus-4-7");
    expect(llmC.llmCall.response).toContain("Anthropic response");
    expect(llmC.llmCall.usage?.totalTokens).toBe(33);
    expect(llmC.llmCall.status).toBe("success");
  });

  it("auto-wraps Vercel-AI-shaped agent.llm and records LlmCall with provider 'vercel-ai-sdk' and usage.totalTokens", async () => {
    const mockVercel = {
      async generateText(params: any) {
        return {
          text: "Vercel generated answer",
          usage: { promptTokens: 7, completionTokens: 13, totalTokens: 20 },
          response: { modelId: "vercel-test-model" },
          toolCalls: [],
          toolResults: [],
        };
      },
    };
    const agent = new VercelAgent(mockVercel);
    const wrapped = wrapAgentJS(agent, { repoDir, sessionName: "vercel-session" });
    repos.push(wrapped.agentgit.repo);

    await new Promise((r) => setTimeout(r, 0));

    await wrapped.run("compute 2+2");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    const llmCommits = commits.filter((c: any) => c.llmCall && c.llmCall.provider === "vercel-ai-sdk");
    expect(llmCommits.length).toBeGreaterThanOrEqual(1);
    const llmC = llmCommits[0];
    expect(llmC.llmCall.model).toBe("vercel-test-model");
    expect(llmC.llmCall.usage?.totalTokens).toBe(20);
    expect(llmC.llmCall.response).toContain("Vercel generated");
  });

  it("WrapOptions.llm === false suppresses all LlmCall commits even when agent.llm exists", async () => {
    const mockAnth = {
      messages: {
        create: async () => ({
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "should not record" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    };
    const agent = new AnthropicAgent(mockAnth);
    const wrapped = wrapAgentJS(agent, { repoDir, sessionName: "no-llm", llm: false });
    repos.push(wrapped.agentgit.repo);

    await new Promise((r) => setTimeout(r, 0));

    await wrapped.run("anything");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    const hasLlm = commits.some((c: any) => c.llmCall != null);
    expect(hasLlm).toBe(false);
    // but prompt + any tool would still be there, at least prompt
    expect(commits.length).toBeGreaterThanOrEqual(1);
  });

  it("tool-call interception continues to work when agent also has llm (regression)", async () => {
    const mockAnth = {
      messages: {
        create: async (_p: any) => ({
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "llm side effect" }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      },
    };
    const agent = new ToolUsingAgentWithLlm(mockAnth);
    const wrapped = wrapAgentJS(agent, { repoDir, sessionName: "mixed" });
    repos.push(wrapped.agentgit.repo);

    await new Promise((r) => setTimeout(r, 0));

    const result = await wrapped.run("search users");

    expect(result).toContain("done:results:search users");
    expect(agent.calls).toContain("search:search users");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    // Should have prompt commit + tool search commit + llm commit (order may interleave based on timing)
    const toolCommits = commits.filter((c: any) => c.toolCall && c.toolCall.name === "search");
    const llmCommits = commits.filter((c: any) => c.llmCall && c.llmCall.provider === "anthropic");
    expect(toolCommits.length).toBeGreaterThanOrEqual(1);
    expect(llmCommits.length).toBeGreaterThanOrEqual(1);
    // Both kinds of commits present => tool interception not broken by llm wiring
  });

  it("unknown llm shape does not crash wrapAgentJS and produces no LlmCall (with debug off)", async () => {
    const weirdLlm = { foo: "bar", chat: { complete: () => {} } };
    const agent = {
      llm: weirdLlm,
      async run(p: string) {
        // even if called, we don't expect capture
        return "ok";
      },
    } as any;
    // Should not throw
    const wrapped = wrapAgentJS(agent, { repoDir, sessionName: "weird" });
    repos.push(wrapped.agentgit.repo);

    await new Promise((r) => setTimeout(r, 0));

    await wrapped.run("test");

    const commits = wrapped.agentgit.repo.log(wrapped.agentgit.sessionId);
    const hasLlm = commits.some((c: any) => c.llmCall != null);
    expect(hasLlm).toBe(false);
  });
});
