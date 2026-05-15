import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository, type LlmCallInput } from "../repository.js";
import type { LlmCall, LlmMessage, LlmUsage } from "../types.js";

let dir: string;
let repo: Repository;
let sessionId: string;

const FIXED_NOW = 1_700_000_000_000;
const FIXED_UUID = "12345678-1234-1234-1234-123456789abc";

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-llm-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  repo = Repository.init(join(dir, ".agentgit"));
  const s = repo.createSession("llm-test");
  sessionId = s.id;
});

afterEach(() => {
  repo.index.close();
  rmSync(dir, { recursive: true, force: true });
});

const sampleMessages: LlmMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "What is 2+2?" },
];
const sampleUsage: LlmUsage = { promptTokens: 12, completionTokens: 4, totalTokens: 16 };

function makeLlmCall(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    provider: overrides.provider ?? "test-provider",
    model: overrides.model ?? "test-model-7b",
    messages: overrides.messages ?? sampleMessages,
    response: overrides.response ?? "4",
    usage: overrides.usage ?? sampleUsage,
    costEstimateUsd: overrides.costEstimateUsd ?? 0.00042,
    startedAt: overrides.startedAt ?? FIXED_NOW,
    completedAt: overrides.completedAt ?? FIXED_NOW + 123,
    durationMs: overrides.durationMs ?? 123,
    status: overrides.status ?? "success",
    error: overrides.error ?? null,
  };
}

describe("Repository.commit with llmCall", () => {
  it("round-trips LlmCall through SQLite and object store", () => {
    const llmCall = makeLlmCall();
    const c = repo.commit({
      sessionId,
      message: "LLM: test-model-7b",
      stateEntries: [],
      llmCall,
    });
    expect(c.llmCall).toEqual(llmCall);

    const reloaded = repo.index.getCommit(c.hash);
    expect(reloaded?.llmCall).toEqual(llmCall);
    expect(reloaded?.toolCall).toBeNull();
  });

  it("persists null llmCall explicitly (new commits always carry the field)", () => {
    const c = repo.commit({ sessionId, message: "plain" });
    expect(c.llmCall).toBeNull();
    const reloaded = repo.index.getCommit(c.hash);
    expect(reloaded?.llmCall).toBeNull();
  });
});

describe("Repository.recordLlmCall", () => {
  it("builds LlmCall, uses 'LLM: <model>' message, empty state, and round-trips", () => {
    const input: LlmCallInput = {
      sessionId,
      provider: "anthropic",
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hello" }],
      response: "hi there",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      costEstimateUsd: 0.00123,
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW + 77,
    };
    const commit = repo.recordLlmCall(input);
    expect(commit.message).toBe("LLM: claude-opus-4-7");
    expect(commit.llmCall).not.toBeNull();
    expect(commit.llmCall?.provider).toBe("anthropic");
    expect(commit.llmCall?.model).toBe("claude-opus-4-7");
    expect(commit.llmCall?.response).toBe("hi there");
    expect(commit.llmCall?.status).toBe("success");
    expect(commit.llmCall?.id).toBeDefined();
    expect(commit.llmCall?.startedAt).toBe(FIXED_NOW);
    expect(commit.llmCall?.durationMs).toBe(77);

    const reloaded = repo.index.getCommit(commit.hash);
    expect(reloaded?.llmCall).toEqual(commit.llmCall);
  });

  it("auto-stamps id, timestamps, duration, status when omitted", () => {
    const commit = repo.recordLlmCall({
      sessionId,
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
      response: "pong",
    });
    expect(commit.llmCall?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(commit.llmCall?.startedAt).toBeGreaterThan(0);
    expect(commit.llmCall?.completedAt).toBeGreaterThanOrEqual(commit.llmCall!.startedAt);
    expect(commit.llmCall?.durationMs).toBeGreaterThanOrEqual(0);
    expect(commit.llmCall?.status).toBe("success");
    expect(commit.llmCall?.error).toBeNull();
  });

  it("produces deterministic content-addressed hash for fixed inputs (canonical JSON)", () => {
    // Use fixed id and timestamps so hash is stable across runs
    const fixedLlmCall = makeLlmCall({
      id: FIXED_UUID,
      provider: "deterministic",
      model: "det-model",
      messages: [{ role: "user", content: "fixed prompt" }],
      response: "fixed response",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      costEstimateUsd: null,
      startedAt: 1_600_000_000_000,
      completedAt: 1_600_000_000_050,
      durationMs: 50,
      status: "success",
      error: null,
    });

    // Record via the convenience wrapper (it will use the provided id/timestamps)
    const c = repo.recordLlmCall({
      sessionId,
      id: FIXED_UUID,
      provider: fixedLlmCall.provider,
      model: fixedLlmCall.model,
      messages: fixedLlmCall.messages,
      response: fixedLlmCall.response,
      usage: fixedLlmCall.usage,
      costEstimateUsd: fixedLlmCall.costEstimateUsd,
      startedAt: fixedLlmCall.startedAt,
      completedAt: fixedLlmCall.completedAt,
      durationMs: fixedLlmCall.durationMs,
      status: fixedLlmCall.status,
      error: fixedLlmCall.error,
      // force a known parent so body is identical
      parentHash: null,
      metadata: {},
    });

    // Reconstruct the exact body that was hashed (Omit hash/signature/publicKey)
    const bodyForHash = {
      type: "commit" as const,
      tree: c.tree,
      parent: c.parent,
      sessionId: c.sessionId,
      timestamp: c.timestamp,
      message: c.message,
      toolCall: c.toolCall,
      llmCall: c.llmCall,
      metadata: c.metadata,
      author: c.author,
    };
    const expectedHash = Repository.hashObject(bodyForHash as Record<string, unknown>);
    expect(c.hash).toBe(expectedHash);
    // Also verify via getCommit that SQLite side preserved it
    expect(repo.index.getCommit(c.hash)?.llmCall?.id).toBe(FIXED_UUID);
  });

  it("records error status LlmCall", () => {
    const c = repo.recordLlmCall({
      sessionId,
      provider: "test",
      model: "err-model",
      messages: [],
      response: "",
      status: "error",
      error: "rate limit",
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW + 10,
    });
    expect(c.llmCall?.status).toBe("error");
    expect(c.llmCall?.error).toBe("rate limit");
    expect(c.llmCall?.response).toBe("");
  });
});
