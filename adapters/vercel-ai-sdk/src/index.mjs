// Vercel AI SDK adapter for AgentGit.
//
// The Vercel AI SDK exposes top-level helpers `generateText({...})` and
// `streamText({...})`. Both can return tool invocations via either:
//   * `result.toolCalls` (sync, after generateText resolves), or
//   * the async-iterable `result.fullStream` of `{ type, toolCallId, ... }`
//     events emitted by streamText.
//
// `wrapAI(ai, { recorder })` returns a façade that has the same surface but
// records each tool invocation as a commit-worthy ToolCall and (new) each
// generateText/streamText as an LlmCall via recorder.recordLlm.

import { estimateCost } from "./pricing.mjs";

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

/**
 * @typedef {Object} RecordedLlmCall
 * @property {string} id
 * @property {string} provider  // "vercel-ai-sdk"
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
 * Wrap a Vercel AI SDK module-like object. We accept `{ generateText, streamText }`
 * shape and return a façade with the same shape, instrumented to record.
 *
 * @template T
 * @param {T & { generateText?: Function, streamText?: Function }} ai
 * @param {{ recorder?: { record: (c: RecordedToolCall) => void, recordLlm?: (c: RecordedLlmCall) => void } }} [options]
 */
export function wrapAI(ai, options = {}) {
  const recorder = options.recorder ?? inMemoryRecorder();
  const wrapped = { ...ai };

  if (typeof ai.generateText === "function") {
    wrapped.generateText = async (params) => {
      const startedAt = Date.now();
      let result;
      try {
        result = await ai.generateText(params);
      } catch (err) {
        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        const model = params?.model?.modelId ?? "unknown";
        recorder.recordLlm?.({
          id: llmId(),
          provider: "vercel-ai-sdk",
          model,
          messages: normalizeMessages(params),
          response: "",
          usage: null,
          costEstimateUsd: null,
          startedAt,
          completedAt,
          durationMs,
          status: "error",
          error: String(err),
        });
        throw err;
      }

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

      // Record LlmCall (tool calls and LLM record are independent).
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const model = result?.response?.modelId ?? params?.model?.modelId ?? "unknown";
      const rawUsage = result?.usage;
      const usage = rawUsage
        ? {
            promptTokens: rawUsage.promptTokens ?? rawUsage.inputTokens ?? 0,
            completionTokens: rawUsage.completionTokens ?? rawUsage.outputTokens ?? 0,
            totalTokens: rawUsage.totalTokens ?? ( (rawUsage.promptTokens ?? 0) + (rawUsage.completionTokens ?? 0) ),
          }
        : null;
      const costEstimateUsd = estimateCost(model, usage);
      recorder.recordLlm?.({
        id: llmId(),
        provider: "vercel-ai-sdk",
        model,
        messages: normalizeMessages(params),
        response: result?.text ?? "",
        usage,
        costEstimateUsd,
        startedAt,
        completedAt,
        durationMs,
        status: "success",
        error: null,
      });

      return result;
    };
  }

  if (typeof ai.streamText === "function") {
    wrapped.streamText = async (params) => {
      const startedAt = Date.now();
      /** @type {{ response: string, usage: any, model: string|null, finishReason: string|null }} */
      const llmAccum = { response: "", usage: null, model: null, finishReason: null };
      let result;
      try {
        result = await ai.streamText(params);
      } catch (err) {
        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        const model = params?.model?.modelId ?? "unknown";
        recorder.recordLlm?.({
          id: llmId(),
          provider: "vercel-ai-sdk",
          model,
          messages: normalizeMessages(params),
          response: "",
          usage: null,
          costEstimateUsd: null,
          startedAt,
          completedAt,
          durationMs,
          status: "error",
          error: String(err),
        });
        throw err;
      }

      // Wrap the fullStream so we observe events without consuming them.
      if (result?.fullStream && typeof result.fullStream[Symbol.asyncIterator] === "function") {
        const upstream = result.fullStream;
        result.fullStream = (async function* () {
          /** @type {Map<string, RecordedToolCall>} */
          const inflight = new Map();
          try {
            for await (const evt of upstream) {
              if (evt && evt.type === "text-delta") {
                llmAccum.response += evt.textDelta ?? evt.text ?? "";
              } else if (evt && evt.type === "finish") {
                if (evt.usage) llmAccum.usage = evt.usage;
                if (evt.finishReason) llmAccum.finishReason = evt.finishReason;
                if (evt.modelId) llmAccum.model = evt.modelId;
              } else if (evt && evt.type === "tool-call") {
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
          } catch (streamErr) {
            // Stream errored mid-iteration: record what we have as error LlmCall, rethrow.
            const completedAt = Date.now();
            const durationMs = completedAt - startedAt;
            const model = llmAccum.model ?? params?.model?.modelId ?? "unknown";
            const usage = normalizeUsage(llmAccum.usage);
            recorder.recordLlm?.({
              id: llmId(),
              provider: "vercel-ai-sdk",
              model,
              messages: normalizeMessages(params),
              response: llmAccum.response,
              usage,
              costEstimateUsd: estimateCost(model, usage),
              startedAt,
              completedAt,
              durationMs,
              status: "error",
              error: String(streamErr),
            });
            // Flush any remaining tools (best effort)
            for (const c of inflight.values()) recorder.record(c);
            throw streamErr;
          }

          // Flush any tool calls that never received a result.
          for (const c of inflight.values()) recorder.record(c);

          // After upstream stream completes, await deferred usage/response promises if present.
          let finalUsage = llmAccum.usage;
          try {
            if (!finalUsage && result && typeof result.usage?.then === "function") {
              finalUsage = await result.usage;
            }
            if (result && typeof result.response?.then === "function") {
              const resp = await result.response;
              if (resp?.modelId && !llmAccum.model) llmAccum.model = resp.modelId;
            }
          } catch {
            // ignore promise rejections for usage; use what we have
          }
          if (finalUsage && !llmAccum.usage) llmAccum.usage = finalUsage;

          const completedAt = Date.now();
          const durationMs = completedAt - startedAt;
          const model = llmAccum.model ?? result?.response?.modelId ?? params?.model?.modelId ?? "unknown";
          const usage = normalizeUsage(llmAccum.usage);
          recorder.recordLlm?.({
            id: llmId(),
            provider: "vercel-ai-sdk",
            model,
            messages: normalizeMessages(params),
            response: llmAccum.response,
            usage,
            costEstimateUsd: estimateCost(model, usage),
            startedAt,
            completedAt,
            durationMs,
            status: "success",
            error: null,
          });
        })();
      } else {
        // No fullStream (uncommon); still attempt to capture via result promises for completeness.
        // We schedule a microtask to await and record so caller can still use result.usage.
        Promise.resolve().then(async () => {
          try {
            let u = null;
            if (result && typeof result.usage?.then === "function") u = await result.usage;
            else if (result?.usage) u = result.usage;
            let m = result?.response?.modelId ?? params?.model?.modelId ?? "unknown";
            if (result && typeof result.response?.then === "function") {
              const r = await result.response;
              if (r?.modelId) m = r.modelId;
            }
            const completedAt = Date.now();
            const durationMs = completedAt - startedAt;
            const usage = normalizeUsage(u);
            recorder.recordLlm?.({
              id: llmId(),
              provider: "vercel-ai-sdk",
              model: m,
              messages: normalizeMessages(params),
              response: "",
              usage,
              costEstimateUsd: estimateCost(m, usage),
              startedAt,
              completedAt,
              durationMs,
              status: "success",
              error: null,
            });
          } catch {
            // swallow
          }
        });
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

function llmId() {
  return "llm_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Normalize Vercel generateText/streamText params into LlmMessage[].
 * Handles { messages: [...] } or { prompt, system? } shapes.
 * Content parts (arrays/objects) are collapsed to string for the record.
 */
function normalizeMessages(params) {
  if (!params) return [];
  if (Array.isArray(params.messages)) {
    return params.messages.map((m) => {
      if (!m) return { role: "user", content: "" };
      let role = m.role || "user";
      let content = m.content;
      if (content == null) {
        content = "";
      } else if (typeof content === "string") {
        // ok
      } else if (Array.isArray(content)) {
        content = content
          .map((c) =>
            c && typeof c === "object"
              ? c.text ?? c.content ?? JSON.stringify(c)
              : String(c),
          )
          .join("");
      } else if (typeof content === "object") {
        content = content.text ?? content.content ?? JSON.stringify(content);
      } else {
        content = String(content);
      }
      return { role, content: String(content) };
    });
  }
  // Fallback: treat prompt as user message (optionally with system)
  const msgs = [];
  if (params.system != null) {
    msgs.push({ role: "system", content: String(params.system) });
  }
  if (params.prompt != null) {
    msgs.push({ role: "user", content: String(params.prompt) });
  }
  return msgs;
}

/**
 * Normalize usage shape from Vercel result (supports prompt/completion or input/output variants).
 */
function normalizeUsage(u) {
  if (!u) return null;
  const promptTokens = Number(u.promptTokens ?? u.inputTokens ?? 0);
  const completionTokens = Number(u.completionTokens ?? u.outputTokens ?? 0);
  const totalTokens = Number(
    u.totalTokens ?? (promptTokens + completionTokens),
  );
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}
