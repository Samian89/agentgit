import { randomUUID } from "node:crypto";
import type { Guard, Hash, LlmCallInput, ToolCall, ToolCallStatus } from "@agentgit/core";
import {
  GuardRegistry,
  Repository,
  buildDefaultGuards,
  loadConfig,
} from "@agentgit/core";
import type { AgentLike, WrapOptions, WrappedAgent } from "./types.js";

/**
 * Properties that are part of the JavaScript object protocol and must not be
 * treated as tool calls, even if they are functions.
 */
const PASS_THROUGH_PROPS = new Set([
  "constructor",
  "toString",
  "valueOf",
  "toJSON",
  "toLocaleString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  // Prevents the proxy itself from being mistakenly awaited as a Promise.
  "then",
]);

/**
 * Wrap any object that exposes a `run(prompt)` method so that every tool call
 * is intercepted, guarded, and recorded as a content-addressed commit.
 *
 * How interception works:
 *   A Proxy traps all property access on the agent.  When `run` is invoked,
 *   the prompt is committed first and then `run` is called with `this` bound to
 *   the proxy — so any internal `this.toolMethod()` calls are also intercepted.
 *   Every other function property is treated as a tool call: guards run, the
 *   real function executes, and the result is recorded as a commit.
 */
export function wrapAgentJS<T extends AgentLike>(
  agent: T,
  options?: WrapOptions,
): WrappedAgent<T> {
  const repoDir = options?.repoDir ?? ".agentgit";
  const repo = Repository.init(repoDir);
  const session = repo.createSession(
    options?.sessionName ?? "session",
    options?.sessionMetadata ?? {},
  );

  // Resolve the guard chain.
  //   undefined → default-on: ConfirmationGuard + SnapshotGuard, tuned by config.
  //   false     → explicit opt-out: no guards run.
  //   Guard[]   → full override: exactly the provided array.
  let guards: Guard[];
  if (options?.guards === false) {
    guards = [];
  } else if (Array.isArray(options?.guards)) {
    guards = options.guards;
  } else {
    guards = buildDefaultGuards(loadConfig(repoDir), repo.objects);
  }
  const guardRegistry = new GuardRegistry(guards, repo.reporter);

  let parentHash: Hash | null = null;

  // ---------------------------------------------------------------------------
  // LLM auto-capture wiring (AMC-08064e08 / spec 002).
  // Detects agent.llm (or explicit via WrapOptions.llm) and, if shaped like a
  // supported client, dynamically imports the matching adapter and installs a
  // recorder bridge that turns adapter RecordedLlmCall into core recordLlmCall
  // commits while advancing the session parentHash. Uses dynamic import so the
  // @agentgit/sdk package loads cleanly even when the optional adapter packages
  // are not installed. The setup runs in a fire-and-forget IIFE (await import
  // is inside); wrapAgentJS itself stays synchronous so documented usage
  // `wrapAgentJS(new Agent())` and all existing call sites continue to work
  // without `await`. The first LLM method call (always async) happens after
  // the microtask settles.
  // ---------------------------------------------------------------------------
  const llmOpt = options?.llm;
  if (llmOpt !== false) {
    let candidate: unknown = null;
    let explicitProvider: "anthropic" | "vercel-ai-sdk" | null = null;
    let shouldInject = false;

    if (llmOpt && typeof llmOpt === "object" && "provider" in llmOpt) {
      explicitProvider = (llmOpt as any).provider;
      if ((llmOpt as any).client !== undefined) {
        candidate = (llmOpt as any).client;
        shouldInject = false;
      } else {
        candidate = (agent as any).llm ?? null;
        shouldInject = true;
      }
    } else {
      candidate = (agent as any).llm ?? null;
      shouldInject = true;
    }

    if (candidate) {
      // Fire-and-forget IIFE so that `wrapAgentJS` itself remains synchronous
      // (per spec: "documented usage in the README continues to work without change").
      // The `await import` happens inside; the first real LLM method call
      // (inside the agent's async `run`) will occur after the microtask has settled.
      (async () => {
        try {
          let provider: "anthropic" | "vercel-ai-sdk" | null = explicitProvider;
          if (!provider) {
            const obj = candidate as any;
            const isAnthropic = !!(obj && obj.messages && typeof obj.messages.create === "function");
            const isVercel =
              !!(obj &&
                (typeof obj.generateText === "function" || typeof obj.streamText === "function"));
            if (isAnthropic) provider = "anthropic";
            else if (isVercel) provider = "vercel-ai-sdk";
            else if (process.env.AGENTGIT_DEBUG === "1") {
              console.warn(
                "[agentgit] wrapAgentJS: `agent.llm` present but shape not recognized " +
                  "(expected Anthropic `messages.create` or Vercel AI `generateText`/`streamText`). " +
                  "Install the matching adapter or use { llm: { provider, client } } to force capture."
              );
            }
          }

          if (provider) {
            const bridge = createLlmRecorderBridge(
              repo,
              session.id,
              () => parentHash,
              (h: Hash | null) => {
                parentHash = h;
              }
            );

            if (provider === "anthropic") {
              const anthSpec = "@agentgit/adapter-anthropic-sdk";
              const mod: any = await import(anthSpec);
              if (typeof mod.wrapAnthropic !== "function") throw new Error("wrapAnthropic missing");
              const wrappedLlm = mod.wrapAnthropic(candidate, { recorder: bridge });
              if (shouldInject) {
                (agent as any).llm = wrappedLlm;
              }
            } else if (provider === "vercel-ai-sdk") {
              const vercelSpec = "@agentgit/adapter-vercel-ai-sdk";
              const mod: any = await import(vercelSpec);
              if (typeof mod.wrapAI !== "function") throw new Error("wrapAI missing");
              const wrappedLlm = mod.wrapAI(candidate, { recorder: bridge });
              if (shouldInject) {
                (agent as any).llm = wrappedLlm;
              }
            }
          }
        } catch (err: any) {
          if (process.env.AGENTGIT_DEBUG === "1") {
            console.warn(
              `[agentgit] wrapAgentJS: LLM auto-capture initialization failed ` +
                `(adapter not installed or incompatible). No LlmCall commits will be written for this llm. ` +
                String(err?.message || err)
            );
          }
          // Intentionally silent otherwise — wrapAgentJS never throws due to missing optional adapter.
        }
      })();
    }
  }

  const agentgit = {
    get sessionId(): string {
      return session.id;
    },
    repo,
    end(status: Parameters<typeof repo.updateSessionStatus>[1] = "completed"): void {
      repo.updateSessionStatus(session.id, status);
    },
  };

  // Declared with `let` so the `run` interceptor can close over the proxy
  // reference and bind it as `this`, allowing internal tool calls to be caught.
  let proxy: WrappedAgent<T>;

  proxy = new Proxy(agent, {
    get(target, prop, _receiver) {
      if (prop === "agentgit") return agentgit;

      if (typeof prop === "symbol") {
        return Reflect.get(target, prop);
      }

      const value: unknown = Reflect.get(target, prop);

      if (typeof value !== "function") return value;

      if (PASS_THROUGH_PROPS.has(prop)) return value;

      if (prop === "run") {
        return async (prompt: string): Promise<unknown> => {
          const commit = repo.commit({
            sessionId: session.id,
            message: `Prompt: ${prompt.slice(0, 80)}`,
            stateEntries: [{ path: "prompt.txt", content: prompt }],
            parentHash,
          });
          parentHash = commit.hash;
          // Bind the proxy as `this` so internal `this.tool()` calls route
          // back through the trap and are recorded as tool-call commits.
          return (value as (p: string) => Promise<unknown>).call(proxy, prompt);
        };
      }

      // All other functions are intercepted as tool calls.
      return async (...args: unknown[]): Promise<unknown> => {
        const toolCallId = randomUUID();
        const startedAt = Date.now();

        // Represent positional args as { args: [...] }; single plain-object
        // args are spread directly so key names are preserved.
        const firstArg = args[0];
        const input: Record<string, unknown> =
          args.length === 1 &&
          firstArg !== undefined &&
          firstArg !== null &&
          typeof firstArg === "object" &&
          !Array.isArray(firstArg)
            ? (firstArg as Record<string, unknown>)
            : { args };

        const pendingToolCall: ToolCall = {
          id: toolCallId,
          name: prop,
          input,
          output: null,
          startedAt,
          completedAt: null,
          status: "pending",
          error: null,
        };

        const guardResult = await guardRegistry.runGuards(
          pendingToolCall,
          repo.objects,
        );

        if (guardResult.outcome === "block") {
          throw new Error(
            `Tool call '${prop}' blocked by guard: ${guardResult.reason ?? "no reason given"}`,
          );
        }

        let toolOutput: unknown = null;
        let toolStatus: ToolCallStatus = "success";
        let toolError: string | null = null;
        let caughtError: unknown = null;

        try {
          toolOutput = await (
            value as (...a: unknown[]) => Promise<unknown>
          ).apply(target, args);
        } catch (err) {
          caughtError = err;
          toolStatus = "error";
          toolError = String(err);
        }

        const completedAt = Date.now();
        const completedToolCall: ToolCall = {
          id: toolCallId,
          name: prop,
          input,
          output: toolOutput,
          startedAt,
          completedAt,
          status: toolStatus,
          error: toolError,
        };

        const commitInput: {
          sessionId: string;
          message: string;
          stateEntries: never[];
          toolCall: ToolCall;
          parentHash: Hash | null;
          metadata?: Record<string, unknown>;
        } = {
          sessionId: session.id,
          message: `Tool: ${prop}`,
          stateEntries: [],
          toolCall: completedToolCall,
          parentHash,
        };
        if (guardResult.snapshotHash !== undefined) {
          commitInput.metadata = { snapshotHash: guardResult.snapshotHash };
        }

        const c = repo.commit(commitInput);
        parentHash = c.hash;

        if (caughtError !== null) throw caughtError;
        return toolOutput;
      };
    },
  }) as unknown as WrappedAgent<T>;

  return proxy;
}

/**
 * Create a recorder bridge suitable for passing to `wrapAnthropic(client, { recorder })`
 * (or wrapAI) inside the SDK. The returned recorder's `recordLlm` method converts
 * the adapter's RecordedLlmCall into a core LlmCallInput and calls
 * `repo.recordLlmCall`, advancing the session's parentHash so LLM commits are
 * chained with tool-call commits.
 *
 * This is the SDK-side half of the adapter → core wiring added for spec 003.
 * (Full auto-detection of `agent.llm` lives in the sibling spec 002.)
 */
export function createLlmRecorderBridge(
  repo: Repository,
  sessionId: string,
  getParent: () => Hash | null,
  setParent: (h: Hash | null) => void,
) {
  return {
    recordLlm(adapterLlmCall: {
      id?: string;
      provider: string;
      model: string;
      messages: Array<{ role: string; content: string }>;
      response: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
      costEstimateUsd?: number | null;
      startedAt: number;
      completedAt?: number | null;
      durationMs?: number | null;
      status?: "pending" | "success" | "error";
      error?: string | null;
    }) {
      const input: LlmCallInput = {
        sessionId,
        provider: adapterLlmCall.provider,
        model: adapterLlmCall.model,
        messages: adapterLlmCall.messages as any,
        response: adapterLlmCall.response,
        usage: adapterLlmCall.usage ?? null,
        costEstimateUsd: adapterLlmCall.costEstimateUsd ?? null,
        startedAt: adapterLlmCall.startedAt,
        status: adapterLlmCall.status ?? "success",
        error: adapterLlmCall.error ?? null,
        parentHash: getParent(),
        ...(adapterLlmCall.id !== undefined ? { id: adapterLlmCall.id } : {}),
        ...(adapterLlmCall.completedAt !== undefined ? { completedAt: adapterLlmCall.completedAt } : {}),
        ...(adapterLlmCall.durationMs !== undefined ? { durationMs: adapterLlmCall.durationMs } : {}),
      };
      const commit = repo.recordLlmCall(input);
      setParent(commit.hash);
    },
    // ToolCall recording bridge (for symmetry; adapters' record() still works via direct repo.commit in future)
    record(_toolCall: unknown) {
      // Tool calls continue to be handled by the existing proxy path.
      // This no-op keeps the recorder shape compatible if both hooks are used.
    },
  };
}
