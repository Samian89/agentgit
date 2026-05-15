import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../repository.js";
import type { LlmCallInput } from "../repository.js";
import type { LlmCall, LlmMessage } from "../types.js";
import { buildRedactor, redactLlmCall, validateRedactionPatterns } from "../redact.js";
import type { LlmRedactionConfig } from "../config.js";

let dir: string;
let repo: Repository;
let sessionId: string;
let agentgitDir: string;

const FIXED_NOW = 1_700_000_000_000;
const FIXED_UUID = "12345678-1234-1234-1234-123456789abc";

beforeEach(() => {
  dir = join(tmpdir(), `agentgit-redact-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  agentgitDir = join(dir, ".agentgit");
  mkdirSync(agentgitDir, { recursive: true });
  // Write a config with redaction to test init-time load
  // (tests will override per-case)
});

afterEach(() => {
  if (repo) {
    try {
      repo.index.close();
    } catch {
      // ignore
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(redaction: LlmRedactionConfig) {
  const cfg = {
    llm: { redaction },
  };
  mkdirSync(agentgitDir, { recursive: true });
  require("node:fs").writeFileSync(
    join(agentgitDir, "config.json"),
    JSON.stringify(cfg, null, 2),
  );
}

const sampleMessages: LlmMessage[] = [
  { role: "system", content: "You are helpful. Token: sk-1234567890abcdefghij" },
  { role: "user", content: "What is secret123?" },
];

describe("buildRedactor and redactLlmCall", () => {
  it("returns null when no patterns", () => {
    expect(buildRedactor(undefined)).toBeNull();
    expect(buildRedactor({})).toBeNull();
    expect(buildRedactor({ redactPatterns: [] })).toBeNull();
    expect(buildRedactor({ enabled: false, redactPatterns: ["x"] })).toBeNull();
  });

  it("redacts messages and response using patterns (default placeholder)", () => {
    const cfg: LlmRedactionConfig = { redactPatterns: ["sk-[A-Za-z0-9]+", "secret123"] };
    const redact = buildRedactor(cfg)!;
    expect(redact).not.toBeNull();

    const call: LlmCall = {
      id: FIXED_UUID,
      provider: "test",
      model: "m",
      messages: sampleMessages,
      response: "The secret123 is hidden but sk-999 was used",
      usage: null,
      costEstimateUsd: null,
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW + 10,
      durationMs: 10,
      status: "success",
      error: null,
    };

    const redacted = redactLlmCall(call, redact)!;
    expect(redacted.messages[0]!.content).toBe("You are helpful. Token: [REDACTED]");
    expect(redacted.messages[1]!.content).toBe("What is [REDACTED]?");
    expect(redacted.response).toBe("The [REDACTED] is hidden but [REDACTED] was used");
  });

  it("redacts error field too", () => {
    const cfg: LlmRedactionConfig = { redactPatterns: ["sk-[0-9]+"] };
    const redact = buildRedactor(cfg)!;
    const call: LlmCall = {
      id: FIXED_UUID,
      provider: "t",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response: "",
      usage: null,
      costEstimateUsd: null,
      startedAt: FIXED_NOW,
      completedAt: null,
      durationMs: null,
      status: "error",
      error: "auth failed with sk-12345",
    };
    const redacted = redactLlmCall(call, redact)!;
    expect(redacted.error).toBe("auth failed with [REDACTED]");
  });

  it("is idempotent: redacting already-redacted content yields identical result", () => {
    const cfg: LlmRedactionConfig = { redactPatterns: ["sk-[A-Za-z0-9]+"] };
    const redact = buildRedactor(cfg)!;
    const original = "sk-abc123";
    const once = redact(original);
    const twice = redact(once);
    expect(once).toBe("[REDACTED]");
    expect(twice).toBe("[REDACTED]");
  });
});

describe("Repository.init rejects invalid regex", () => {
  it("throws on init when redactPatterns contains invalid regex", () => {
    writeConfig({ redactPatterns: ["[invalid"] });
    expect(() => Repository.init(agentgitDir)).toThrow(/Invalid regex pattern.*\[invalid/);
  });

  it("throws with pattern in message", () => {
    writeConfig({ redactPatterns: ["(?P<name>foo)"] }); // named group may be ok in ES? but use bad
    // Use truly invalid: unclosed [
    writeConfig({ redactPatterns: ["[unclosed"] });
    expect(() => Repository.init(agentgitDir)).toThrow(/\[unclosed/);
  });
});

describe("Repository.commit + recordLlmCall with redaction", () => {
  beforeEach(() => {
    writeConfig({ redactPatterns: ["sk-[A-Za-z0-9]{8,}", "TOPSECRET"] });
    repo = Repository.init(agentgitDir);
    const s = repo.createSession("redact-test");
    sessionId = s.id;
  });

  it("redacts llmCall content before hashing; getCommit returns redacted", () => {
    const input: LlmCallInput = {
      sessionId,
      provider: "openai",
      model: "gpt-4",
      messages: [
        { role: "user", content: "Use sk-abcdefgh12345678 now" },
      ],
      response: "Done with TOPSECRET",
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW + 5,
    };
    const c = repo.recordLlmCall(input);
    expect(c.llmCall).not.toBeNull();
    expect(c.llmCall!.messages[0]!.content).toBe("Use [REDACTED] now");
    expect(c.llmCall!.response).toBe("Done with [REDACTED]");

    // Re-read via index / getCommit
    const reloaded = repo.index.getCommit(c.hash);
    expect(reloaded?.llmCall?.response).toBe("Done with [REDACTED]");

    // The object file on disk must contain only redacted text
    // Find the object path and check content includes redacted, not raw secret
    const objPath = join(
      agentgitDir,
      "objects",
      c.hash.slice(0, 2),
      c.hash.slice(2),
    );
    const objText = readFileSync(objPath, "utf8");
    expect(objText).toContain("[REDACTED]");
    expect(objText).not.toContain("sk-abcdefgh12345678");
    expect(objText).not.toContain("TOPSECRET");
  });

  it("redacts via direct commit(llmCall) too", () => {
    const llmCall: LlmCall = {
      id: FIXED_UUID,
      provider: "x",
      model: "y",
      messages: [{ role: "user", content: "key=sk-12345678" }],
      response: "ok",
      usage: null,
      costEstimateUsd: null,
      startedAt: FIXED_NOW,
      completedAt: FIXED_NOW,
      durationMs: 0,
      status: "success",
      error: null,
    };
    const c = repo.commit({
      sessionId,
      message: "LLM: y",
      stateEntries: [],
      llmCall,
    });
    expect(c.llmCall!.messages[0]!.content).toBe("key=[REDACTED]");
  });

  it("does not redact tool calls when includeToolCalls: false", () => {
    // Re-init with new config
    repo.index.close();
    rmSync(dir, { recursive: true, force: true });
    dir = join(tmpdir(), `agentgit-redact2-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    agentgitDir = join(dir, ".agentgit");
    writeConfig({
      redactPatterns: ["sk-[0-9]+"],
      includeToolCalls: false,
    });
    repo = Repository.init(agentgitDir);
    const s = repo.createSession("no-tool-redact");
    sessionId = s.id;

    const c = repo.commit({
      sessionId,
      message: "tool",
      stateEntries: [],
      toolCall: {
        id: "t1",
        name: "echo",
        input: { q: "sk-999" },
        output: "sk-999",
        startedAt: FIXED_NOW,
        completedAt: FIXED_NOW,
        status: "success",
        error: null,
      },
    });
    // Should NOT be redacted because includeToolCalls=false
    expect(c.toolCall!.input.q).toBe("sk-999");
    expect(c.toolCall!.output).toBe("sk-999");
  });
});
