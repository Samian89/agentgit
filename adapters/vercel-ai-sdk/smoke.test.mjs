// Smoke test for the Vercel AI SDK adapter — uses an in-memory mock of the
// SDK so it runs offline.
import test from "node:test";
import assert from "node:assert/strict";

import { wrapAI, inMemoryRecorder } from "./src/index.mjs";

function mockAI() {
  return {
    async generateText(_params) {
      return {
        text: "ok",
        toolCalls: [
          { toolCallId: "tc_1", toolName: "search", args: { q: "agentgit" } },
        ],
        toolResults: [{ toolCallId: "tc_1", result: "found" }],
      };
    },
    async streamText(_params) {
      const events = [
        { type: "text-delta", textDelta: "hi" },
        { type: "tool-call", toolCallId: "tc_2", toolName: "calc", args: { expr: "1+1" } },
        { type: "tool-result", toolCallId: "tc_2", result: 2 },
        { type: "finish", finishReason: "stop" },
      ];
      return {
        fullStream: (async function* () {
          for (const e of events) yield e;
        })(),
      };
    },
  };
}

test("wrapAI(generateText) records each tool call", async () => {
  const recorder = inMemoryRecorder();
  const ai = wrapAI(mockAI(), { recorder });
  await ai.generateText({ prompt: "x" });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].name, "search");
  assert.equal(recorder.calls[0].status, "success");
  assert.equal(recorder.calls[0].output, "found");
});

test("wrapAI(streamText) records tool-call/tool-result pairs from fullStream", async () => {
  const recorder = inMemoryRecorder();
  const ai = wrapAI(mockAI(), { recorder });
  const result = await ai.streamText({ prompt: "y" });
  // Drain the stream — the wrapper records as it goes.
  for await (const _ of result.fullStream) {
    // nothing
  }
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].name, "calc");
  assert.equal(recorder.calls[0].output, 2);
});

test("wrapAI(generateText) records LlmCall with usage.totalTokens and model from response", async () => {
  const recorder = inMemoryRecorder();
  const ai = wrapAI(
    {
      async generateText(_params) {
        return {
          text: "The answer is 42.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          response: { modelId: "openai/gpt-4o" },
          toolCalls: [],
          toolResults: [],
        };
      },
    },
    { recorder },
  );
  await ai.generateText({ prompt: "what is the answer?" });
  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.provider, "vercel-ai-sdk");
  assert.equal(llm.model, "openai/gpt-4o");
  assert.equal(llm.usage.totalTokens, 30);
  assert.equal(llm.response, "The answer is 42.");
  assert.equal(llm.status, "success");
  assert.ok(typeof llm.durationMs === "number" && llm.durationMs >= 0);
  assert.ok(llm.messages.length >= 1);
  // pricing returns numeric for known model
  assert.equal(typeof llm.costEstimateUsd, "number");
  assert.ok(llm.costEstimateUsd > 0);
});

test("wrapAI(streamText) accumulates text-delta into llmCall.response and records after drain", async () => {
  const recorder = inMemoryRecorder();
  const ai = wrapAI(mockAI(), { recorder });
  const result = await ai.streamText({ prompt: "y" });
  for await (const _ of result.fullStream) {
    // drain
  }
  // The original mockAI stream has one text-delta "hi" + tool events
  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.provider, "vercel-ai-sdk");
  assert.equal(llm.response, "hi");
  assert.equal(llm.status, "success");
  // tool calls still captured
  assert.equal(recorder.calls.length, 1);
});

test("wrapAI(streamText) captures usage from post-stream Promise (deferred)", async () => {
  const recorder = inMemoryRecorder();
  const deferredUsage = Promise.resolve({
    promptTokens: 5,
    completionTokens: 7,
    totalTokens: 12,
  });
  const aiMock = {
    async streamText(_params) {
      const events = [
        { type: "text-delta", textDelta: "hello " },
        { type: "text-delta", textDelta: "world" },
        { type: "finish", finishReason: "stop" },
      ];
      return {
        fullStream: (async function* () {
          for (const e of events) yield e;
        })(),
        usage: deferredUsage,
      };
    },
  };
  const ai = wrapAI(aiMock, { recorder });
  const result = await ai.streamText({ prompt: "tell me" });
  for await (const _ of result.fullStream) {
    // drain
  }
  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.response, "hello world");
  assert.equal(llm.usage.totalTokens, 12);
  assert.equal(llm.status, "success");
  assert.ok(llm.durationMs >= 0);
});

test("wrapAI(generateText) records status:error LlmCall and re-throws on upstream error", async () => {
  const recorder = inMemoryRecorder();
  const boom = new Error("rate-limited");
  const ai = wrapAI(
    {
      async generateText() {
        throw boom;
      },
    },
    { recorder },
  );
  await assert.rejects(async () => ai.generateText({ prompt: "x" }), /rate-limited/);
  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.status, "error");
  assert.ok(llm.error.includes("rate-limited"));
  assert.equal(llm.response, "");
});

test("wrapAI(streamText) records status:error LlmCall with partial response and re-throws on stream error", async () => {
  const recorder = inMemoryRecorder();
  const aiMock = {
    async streamText(_params) {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "partial " };
          throw new Error("stream broke");
        })(),
      };
    },
  };
  const ai = wrapAI(aiMock, { recorder });
  const result = await ai.streamText({ prompt: "z" });
  await assert.rejects(
    (async () => {
      for await (const _ of result.fullStream) {
        // drain
      }
    })(),
    /stream broke/,
  );
  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.status, "error");
  assert.equal(llm.response, "partial ");
  assert.ok(llm.error.includes("stream broke"));
});

test("wrapAI(generateText) records both toolCall and LlmCall for same invocation", async () => {
  const recorder = inMemoryRecorder();
  const ai = wrapAI(
    {
      async generateText(_params) {
        return {
          text: "used tool",
          usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 },
          response: { modelId: "openai/gpt-4o-mini" },
          toolCalls: [{ toolCallId: "tc_x", toolName: "lookup", args: { q: "a" } }],
          toolResults: [{ toolCallId: "tc_x", result: "ok" }],
        };
      },
    },
    { recorder },
  );
  await ai.generateText({ prompt: "do it" });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].name, "lookup");
  assert.equal(recorder.llmCalls.length, 1);
  assert.equal(recorder.llmCalls[0].model, "openai/gpt-4o-mini");
  assert.equal(recorder.llmCalls[0].usage.totalTokens, 10);
});
