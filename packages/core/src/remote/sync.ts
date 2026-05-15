import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../hash.js";
import type { Repository } from "../repository.js";
import type { Hash, RefType, ToolCall } from "../types.js";
import { RemoteClient, type FetchLike } from "./client.js";
import {
  RemoteProtocolError,
  type RemoteRef,
  type UploadLine,
} from "./protocol.js";

/** Per-remote resumable upload state persisted under `.agentgit/remote-state.json`. */
export interface RemoteUploadState {
  uploadId: string;
  wants: Hash[];
  received: Hash[];
  startedAt: number;
}

export interface RemoteStateFile {
  [remoteName: string]: RemoteUploadState;
}

export interface PushOptions {
  /** Remote name (as configured under `remotes.<name>`). */
  remote: string;
  baseUrl: string;
  token: string;
  /** Session id or branch name to push. Defaults to "sessions/<sessionId>". */
  refName?: string;
  /** Session id to push (used to enumerate commits + objects). */
  sessionId: string;
  /** Inject a custom transport (tests). */
  fetchImpl?: FetchLike;
  /** Roughly the number of objects per upload chunk. */
  chunkSize?: number;
  /** Optional client constructor (tests). */
  client?: RemoteClient;
}

export interface PushResult {
  uploadedObjects: number;
  pushedRef: { name: string; target: Hash };
  uploadId: string;
}

export interface FetchOptions {
  remote: string;
  baseUrl: string;
  token: string;
  /** Ref names to fetch. If omitted, fetches all remote refs. */
  refNames?: string[];
  fetchImpl?: FetchLike;
  client?: RemoteClient;
}

export interface FetchResult {
  fetchedRefs: Array<{ name: string; target: Hash; localName: string }>;
  downloadedObjects: number;
}

export interface PullOptions extends FetchOptions {
  /** Single ref to pull and fast-forward into `sessions/<...>`. */
  refName: string;
}

export interface PullResult extends FetchResult {
  /** The local session/branch ref that was fast-forwarded, with new target. */
  localRef: { name: string; target: Hash };
  /** Whether the pull was a noop (already up to date). */
  upToDate: boolean;
}

const REMOTE_STATE_FILE = "remote-state.json";

function buildClient(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}): RemoteClient {
  const clientOpts: ConstructorParameters<typeof RemoteClient>[0] = {
    baseUrl: opts.baseUrl,
    token: opts.token,
  };
  if (opts.fetchImpl) clientOpts.fetchImpl = opts.fetchImpl;
  return new RemoteClient(clientOpts);
}

function stateFilePath(agentgitDir: string): string {
  return join(agentgitDir, REMOTE_STATE_FILE);
}

function loadRemoteState(agentgitDir: string): RemoteStateFile {
  const path = stateFilePath(agentgitDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RemoteStateFile;
  } catch {
    return {};
  }
}

function saveRemoteState(agentgitDir: string, state: RemoteStateFile): void {
  mkdirSync(agentgitDir, { recursive: true });
  writeFileSync(stateFilePath(agentgitDir), JSON.stringify(state, null, 2), "utf8");
}

function newUploadId(): string {
  // ULID-ish: time + crypto random. UUID v4 is fine too but ULIDs sort.
  const t = Date.now().toString(36);
  const r = Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${t}-${r}`;
}

/**
 * Enumerate every object hash reachable from a session: every commit, its tree,
 * and every blob referenced by every tree.
 */
function reachableObjectsForSession(repo: Repository, sessionId: string): Hash[] {
  const out = new Set<Hash>();
  for (const commit of repo.log(sessionId)) {
    out.add(commit.hash);
    out.add(commit.tree);
    for (const entry of repo.index.getTreeEntries(commit.tree)) {
      out.add(entry.blobHash);
    }
  }
  return [...out];
}

function defaultRefNameForSession(sessionId: string): string {
  return `sessions/${sessionId}`;
}

function remoteRefLocalName(remote: string, refName: string): string {
  // Stored locally as `remotes/<remote>/<refName>` to keep refs/remotes/...
  // distinct from local branches.
  return `remotes/${remote}/${refName}`;
}

/**
 * Push a session to a remote.
 *
 * 1. Enumerate every reachable object for the session.
 * 2. Resume any in-progress Upload-Id from `.agentgit/remote-state.json`.
 * 3. Negotiate `objects/missing` against the server.
 * 4. Upload missing objects in chunks (~`chunkSize` per request).
 * 5. Commit the Upload-Id, then CAS the ref via `refs/update`.
 */
export async function pushSession(
  repo: Repository,
  opts: PushOptions,
): Promise<PushResult> {
  const session = repo.index.getSession(opts.sessionId);
  if (!session) {
    throw new Error(`push: session not found: ${opts.sessionId}`);
  }
  if (!session.head) {
    throw new Error(`push: session ${opts.sessionId} has no commits`);
  }

  const refName = opts.refName ?? defaultRefNameForSession(opts.sessionId);
  const newTarget = session.head;
  const client = opts.client ?? buildClient(opts);

  const reachable = reachableObjectsForSession(repo, opts.sessionId);

  // Resumable state: reuse Upload-Id if it matches this push.
  const state = loadRemoteState(repo.agentgitDir);
  const wantsKey = reachable.slice().sort().join(",");
  const prev = state[opts.remote];
  const prevKey = prev ? prev.wants.slice().sort().join(",") : null;
  const uploadId =
    prev && prevKey === wantsKey ? prev.uploadId : newUploadId();
  const haves =
    prev && prevKey === wantsKey ? prev.received : [];

  // Persist the (possibly fresh) state up front so a crash before the first
  // chunk lands still lets the next push reuse the same Upload-Id.
  state[opts.remote] = {
    uploadId,
    wants: reachable,
    received: haves.slice(),
    startedAt: prev?.startedAt ?? Date.now(),
  };
  saveRemoteState(repo.agentgitDir, state);

  // Find what the server is missing. `haves` lists locally-acknowledged
  // uploads from previous attempts so the server can skip them.
  const missing = await client.negotiateMissing(reachable, haves);

  // Upload in chunks. ChunkSize defaults to 256 objects (~1 MiB for typical
  // blobs).
  const chunkSize = opts.chunkSize ?? 256;
  const receivedSet = new Set<Hash>(haves);
  let uploadedObjects = 0;

  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing
      .slice(i, i + chunkSize)
      // Skip anything already acknowledged from a previous attempt.
      .filter((h) => !receivedSet.has(h));
    if (chunk.length === 0) continue;

    const lines: UploadLine[] = chunk.map((hash) => ({
      hash,
      body: repo.objects.read(hash),
    }));

    const res = await client.uploadObjects(uploadId, lines);
    for (const h of res.received) receivedSet.add(h);
    uploadedObjects += chunk.length;

    // Persist after every successful chunk so a crash leaves us resumable.
    state[opts.remote] = {
      uploadId,
      wants: reachable,
      received: [...receivedSet],
      startedAt: state[opts.remote]!.startedAt,
    };
    saveRemoteState(repo.agentgitDir, state);
  }

  // Finalize the upload, then CAS the ref.
  await client.commitUpload(uploadId);

  // Determine the previous server target so we can CAS atomically.
  const remoteRefs = await client.listRefs();
  const existing = remoteRefs.find((r) => r.name === refName);
  const oldTarget = existing ? existing.target : null;
  // Refuse to overwrite a remote ref that isn't an ancestor of newTarget —
  // we are FF-only on both sides for v1.
  if (existing && existing.target !== newTarget) {
    const localAncestors = new Set(repo.ancestors(newTarget));
    if (!localAncestors.has(existing.target)) {
      throw new Error(
        `push: remote ref ${refName} is not an ancestor of local head (refusing non-fast-forward)`,
      );
    }
  }

  const refType: RefType = refName.startsWith("tags/") ? "tag" : "branch";
  const refUpdate = await client.updateRef(refName, refType, oldTarget, newTarget);
  if (!("ok" in refUpdate) || refUpdate.ok !== true) {
    throw new Error(
      `push: ref update failed (${"error" in refUpdate ? refUpdate.error : "unknown"})`,
    );
  }

  // Update local remote-tracking ref and clear resumable state.
  const localRefName = remoteRefLocalName(opts.remote, refName);
  repo.refs.setRef(localRefName, newTarget);
  repo.index.upsertRef({
    name: localRefName,
    target: newTarget,
    type: refType,
    updatedAt: Date.now(),
  });
  delete state[opts.remote];
  saveRemoteState(repo.agentgitDir, state);

  return {
    uploadedObjects,
    pushedRef: { name: refName, target: newTarget },
    uploadId,
  };
}

/**
 * Fetch one or more refs from a remote and store the objects locally.
 * Updates `refs/remotes/<remote>/<refName>` to the new target. Does NOT
 * touch any local session refs — use {@link pullSession} for that.
 */
export async function fetchRefs(
  repo: Repository,
  opts: FetchOptions,
): Promise<FetchResult> {
  const client = opts.client ?? buildClient(opts);

  const remoteRefs = await client.listRefs();
  const wantedRefs: RemoteRef[] = opts.refNames
    ? remoteRefs.filter((r) => opts.refNames!.includes(r.name))
    : remoteRefs;

  if (opts.refNames) {
    for (const name of opts.refNames) {
      if (!wantedRefs.find((r) => r.name === name)) {
        throw new Error(`fetch: remote ref not found: ${name}`);
      }
    }
  }

  // Determine which objects we need: walk the remote commit graph by
  // downloading commits one batch at a time until every parent and tree
  // is local. We start from each ref target.
  const needed = new Set<Hash>();
  const queue: Hash[] = [];
  for (const r of wantedRefs) {
    if (!repo.objects.has(r.target)) {
      needed.add(r.target);
      queue.push(r.target);
    }
  }

  let downloadedObjects = 0;

  // Iterate: fetch a batch, then enqueue references discovered in the bodies.
  while (queue.length > 0) {
    const batch = queue.splice(0, 256);
    const lines = await client.downloadObjects(batch);
    for (const line of lines) {
      const body = line.body;
      // Write to local store (idempotent — sha256 strips synthetic fields).
      const writtenHash = repo.objects.write(body);
      if (writtenHash !== line.hash) {
        throw new RemoteProtocolError(
          `fetch: object ${line.hash} round-tripped to ${writtenHash}`,
          200,
          "hash-mismatch",
        );
      }
      downloadedObjects += 1;

      // Discover dependencies.
      if (body["type"] === "commit") {
        const tree = body["tree"];
        const parent = body["parent"];
        if (typeof tree === "string" && !repo.objects.has(tree) && !needed.has(tree)) {
          needed.add(tree);
          queue.push(tree);
        }
        if (typeof parent === "string" && !repo.objects.has(parent) && !needed.has(parent)) {
          needed.add(parent);
          queue.push(parent);
        }
      } else if (body["type"] === "tree") {
        const entries = body["entries"];
        if (Array.isArray(entries)) {
          for (const e of entries as Array<{ blobHash?: string }>) {
            if (
              typeof e?.blobHash === "string" &&
              !repo.objects.has(e.blobHash) &&
              !needed.has(e.blobHash)
            ) {
              needed.add(e.blobHash);
              queue.push(e.blobHash);
            }
          }
        }
      }
    }
  }

  // Now re-insert into the SQLite index. We walk commits in topological
  // order (oldest first) so parent FKs are satisfied. We also need a
  // session row, but since the server doesn't ship sessions, we synthesize
  // a placeholder session per unique sessionId we encounter — the user
  // can rename it after fetch.
  const fetched: Array<{ name: string; target: Hash; localName: string }> = [];
  for (const r of wantedRefs) {
    indexCommitChain(repo, r.target);
    const localName = remoteRefLocalName(opts.remote, r.name);
    repo.refs.setRef(localName, r.target);
    repo.index.upsertRef({
      name: localName,
      target: r.target,
      type: r.type,
      updatedAt: Date.now(),
    });
    fetched.push({ name: r.name, target: r.target, localName });
  }

  return {
    fetchedRefs: fetched,
    downloadedObjects,
  };
}

/**
 * Walk a remote commit chain that has been downloaded into the object store
 * and insert any missing rows into the SQLite index. Synthesises a session
 * row when one is referenced by a commit but absent locally.
 */
function indexCommitChain(repo: Repository, head: Hash): void {
  // Topo order: load all commits reachable from head, oldest first.
  const visited = new Set<Hash>();
  const stack: Hash[] = [head];
  const ordered: Array<{ hash: Hash; body: Record<string, unknown> }> = [];
  while (stack.length > 0) {
    const h = stack.pop()!;
    if (visited.has(h)) continue;
    visited.add(h);
    if (repo.index.getCommit(h)) {
      // Already indexed; skip (and don't descend — parent must be indexed too).
      continue;
    }
    if (!repo.objects.has(h)) {
      throw new Error(`fetch: missing object during indexing: ${h}`);
    }
    const body = repo.objects.read(h);
    if (body["type"] !== "commit") continue;
    ordered.push({ hash: h, body });
    const parent = body["parent"];
    if (typeof parent === "string") stack.push(parent);
  }
  ordered.reverse();

  for (const { hash, body } of ordered) {
    const sessionId = body["sessionId"] as string;
    if (!repo.index.getSession(sessionId)) {
      repo.index.insertSession({
        id: sessionId,
        name: `remote/${sessionId.slice(0, 8)}`,
        status: "completed",
        head: null,
        createdAt: typeof body["timestamp"] === "number" ? body["timestamp"] : Date.now(),
        updatedAt: Date.now(),
        metadata: { source: "remote" },
      });
    }

    const treeHash = body["tree"] as string;
    if (!repo.index.getTreeEntries(treeHash).length) {
      const treeBody = repo.objects.read(treeHash);
      const entries = (treeBody["entries"] as Array<{
        path: string;
        blobHash: string;
        size: number;
      }>) ?? [];
      // Insert blobs first.
      for (const e of entries) {
        if (!repo.index.hasBlob(e.blobHash)) {
          const blobBody = repo.objects.read(e.blobHash);
          repo.index.insertBlob({
            hash: e.blobHash,
            type: "blob",
            content: blobBody["content"] as string,
            size: (blobBody["size"] as number) ?? e.size,
            encoding: (blobBody["encoding"] as "utf-8" | "base64") ?? "utf-8",
            mimeType: (blobBody["mimeType"] as string | null) ?? null,
          });
        }
      }
      repo.index.insertTreeEntries(
        treeHash,
        entries.map((e) => ({ path: e.path, blobHash: e.blobHash, size: e.size })),
      );
    }

    // Re-hash to verify what we store matches the wire object.
    const recomputed = sha256(body);
    if (recomputed !== hash) {
      throw new Error(`fetch: commit ${hash} body hashes to ${recomputed}`);
    }

    repo.index.insertCommit({
      hash,
      type: "commit",
      tree: body["tree"] as string,
      parent: (body["parent"] as string | null) ?? null,
      sessionId,
      timestamp: body["timestamp"] as number,
      message: body["message"] as string,
      toolCall: (body["toolCall"] as ToolCall | null) ?? null,
      metadata: (body["metadata"] as Record<string, unknown>) ?? {},
      author: (body["author"] as { name: string; email: string } | null) ?? null,
      signature: null,
      publicKey: null,
    });

    // Update synthesized session head to the newest commit we've indexed.
    repo.index.updateSessionHead(sessionId, hash, Date.now());
  }

}

/**
 * Pull = fetch + fast-forward-only update of the local session ref.
 * Refuses non-fast-forward updates until merge support lands (spec 006).
 */
export async function pullRef(
  repo: Repository,
  opts: PullOptions,
): Promise<PullResult> {
  const fetched = await fetchRefs(repo, opts);
  const ref = fetched.fetchedRefs.find((r) => r.name === opts.refName);
  if (!ref) {
    throw new Error(`pull: remote did not advertise ref ${opts.refName}`);
  }

  // Local session ref convention matches push: sessions/<id> in the local refs/.
  const localRefName = opts.refName;
  const localTarget = repo.refs.getRef(localRefName);

  if (localTarget === ref.target) {
    return {
      ...fetched,
      localRef: { name: localRefName, target: ref.target },
      upToDate: true,
    };
  }

  if (localTarget !== null) {
    // FF check: localTarget must be an ancestor of ref.target.
    const ancestors = new Set(repo.ancestors(ref.target));
    if (!ancestors.has(localTarget)) {
      throw new Error(
        `pull: refusing non-fast-forward update of ${localRefName} (merge support not implemented)`,
      );
    }
  }

  repo.refs.setRef(localRefName, ref.target);
  repo.index.upsertRef({
    name: localRefName,
    target: ref.target,
    type: localRefName.startsWith("tags/") ? "tag" : "branch",
    updatedAt: Date.now(),
  });

  // If this is sessions/<id>, also update the session head row to keep the
  // SQL view consistent with the ref filesystem state.
  if (localRefName.startsWith("sessions/")) {
    const sessionId = localRefName.slice("sessions/".length);
    if (repo.index.getSession(sessionId)) {
      repo.index.updateSessionHead(sessionId, ref.target, Date.now());
    }
  }

  return {
    ...fetched,
    localRef: { name: localRefName, target: ref.target },
    upToDate: false,
  };
}

// Re-export the state file constant for tests.
export { stateFilePath as remoteStateFilePath };
