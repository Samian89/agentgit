// Anthropic SDK adapter for AgentGit.
//
// The Anthropic SDK returns assistant messages whose `content` is a list of
// blocks. When the model decides to use a tool the response contains one or
// more `{ type: "tool_use", id, name, input }` blocks. The user then echoes
// back a `{ type: "tool_result", tool_use_id, content }` block on the next
// turn.  This adapter wraps `anthropic.messages.create` so each tool_use →
// tool_result pair becomes one AgentGit `ToolCall` commit.
//
// In addition, every `messages.create` call now emits exactly one `LlmCall`
// (provider "anthropic") via the optional `recorder.recordLlm` hook, carrying
// the normalized prompt messages, joined text response, usage, duration, and
// costEstimateUsd (via the pricing helper). Tool-call and LLM recordings are
// independent; both may fire for the same create() invocation.
//
// Design notes:
//   * The recorder is injectable so smoke tests can run in-memory without
//     pulling the heavy @agentgit/sdk + better-sqlite3 stack.
//   * `wrapAnthropic(client, { recorder })` returns the same client with a
//     monkey-patched `messages.create` — preserves any other client surface.
//   * Tool calls without a matching tool_result are still committed when the
//     wrapper is `flush()`-ed so partial conversations don't leak.
//   * If the supplied recorder has no `recordLlm`, LLM events are silently ignored
//     (backward compatible with pre-LlmCall recorders).
import { randomUUID } from "node:crypto";
import { estimateCost } from "./pricing.mjs";

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
 * @typedef {Object} RecordedLlmCall
 * @property {string} id
 * @property {string} provider  // "anthropic"
 * @property {string} model
 * @property {Array<{role:string,content:string}>} messages
 * @property {string} response
 * @property {{promptTokens:number, completionTokens:number, totalTokens:number}|null} usage
 * @property {number|null} costEstimateUsd
 * @property {number} startedAt
 * @property {number|null} completedAt
 * @property {number|null} durationMs
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
 * The recorder supports two independent hooks:
 *   - record(toolCall) — existing ToolCall protocol (unchanged)
 *   - recordLlm(llmCall) — new LlmCall protocol (added by this ticket)
 *
 * Callers may implement only one; the wrapper uses typeof checks.
 *
 * @returns {{
 *   calls: RecordedToolCall[],
 *   llmCalls: RecordedLlmCall[],
 *   record: (call: RecordedToolCall) => void,
 *   recordLlm: (call: RecordedLlmCall) => void
 * }}
 */
export function inMemoryRecorder() {
  const calls = [];
  const llmCalls = [];
  return {
    calls,
    llmCalls,
    record(call) {
      calls.push(call);
    },
    recordLlm(call) {
      llmCalls.push(call);
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
 * @param {{ recorder?: { record?: (c: RecordedToolCall) => void, recordLlm?: (c: RecordedLlmCall) => void } }} [options]
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

  /**
   * Normalize Anthropic messages (which may have content as string or array
   * of blocks) into the canonical LlmMessage[] shape with string content.
   * Non-text blocks (tool_use, tool_result) are represented as markers so the
   * prompt history is preserved in the LlmCall record.
   * @param {unknown} rawMessages
   * @returns {Array<{role:string, content:string}>}
   */
  function normalizeMessages(rawMessages) {
    if (!Array.isArray(rawMessages)) return [];
    return rawMessages.map((m) => {
      const role = m && typeof m.role === "string" ? m.role : "user";
      let content = m ? m.content : "";
      if (typeof content === "string") {
        return { role, content };
      }
      if (Array.isArray(content)) {
        const parts = content.map((b) => {
          if (b && typeof b === "object") {
            if (b.type === "text") return b.text ?? "";
            if (b.type === "tool_use") return `[tool_use:${b.name || "unknown"}]`;
            if (b.type === "tool_result") return `[tool_result:${b.tool_use_id || "unknown"}]`;
            return JSON.stringify(b);
          }
          return String(b);
        });
        return { role, content: parts.join("\n") };
      }
      return { role, content: String(content ?? "") };
    });
  }

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

    const startedAt = Date.now();
    let response;
    try {
      response = await original(params);
    } catch (err) {
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const model = params && typeof params.model === "string" ? params.model : "unknown";
      const messages = normalizeMessages(params && params.messages);
      const errorCall = {
        id: randomUUID(),
        provider: "anthropic",
        model,
        messages,
        response: "",
        usage: null,
        costEstimateUsd: null,
        startedAt,
        completedAt,
        durationMs,
        status: "error",
        error: String(err),
      };
      if (typeof recorder.recordLlm === "function") {
        recorder.recordLlm(errorCall);
      }
      throw err;
    }

    // Success path: emit exactly one LlmCall for this messages.create
    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const model =
      response && typeof response.model === "string"
        ? response.model
        : params && typeof params.model === "string"
          ? params.model
          : "unknown";
    const text = response && Array.isArray(response.content)
      ? response.content
          .filter((b) => b && typeof b === "object" && b.type === "text")
          .map((b) => (b.text ?? ""))
          .join("\n")
      : "";
    const rawUsage = response && response.usage ? response.usage : null;
    const usage = rawUsage
      ? {
          promptTokens: Number(rawUsage.input_tokens) || 0,
          completionTokens: Number(rawUsage.output_tokens) || 0,
          totalTokens:
            (Number(rawUsage.input_tokens) || 0) + (Number(rawUsage.output_tokens) || 0),
        }
      : null;
    const messages = normalizeMessages(params && params.messages);
    const llmCall = {
      id: randomUUID(),
      provider: "anthropic",
      model,
      messages,
      response: text,
      usage,
      costEstimateUsd: estimateCost(model, usage),
      startedAt,
      completedAt,
      durationMs,
      status: "success",
      error: null,
    };
    if (typeof recorder.recordLlm === "function") {
      recorder.recordLlm(llmCall);
    }

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
