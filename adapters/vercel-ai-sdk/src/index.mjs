// Vercel AI SDK adapter for AgentGit.
//
// The Vercel AI SDK exposes top-level helpers `generateText({...})` and
// `streamText({...})`. Both can return tool invocations via either:
//   * `result.toolCalls` (sync, after generateText resolves), or
//   * the async-iterable `result.fullStream` of `{ type, toolCallId, ... }`
//     events emitted by streamText.
//
// `wrapAI(ai, { recorder })` returns a façade that has the same surface but
// records each tool invocation as a commit-worthy ToolCall.

/**
 * @typedef {Object} RecordedToolCall
 * @property {string} id
 * @property {string} name
 * @property {unknown} input
 * @property {unknown} output
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {"pending"|"success"|"error"} status
 * @property {string|null} error
 */

export function inMemoryRecorder() {
  const calls = [];
  return {
    calls,
    record(call) {
      calls.push(call);
    },
  };
}

/**
 * Wrap a Vercel AI SDK module-like object. We accept `{ generateText, streamText }`
 * shape and return a façade with the same shape, instrumented to record.
 *
 * @template T
 * @param {T & { generateText?: Function, streamText?: Function }} ai
 * @param {{ recorder?: { record: (c: RecordedToolCall) => void } }} [options]
 */
export function wrapAI(ai, options = {}) {
  const recorder = options.recorder ?? inMemoryRecorder();
  const wrapped = { ...ai };

  if (typeof ai.generateText === "function") {
    wrapped.generateText = async (params) => {
      const startedAt = Date.now();
      const result = await ai.generateText(params);
      // Vercel AI SDK ≥3.0 returns { toolCalls: [{ toolCallId, toolName, args }], toolResults: [...] }.
      const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
      const results = Array.isArray(result?.toolResults) ? result.toolResults : [];
      const resultById = new Map(
        results.map((r) => [r.toolCallId, r.result ?? r.output ?? null]),
      );
      for (const c of calls) {
        recorder.record({
          id: c.toolCallId ?? c.id ?? cryptoRandom(),
          name: c.toolName ?? c.name ?? "tool",
          input: c.args ?? c.input ?? {},
          output: resultById.get(c.toolCallId) ?? null,
          startedAt,
          completedAt: Date.now(),
          status: resultById.has(c.toolCallId) ? "success" : "pending",
          error: null,
        });
      }
      return result;
    };
  }

  if (typeof ai.streamText === "function") {
    wrapped.streamText = async (params) => {
      const startedAt = Date.now();
      const result = await ai.streamText(params);
      // Wrap the fullStream so we observe events without consuming them.
      if (result?.fullStream && typeof result.fullStream[Symbol.asyncIterator] === "function") {
        const upstream = result.fullStream;
        result.fullStream = (async function* () {
          /** @type {Map<string, RecordedToolCall>} */
          const inflight = new Map();
          for await (const evt of upstream) {
            if (evt && evt.type === "tool-call") {
              inflight.set(evt.toolCallId, {
                id: evt.toolCallId,
                name: evt.toolName,
                input: evt.args,
                output: null,
                startedAt,
                completedAt: null,
                status: "pending",
                error: null,
              });
            } else if (evt && evt.type === "tool-result") {
              const call = inflight.get(evt.toolCallId);
              if (call) {
                call.output = evt.result;
                call.completedAt = Date.now();
                call.status = "success";
                recorder.record(call);
                inflight.delete(evt.toolCallId);
              }
            }
            yield evt;
          }
          // Flush any tool calls that never received a result.
          for (const c of inflight.values()) recorder.record(c);
        })();
      }
      return result;
    };
  }

  wrapped.agentgit = { recorder };
  return wrapped;
}

function cryptoRandom() {
  return "tc_" + Math.random().toString(36).slice(2, 10);
}
