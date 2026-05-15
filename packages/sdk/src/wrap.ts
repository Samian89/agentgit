import { randomUUID } from "node:crypto";
import type { Guard, Hash, ToolCall, ToolCallStatus } from "@agentgit/core";
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
