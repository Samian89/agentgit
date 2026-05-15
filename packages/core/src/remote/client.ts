import { sha256 } from "../hash.js";
import type { Hash, RefType } from "../types.js";
import {
  REMOTE_PROTOCOL_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  RemoteProtocolError,
  type ObjectsMissingResponse,
  type ObjectsUploadResponse,
  type RefsListResponse,
  type RefsUpdateResponse,
  type RemoteRef,
  type UploadLine,
} from "./protocol.js";

/**
 * Minimal `fetch` shape we depend on. Browser/Node global `fetch` matches.
 * Exposed as a constructor option so tests can inject a transport that
 * simulates failures (mid-stream disconnect, server restarts).
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface RemoteClientOptions {
  baseUrl: string;
  token: string;
  /** Inject a custom transport (defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Default request timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : "/" + path;
  return trimmedBase + trimmedPath;
}

/**
 * HTTP client for the AgentGit Remote Protocol v1. Stateless aside from the
 * caller-supplied bearer token; resumability state lives in the repository's
 * `.agentgit/remote-state.json` (see Repository.push).
 *
 * @public
 */
export class RemoteClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: RemoteClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (opts.fetchImpl) {
      this.fetchImpl = opts.fetchImpl;
    } else {
      const gf = (globalThis as { fetch?: FetchLike }).fetch;
      if (!gf) {
        throw new Error(
          "RemoteClient: no fetch implementation available; pass fetchImpl explicitly",
        );
      }
      this.fetchImpl = gf.bind(globalThis) as FetchLike;
    }
  }

  /** GET the remote's ref list. */
  async listRefs(): Promise<RemoteRef[]> {
    const res = await this.postJson<RefsListResponse>("/refs/list", {});
    return res.refs;
  }

  /** Ask the server which of `wants` it does not have. */
  async negotiateMissing(wants: Hash[], haves: Hash[]): Promise<Hash[]> {
    const res = await this.postJson<ObjectsMissingResponse>(
      "/objects/missing",
      { wants, haves },
    );
    return res.missing;
  }

  /**
   * Send one chunk of objects under `uploadId`. Returns the cumulative set
   * the server has durably received under that id (after this request).
   *
   * The client is expected to call this in a loop until every want is in
   * `received`, then call `commitUpload(uploadId)` to finalize.
   */
  async uploadObjects(
    uploadId: string,
    lines: UploadLine[],
  ): Promise<ObjectsUploadResponse> {
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    return this.postNdjson<ObjectsUploadResponse>(
      "/objects/upload",
      body,
      uploadId,
      false,
    );
  }

  /** Finalize an in-progress upload, moving pending objects into the store. */
  async commitUpload(uploadId: string): Promise<ObjectsUploadResponse> {
    return this.postNdjson<ObjectsUploadResponse>(
      "/objects/upload",
      "",
      uploadId,
      true,
    );
  }

  /** Bulk download object bodies. Returns one entry per hash the server has. */
  async downloadObjects(hashes: Hash[]): Promise<UploadLine[]> {
    if (hashes.length === 0) return [];
    const res = await this.requestRaw(
      "/objects/download",
      JSON.stringify({ hashes }),
      "application/json",
      {},
    );
    const text = await res.text();
    const out: UploadLine[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as UploadLine;
      const recomputed = sha256(parsed.body);
      if (recomputed !== parsed.hash) {
        throw new RemoteProtocolError(
          `download: object ${parsed.hash} failed hash verification (computed ${recomputed})`,
          200,
          "hash-mismatch",
        );
      }
      out.push(parsed);
    }
    return out;
  }

  /** Compare-and-swap a ref on the remote. */
  async updateRef(
    name: string,
    type: RefType,
    oldTarget: Hash | null,
    newTarget: Hash,
  ): Promise<RefsUpdateResponse> {
    return this.postJson<RefsUpdateResponse>("/refs/update", {
      name,
      type,
      old: oldTarget,
      new: newTarget,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.requestRaw(
      path,
      JSON.stringify(body),
      "application/json",
      {},
    );
    return (await res.json()) as T;
  }

  private async postNdjson<T>(
    path: string,
    body: string,
    uploadId: string,
    commit: boolean,
  ): Promise<T> {
    const qs = commit ? "?commit=1" : "";
    const res = await this.requestRaw(
      path + qs,
      body,
      "application/x-ndjson",
      { "Upload-Id": uploadId },
    );
    return (await res.json()) as T;
  }

  private async requestRaw(
    path: string,
    body: string,
    contentType: string,
    extra: Record<string, string>,
  ): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }> {
    const url = joinUrl(this.baseUrl, REMOTE_PROTOCOL_PREFIX + path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": contentType,
      "AgentGit-Protocol": String(REMOTE_PROTOCOL_VERSION),
      ...extra,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let code: string | null = null;
      let msg = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string; message?: string };
        if (typeof errBody.error === "string") code = errBody.error;
        if (typeof errBody.message === "string") msg = errBody.message;
      } catch {
        // Body wasn't JSON; keep the default message.
      }
      throw new RemoteProtocolError(`${path}: ${msg}`, res.status, code);
    }
    return res;
  }
}
