import type { Guard, Repository, SessionStatus } from "@agentgit/core";

export interface AgentLike {
  run(prompt: string): Promise<unknown>;
  [key: string]: unknown;
}

export interface WrapOptions {
  /** Path to the .agentgit directory. Defaults to ".agentgit". */
  repoDir?: string;
  /** Human-readable name for the session. */
  sessionName?: string;
  /** Additional metadata attached to the session record. */
  sessionMetadata?: Record<string, unknown>;
  /** Guards to run before each intercepted tool call. */
  guards?: Guard[];
}

export type WrappedAgent<T extends AgentLike> = T & {
  readonly agentgit: {
    readonly sessionId: string;
    readonly repo: Repository;
    end(status?: SessionStatus): void;
  };
};
