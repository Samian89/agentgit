// Smoke test for the Anthropic SDK adapter.
//
// Run with:  node --test smoke.test.mjs
//
// Mocks the Anthropic SDK so we don't need a real API key or network call.
import test from "node:test";
import assert from "node:assert/strict";

import { wrapAnthropic, inMemoryRecorder, extractToolUses } from "./src/index.mjs";

function mockAnthropicClient() {
  // Scripted response sequence for `messages.create`.
  const queue = [
    {
      id: "msg_1",
      content: [
        { type: "text", text: "let me look that up" },
        { type: "tool_use", id: "toolu_1", name: "search", input: { q: "agentgit" } },
      ],
    },
    {
      id: "msg_2",
      content: [{ type: "text", text: "here's the answer" }],
    },
  ];
  return {
    messages: {
      create: async (_params) => queue.shift(),
    },
  };
}

test("wrapAnthropic records a commit per tool_use → tool_result pair", async () => {
  const recorder = inMemoryRecorder();
  const client = wrapAnthropic(mockAnthropicClient(), { recorder });

  // First turn: assistant emits a tool_use block.
  await client.messages.create({ messages: [{ role: "user", content: "search agentgit" }] });
  assert.equal(client.agentgit.pending.size, 1);
  assert.equal(recorder.calls.length, 0);

  // Second turn: user echoes back the tool_result; recorder fires.
  await client.messages.create({
    messages: [
      { role: "user", content: "search agentgit" },
      { role: "assistant", content: [] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "found it" },
        ],
      },
    ],
  });

  assert.equal(client.agentgit.pending.size, 0);
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].name, "search");
  assert.equal(recorder.calls[0].status, "success");
  assert.equal(recorder.calls[0].output, "found it");
});

test("flush() commits in-flight calls so partial conversations aren't dropped", async () => {
  const recorder = inMemoryRecorder();
  const client = wrapAnthropic(mockAnthropicClient(), { recorder });
  await client.messages.create({ messages: [] });
  assert.equal(client.agentgit.pending.size, 1);
  client.agentgit.flush();
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].status, "pending");
});

test("extractToolUses returns only tool_use blocks", () => {
  const blocks = extractToolUses({
    content: [
      { type: "text", text: "x" },
      { type: "tool_use", id: "a", name: "n", input: {} },
      { type: "tool_use", id: "b", name: "n", input: {} },
    ],
  });
  assert.equal(blocks.length, 2);
});

test("wrapAnthropic records exactly one LlmCall per successful messages.create", async () => {
  const recorder = inMemoryRecorder();
  const client = wrapAnthropic(
    {
      messages: {
        create: async (_params) => ({
          id: "msg_llm_1",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "The answer is 42." }],
          usage: { input_tokens: 12, output_tokens: 34 },
        }),
      },
    },
    { recorder },
  );

  await client.messages.create({
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "what is the answer?" }],
  });

  assert.equal(recorder.llmCalls.length, 1);
  const llm = recorder.llmCalls[0];
  assert.equal(llm.provider, "anthropic");
  assert.equal(llm.model, "claude-opus-4-7");
  assert.equal(llm.response, "The answer is 42.");
  assert.deepEqual(llm.usage, { promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  assert.equal(typeof llm.costEstimateUsd, "number");
  assert.ok(llm.costEstimateUsd > 0); // known model in pricing table
  assert.equal(llm.status, "success");
  assert.equal(llm.error, null);
  assert.ok(typeof llm.durationMs === "number" && llm.durationMs >= 0);
  assert.ok(Array.isArray(llm.messages) && llm.messages.length === 1);
  assert.equal(llm.messages[0].role, "user");
  assert.equal(llm.messages[0].content, "what is the answer?");
});

test("wrapAnthropic records status:error LlmCall, re-throws upstream error, and preserves tool tests", async () => {
  const recorder = inMemoryRecorder();
  const client = wrapAnthropic(
    {
      messages: {
        create: async () => {
          throw new Error("rate limit exceeded");
        },
      },
    },
    { recorder },
  );

  let threw = false;
  let caught;
  try {
    await client.messages.create({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
  } catch (e) {
    threw = true;
    caught = e;
  }
  assert.equal(threw, true);
  assert.match(String(caught), /rate limit exceeded/);

  assert.equal(recorder.llmCalls.length, 1);
  const errCall = recorder.llmCalls[0];
  assert.equal(errCall.status, "error");
  assert.equal(errCall.error, "Error: rate limit exceeded");
  assert.equal(errCall.response, "");
  assert.equal(errCall.model, "claude-sonnet-4-6");
  assert.equal(errCall.provider, "anthropic");
});
