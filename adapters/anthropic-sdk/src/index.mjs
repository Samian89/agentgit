// Anthropic SDK adapter for AgentGit.
//
// The Anthropic SDK returns assistant messages whose `content` is a list of
// blocks. When the model decides to use a tool the response contains one or
// more `{ type: "tool_use", id, name, input }` blocks. The user then echoes
// back a `{ type: "tool_result", tool_use_id, content }` block on the next
// turn.  This adapter wraps `anthropic.messages.create` so each tool_use →
// tool_result pair becomes one AgentGit `ToolCall` commit.
//
// Design notes:
//   * The recorder is injectable so smoke tests can run in-memory without
//     pulling the heavy @agentgit/sdk + better-sqlite3 stack.
//   * `wrapAnthropic(client, { recorder })` returns the same client with a
//     monkey-patched `messages.create` — preserves any other client surface.
//   * Tool calls without a matching tool_result are still committed when the
//     wrapper is `flush()`-ed so partial conversations don't leak.

/**
 * @typedef {Object} ToolUseBlock
 * @property {"tool_use"} type
 * @property {string} id
 * @property {string} name
 * @property {unknown} input
 *
 * @typedef {Object} ToolResultBlock
 * @property {"tool_result"} type
 * @property {string} tool_use_id
 * @property {unknown} content
 *
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

/**
 * Pull all `tool_use` blocks out of an Anthropic message response.
 * @param {{ content?: unknown[] }} message
 * @returns {ToolUseBlock[]}
 */
export function extractToolUses(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter(
    (b) => b && typeof b === "object" && b.type === "tool_use",
  );
}

/**
 * Pull all `tool_result` blocks out of an inbound user message.
 * @param {{ content?: unknown[] }} message
 * @returns {ToolResultBlock[]}
 */
export function extractToolResults(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter(
    (b) => b && typeof b === "object" && b.type === "tool_result",
  );
}

/**
 * Build a recorder backed by a simple in-memory array. Useful for tests and
 * for callers that want to drive their own persistence.
 *
 * @returns {{
 *   record: (call: RecordedToolCall) => void,
 *   calls: RecordedToolCall[]
 * }}
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
 * Wrap an Anthropic client. Each `tool_use` block in a response is buffered
 * with `status: "pending"`; the matching `tool_result` (sent on the next user
 * turn) flips it to `success` and the recorder is invoked.
 *
 * @template T
 * @param {T & { messages: { create: Function } }} client
 * @param {{ recorder?: { record: (c: RecordedToolCall) => void } }} [options]
 * @returns {T & { agentgit: { flush: () => void, pending: Map<string, RecordedToolCall> } }}
 */
export function wrapAnthropic(client, options = {}) {
  const recorder = options.recorder ?? inMemoryRecorder();
  /** @type {Map<string, RecordedToolCall>} */
  const pending = new Map();

  // The patched create() also processes any tool_result blocks the caller
  // included in the *outbound* request — that's how Anthropic's API expects
  // the tool round-trip to look.
  const original = client.messages.create.bind(client.messages);
  client.messages.create = async (params) => {
    if (params && Array.isArray(params.messages)) {
      for (const msg of params.messages) {
        for (const result of extractToolResults(msg)) {
          const call = pending.get(result.tool_use_id);
          if (call) {
            call.output = result.content;
            call.status = "success";
            call.completedAt = Date.now();
            recorder.record(call);
            pending.delete(result.tool_use_id);
          }
        }
      }
    }
    const response = await original(params);
    for (const block of extractToolUses(response)) {
      pending.set(block.id, {
        id: block.id,
        name: block.name,
        input: block.input,
        output: null,
        startedAt: Date.now(),
        completedAt: null,
        status: "pending",
        error: null,
      });
    }
    return response;
  };

  client.agentgit = {
    pending,
    /** Commit any in-flight calls as `pending` so they aren't silently lost. */
    flush() {
      for (const call of pending.values()) recorder.record(call);
      pending.clear();
    },
  };
  return client;
}
