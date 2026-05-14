import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { ObjectStore } from "./object-store.js";
import { CommitGraph } from "./commit-graph.js";
import { RefStore } from "./ref-store.js";
import { SqliteIndex } from "./sqlite-index.js";
import { loadConfig, resolveAuthor } from "./config.js";
import { signMessage, verifyMessage } from "./signing.js";
import type {
  Author,
  Blob,
  Commit,
  DiffEntry,
  Hash,
  Session,
  SessionStatus,
  StepDiff,
  ToolCall,
  Tree,
  TreeEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

export interface StateEntry {
  /** Logical path within the agent state namespace (e.g. "files/main.py"). */
  path: string;
  /** Text or base64 content. */
  content: string;
  /** Storage encoding. Defaults to "utf-8". */
  encoding?: "base64" | "utf-8";
  /** MIME type hint. */
  mimeType?: string | null;
}

export interface CommitInput {
  sessionId: string;
  message: string;
  /** State snapshot entries; empty array records an empty tree. */
  stateEntries?: StateEntry[];
  /** Tool call that produced this commit. */
  toolCall?: ToolCall | null;
  /** Arbitrary commit metadata. */
  metadata?: Record<string, unknown>;
  /** Explicit parent hash. If omitted, the session's current head is used. */
  parentHash?: Hash | null;
  /**
   * Override committer identity. When omitted, the identity from
   * .agentgit/config.json is used (or null if no identity is configured).
   */
  author?: Author | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Unified entry point orchestrating ObjectStore, CommitGraph, RefStore, and
 * SqliteIndex. All four collaborate to give a complete, tamper-evident audit
 * trail for an agent session.
 */
export class Repository {
  private constructor(
    readonly agentgitDir: string,
    readonly objects: ObjectStore,
    readonly refs: RefStore,
    readonly index: SqliteIndex,
    readonly graph: CommitGraph,
  ) {}

  /**
   * Initialise a new .agentgit/ directory at agentgitDir.
   * Safe to call on an existing store — all operations are idempotent.
   */
  static init(agentgitDir: string): Repository {
    mkdirSync(join(agentgitDir, "objects"), { recursive: true });
    mkdirSync(join(agentgitDir, "refs"), { recursive: true });
    const objects = new ObjectStore(join(agentgitDir, "objects"));
    const refs = new RefStore(agentgitDir);
    const index = new SqliteIndex(join(agentgitDir, "index.db"));
    const graph = new CommitGraph(objects);
    return new Repository(agentgitDir, objects, refs, index, graph);
  }

  /** Open an existing repository without reinitialising it. */
  static open(agentgitDir: string): Repository {
    return Repository.init(agentgitDir);
  }

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  /** Create a new session and persist it to the index. */
  createSession(
    name: string,
    metadata: Record<string, unknown> = {},
  ): Session {
    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      name,
      status: "active",
      head: null,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.index.insertSession(session);
    return session;
  }

  getSession(id: string): Session | null {
    return this.index.getSession(id);
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.index.updateSessionStatus(id, status, Date.now());
  }

  // --------------------------------------------------------------------------
  // Commits
  // --------------------------------------------------------------------------

  /**
   * Record a new commit.
   * 1. Writes blob objects for each state entry.
   * 2. Writes the tree object.
   * 3. Writes the commit object.
   * 4. Persists blobs, tree entries, commit, and session head update atomically
   *    in a single SQLite transaction.
   *
   * Returns the complete Commit (with hash attached).
   */
  commit(input: CommitInput): Commit {
    const {
      sessionId,
      message,
      stateEntries = [],
      toolCall = null,
      metadata = {},
    } = input;

    const now = Date.now();

    // Resolve parent
    const parentHash: Hash | null =
      "parentHash" in input
        ? (input.parentHash ?? null)
        : (this.index.getSession(sessionId)?.head ?? null);

    // Resolve author + signing context from config (unless input overrides author).
    const config = loadConfig(this.agentgitDir);
    const author: Author | null =
      "author" in input ? (input.author ?? null) : resolveAuthor(config);
    const signing = config.signing;
    const shouldSign =
      signing?.enabled !== false &&
      typeof signing?.privateKey === "string" &&
      typeof signing?.publicKey === "string";

    // Build blobs and tree entries
    const blobs: Blob[] = [];
    const treeEntries: TreeEntry[] = [];

    for (const entry of stateEntries) {
      const encoding = entry.encoding ?? "utf-8";
      const rawBytes = Buffer.from(entry.content, encoding);
      const size = rawBytes.length;
      const mimeType = entry.mimeType ?? null;

      const blobBody: Omit<Blob, "hash"> = {
        type: "blob",
        content: entry.content,
        size,
        encoding,
        mimeType,
      };
      const blobHash = this.objects.write(blobBody as Record<string, unknown>);
      blobs.push({ hash: blobHash, ...blobBody });
      treeEntries.push({ path: entry.path, blobHash, size });
    }

    // Build and write tree
    const treeBody: Omit<Tree, "hash"> = {
      type: "tree",
      entries: treeEntries,
    };
    const treeHash = this.objects.write(treeBody as Record<string, unknown>);

    // Build and write commit
    const commitBody: Omit<Commit, "hash" | "signature" | "publicKey"> = {
      type: "commit",
      tree: treeHash,
      parent: parentHash,
      sessionId,
      timestamp: now,
      message,
      toolCall,
      metadata,
      author,
    };
    const commitHash = this.objects.write(commitBody as Record<string, unknown>);

    let signature: string | null = null;
    let publicKey: string | null = null;
    if (shouldSign) {
      signature = signMessage(commitHash, signing!.privateKey!);
      publicKey = signing!.publicKey!;
    }

    const fullCommit: Commit = {
      hash: commitHash,
      ...commitBody,
      signature,
      publicKey,
    };

    // Persist to SQLite atomically
    this.index.transaction(() => {
      for (const blob of blobs) {
        this.index.insertBlob(blob);
      }
      this.index.insertTreeEntries(treeHash, treeEntries);
      this.index.insertCommit(fullCommit);
      this.index.updateSessionHead(sessionId, commitHash, now);
    });

    return fullCommit;
  }

  // --------------------------------------------------------------------------
  // Log
  // --------------------------------------------------------------------------

  /** Return all commits for sessionId in ascending timestamp order. */
  log(sessionId: string): Commit[] {
    return this.index.getCommitsBySession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Ancestor traversal
  // --------------------------------------------------------------------------

  /** Walk parent links from hash; returns hashes newest-first. */
  ancestors(hash: Hash): Hash[] {
    return this.graph.ancestors(hash);
  }

  // --------------------------------------------------------------------------
  // Diff
  // --------------------------------------------------------------------------

  /**
   * Compute a step-level diff between two commits.
   * Reads tree entries from the SQLite index for performance.
   */
  diff(fromHash: Hash, toHash: Hash): StepDiff {
    const fromCommit = this.index.getCommit(fromHash);
    const toCommit = this.index.getCommit(toHash);

    const fromEntries: Map<string, TreeEntry> = new Map(
      (fromCommit ? this.index.getTreeEntries(fromCommit.tree) : []).map((e) => [
        e.path,
        e,
      ]),
    );
    const toEntries: Map<string, TreeEntry> = new Map(
      (toCommit ? this.index.getTreeEntries(toCommit.tree) : []).map((e) => [
        e.path,
        e,
      ]),
    );

    const added: DiffEntry[] = [];
    const removed: DiffEntry[] = [];
    const modified: DiffEntry[] = [];

    for (const [path, toEntry] of toEntries) {
      const fromEntry = fromEntries.get(path);
      if (!fromEntry) {
        added.push({ path, fromHash: null, toHash: toEntry.blobHash, sizeDelta: toEntry.size });
      } else if (fromEntry.blobHash !== toEntry.blobHash) {
        modified.push({
          path,
          fromHash: fromEntry.blobHash,
          toHash: toEntry.blobHash,
          sizeDelta: toEntry.size - fromEntry.size,
        });
      }
    }

    for (const [path, fromEntry] of fromEntries) {
      if (!toEntries.has(path)) {
        removed.push({
          path,
          fromHash: fromEntry.blobHash,
          toHash: null,
          sizeDelta: -fromEntry.size,
        });
      }
    }

    return { fromHash, toHash, added, removed, modified };
  }

  // --------------------------------------------------------------------------
  // Refs (convenience wrappers)
  // --------------------------------------------------------------------------

  /** Create or update a named branch ref pointing to commitHash. */
  createBranch(name: string, commitHash: Hash): void {
    this.refs.setRef(`sessions/${name}`, commitHash);
    this.index.upsertRef({
      name: `sessions/${name}`,
      target: commitHash,
      type: "branch",
      updatedAt: Date.now(),
    });
  }

  /** Read a branch ref; returns null if not found. */
  getBranch(name: string): Hash | null {
    return this.refs.getRef(`sessions/${name}`);
  }

  /** Compute the SHA-256 hash for an arbitrary object (exposed for testing). */
  static hashObject(obj: Record<string, unknown>): Hash {
    return sha256(obj);
  }

  // --------------------------------------------------------------------------
  // Signature verification
  // --------------------------------------------------------------------------

  /**
   * Verify a commit's Ed25519 signature and content hash.
   *
   * Returns:
   *   - `unsigned`   — commit exists but has no signature attached.
   *   - `not-found`  — no commit with that hash is recorded.
   *   - `tampered`   — the stored object's hash doesn't match its content
   *                    (object body was modified after writing).
   *   - `invalid`    — signature does not verify against the public key.
   *   - `valid`      — content hash matches AND signature verifies.
   */
  verifyCommit(hash: Hash): {
    status: "valid" | "invalid" | "tampered" | "unsigned" | "not-found";
    commit: Commit | null;
  } {
    const commit = this.index.getCommit(hash);
    if (!commit) return { status: "not-found", commit: null };

    // Re-hash the commit from SQLite data to detect row-level tampering.
    // sha256 strips hash/signature/publicKey before hashing, so this checks
    // all content fields (message, author, toolCall, metadata, …).
    const recomputedFromIndex = sha256(commit as unknown as Record<string, unknown>);
    if (recomputedFromIndex !== hash) return { status: "tampered", commit };

    // Also verify the object-store file to detect file-level tampering.
    if (!this.objects.has(hash)) return { status: "tampered", commit };
    const objectBody = this.objects.read(hash);
    const recomputedFromStore = sha256(objectBody);
    if (recomputedFromStore !== hash) return { status: "tampered", commit };

    if (!commit.signature || !commit.publicKey) {
      return { status: "unsigned", commit };
    }
    const ok = verifyMessage(hash, commit.signature, commit.publicKey);
    return { status: ok ? "valid" : "invalid", commit };
  }
}
