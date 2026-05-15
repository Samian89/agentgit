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
