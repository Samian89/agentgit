import type {
  Commit,
  Guard,
  GuardResult,
  Hash,
  Session,
  SessionStatus,
  StateEntry,
  ToolCall,
} from "@agentgit/core";
import { GuardRegistry, Repository } from "@agentgit/core";

/**
 * Manual session management for recording agent steps without wrapAgentJS.
 * Useful when you need fine-grained control over what gets committed.
 */
export class AgentGitSession {
  private parentHash: Hash | null = null;
  private readonly guardRegistry: GuardRegistry;

  constructor(
    readonly repo: Repository,
    private readonly _session: Session,
    guards: Guard[] = [],
  ) {
    this.guardRegistry = new GuardRegistry(guards);
  }

  /** Create a new session in an existing or freshly initialised repository. */
  static create(
    repoDir: string,
    name: string,
    metadata?: Record<string, unknown>,
    guards?: Guard[],
  ): AgentGitSession {
    const repo = Repository.init(repoDir);
    const session = repo.createSession(name, metadata ?? {});
    return new AgentGitSession(repo, session, guards ?? []);
  }

  get id(): string {
    return this._session.id;
  }

  /** Fetch the live session record from the index (reflects latest head). */
  getSession(): Session {
    return this.repo.getSession(this._session.id) ?? this._session;
  }

  /** Record the incoming prompt as a commit and advance the parent pointer. */
  recordPrompt(prompt: string, stateEntries?: StateEntry[]): Commit {
    const entries: StateEntry[] = stateEntries ?? [
      { path: "prompt.txt", content: prompt },
    ];
    const commit = this.repo.commit({
      sessionId: this._session.id,
      message: `Prompt: ${prompt.slice(0, 80)}`,
      stateEntries: entries,
      parentHash: this.parentHash,
    });
    this.parentHash = commit.hash;
    return commit;
  }

  /** Run registered guards against a tool call. */
  async runGuards(toolCall: ToolCall): Promise<GuardResult> {
    return this.guardRegistry.runGuards(toolCall, this.repo.objects);
  }

  /** Record a completed tool call as a commit and advance the parent pointer. */
  recordToolCall(toolCall: ToolCall, stateEntries?: StateEntry[]): Commit {
    const commit = this.repo.commit({
      sessionId: this._session.id,
      message: `Tool: ${toolCall.name}`,
      stateEntries: stateEntries ?? [],
      toolCall,
      parentHash: this.parentHash,
    });
    this.parentHash = commit.hash;
    return commit;
  }

  /** Mark the session as completed (or another terminal status). */
  end(status: SessionStatus = "completed"): void {
    this.repo.updateSessionStatus(this._session.id, status);
  }
}
