import type {
  BlameEntry,
  CommitRow,
  DiffResult,
  SessionRow,
} from "@agentgit/ui-components";
import type {
  BundleContents,
} from "./bundle/unpack.js";
import type {
  Commit,
  Session,
  TreeEntry,
} from "./bundle/types.js";

/**
 * Read-only adapter that reshapes a parsed bundle into the same `*_Row`
 * shape the existing Tauri IPC layer returns, so the StepCard / DiffView /
 * BlameView / TimelineScrollbar components can render it unchanged.
 */
export class InMemoryIndex {
  private readonly sessions: Map<string, Session>;
  private readonly commits: Map<string, Commit>;
  private readonly commitsBySession: Map<string, Commit[]>;
  private readonly treeEntries: Map<string, TreeEntry[]>;

  constructor(private readonly bundle: BundleContents) {
    this.sessions = new Map(bundle.sessions.map((s) => [s.id, s]));
    this.commits = new Map(bundle.commits.map((c) => [c.hash, c]));

    const grouped = new Map<string, Commit[]>();
    for (const c of bundle.commits) {
      const arr = grouped.get(c.sessionId) ?? [];
      arr.push(c);
      grouped.set(c.sessionId, arr);
    }
    for (const arr of grouped.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
    this.commitsBySession = grouped;

    const trees = new Map<string, TreeEntry[]>();
    for (const [hash, body] of bundle.objects) {
      if (body["type"] === "tree" && Array.isArray(body["entries"])) {
        trees.set(hash, body["entries"] as TreeEntry[]);
      }
    }
    this.treeEntries = trees;
  }

  generator(): string {
    return this.bundle.manifest.generator;
  }

  getSessions(): SessionRow[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toSessionRow);
  }

  getCommits(sessionId: string): CommitRow[] {
    return (this.commitsBySession.get(sessionId) ?? []).map(toCommitRow);
  }

  getDiff(hash1: string, hash2: string): DiffResult {
    const c1 = this.commits.get(hash1);
    const c2 = this.commits.get(hash2);
    const t1 = c1 ? this.treeEntries.get(c1.tree) ?? [] : [];
    const t2 = c2 ? this.treeEntries.get(c2.tree) ?? [] : [];

    const map1 = new Map(t1.map((e) => [e.path, e]));
    const map2 = new Map(t2.map((e) => [e.path, e]));
    const added = [];
    const removed = [];
    const modified = [];

    for (const [path, e2] of map2) {
      const e1 = map1.get(path);
      if (!e1) added.push({ path, from_hash: null, to_hash: e2.blobHash });
      else if (e1.blobHash !== e2.blobHash)
        modified.push({ path, from_hash: e1.blobHash, to_hash: e2.blobHash });
    }
    for (const [path, e1] of map1) {
      if (!map2.has(path))
        removed.push({ path, from_hash: e1.blobHash, to_hash: null });
    }
    return {
      hash1,
      hash2,
      commit1_tool_call: c1?.toolCall ? JSON.stringify(c1.toolCall) : null,
      commit2_tool_call: c2?.toolCall ? JSON.stringify(c2.toolCall) : null,
      added,
      removed,
      modified,
    };
  }

  /**
   * Last-touched-by-path summary: for every path in any commit's tree, pick
   * the latest commit whose tree contains that path. Matches the Tauri
   * `get_blame` IPC shape.
   */
  getBlame(sessionId: string): BlameEntry[] {
    const commits = this.commitsBySession.get(sessionId) ?? [];
    const lastTouch = new Map<string, Commit>();
    for (const c of commits) {
      const entries = this.treeEntries.get(c.tree) ?? [];
      for (const e of entries) {
        const prev = lastTouch.get(e.path);
        const prevEntries = prev ? this.treeEntries.get(prev.tree) ?? [] : [];
        const prevEntry = prevEntries.find((pe) => pe.path === e.path);
        if (!prev || !prevEntry || prevEntry.blobHash !== e.blobHash) {
          lastTouch.set(e.path, c);
        }
      }
    }
    return [...lastTouch.entries()]
      .map(([path, c]) => ({
        path,
        commit_hash: c.hash,
        timestamp: c.timestamp,
        message: c.message,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

function toSessionRow(s: Session): SessionRow {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    head: s.head,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    metadata: JSON.stringify(s.metadata ?? {}),
  };
}

function toCommitRow(c: Commit): CommitRow {
  return {
    hash: c.hash,
    tree: c.tree,
    parent: c.parent,
    session_id: c.sessionId,
    timestamp: c.timestamp,
    message: c.message,
    tool_call: c.toolCall ? JSON.stringify(c.toolCall) : null,
    llm_call: c.llmCall ? JSON.stringify(c.llmCall) : null,
    metadata: JSON.stringify(c.metadata ?? {}),
  };
}
