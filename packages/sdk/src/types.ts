import type { Guard, Repository, SessionStatus } from "@agentgit/core";

export interface AgentLike {
  run(prompt: string): Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Options controlling LLM call auto-capture via wrapAgentJS.
 */
export type LlmAutoCaptureOptions =
  | false
  | {
      /** Which adapter to use for wrapping the LLM client. */
      provider: "anthropic" | "vercel-ai-sdk";
      /** Explicit client/module to wrap (if omitted, falls back to `agent.llm` if present). */
      client?: unknown;
    };

export interface WrapOptions {
  /** Path to the .agentgit directory. Defaults to ".agentgit". */
  repoDir?: string;
  /** Human-readable name for the session. */
  sessionName?: string;
  /** Additional metadata attached to the session record. */
  sessionMetadata?: Record<string, unknown>;
  /**
   * Guards to run before each intercepted tool call.
   *
   * - `undefined` (default): apply the default `ConfirmationGuard` +
   *   `SnapshotGuard` configured from `.agentgit/config.json`.
   * - `false`: explicit opt-out — no guards run.
   * - `Guard[]`: full override — exactly these guards run.
   */
  guards?: Guard[] | false;
  /**
   * LLM auto-capture options for `agent.llm` (or explicit client).
   *
   * - `undefined` (default): auto-detect `agent.llm` if present and shaped like
   *   an Anthropic client (`messages.create`) or Vercel AI module (`generateText`/`streamText`).
   * - `false`: disable auto-capture even if `agent.llm` exists.
   * - `{ provider, client? }`: force a specific adapter and (optionally) wrap the given client
   *   instead of (or in addition to) `agent.llm`. Useful for module-level singletons.
   */
  llm?: LlmAutoCaptureOptions;
}

export type WrappedAgent<T extends AgentLike> = T & {
  readonly agentgit: {
    readonly sessionId: string;
    readonly repo: Repository;
    end(status?: SessionStatus): void;
  };
};
