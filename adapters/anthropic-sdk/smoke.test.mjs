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
