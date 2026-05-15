import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  REMOTE_PROTOCOL_PREFIX,
  REMOTE_PROTOCOL_VERSION,
  type RefsListResponse,
  type ObjectsMissingRequest,
  type ObjectsMissingResponse,
  type ObjectsUploadResponse,
  type ObjectsDownloadRequest,
  type RefsUpdateRequest,
  type UploadLine,
} from "@agentgit/core";
import { RemoteStorage } from "./storage.js";

export interface RemoteServerOptions {
  /** Filesystem root for objects, pending uploads, and refs.db. */
  dataDir: string;
  /** Path to a newline-delimited token file, or an in-memory token list. */
  tokenFile?: string;
  tokens?: string[];
  /** Server secret used for HMAC token comparison. */
  serverSecret?: string;
  /** Max bytes per object/upload chunk before the request is refused. */
  maxChunkBytes?: number;
  /** Enable Fastify request logging. */
  logger?: boolean;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const UPLOAD_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const REF_NAME = /^[A-Za-z0-9_./-]{1,256}$/;

function loadTokens(opts: RemoteServerOptions): Set<string> {
  const tokens = new Set<string>();
  if (opts.tokens) for (const t of opts.tokens) tokens.add(t.trim());
  if (opts.tokenFile) {
    if (!existsSync(opts.tokenFile)) {
      throw new Error(`token file not found: ${opts.tokenFile}`);
    }
    const text = readFileSync(opts.tokenFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith("#")) tokens.add(t);
    }
  }
  return tokens;
}

function hmacOf(secret: string, value: string): Buffer {
  return createHmac("sha256", secret).update(value).digest();
}

function constantTimeIncludes(set: Set<string>, candidate: string, secret: string): boolean {
  const c = hmacOf(secret, candidate);
  for (const v of set) {
    const got = hmacOf(secret, v);
    if (got.length === c.length && timingSafeEqual(got, c)) return true;
  }
  return false;
}

/**
 * Build a Fastify app implementing the AgentGit Remote Protocol v1. The
 * caller starts it via `app.listen(...)`. See `cli.ts` for the
 * command-line entrypoint.
 */
export async function buildServer(opts: RemoteServerOptions): Promise<FastifyInstance> {
  const storage = new RemoteStorage(opts.dataDir);
  const tokens = loadTokens(opts);
  const secret = opts.serverSecret ?? "agentgit-remote-default-secret";
  const maxChunkBytes = opts.maxChunkBytes ?? 8 * 1024 * 1024;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: Math.max(maxChunkBytes, 8 * 1024 * 1024),
  });

  // Decode NDJSON bodies into a string we can split.
  app.addContentTypeParser(
    "application/x-ndjson",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Tag every response with the protocol version so clients can sanity-check.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("AgentGit-Protocol", String(REMOTE_PROTOCOL_VERSION));
    return payload;
  });

  // Auth hook covers every /api/v1/* request.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith(REMOTE_PROTOCOL_PREFIX + "/")) return;
    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const token = header.slice("Bearer ".length).trim();
    if (!constantTimeIncludes(tokens, token, secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // ---------------------------------------------------------------------
  // refs/list
  // ---------------------------------------------------------------------
  app.post(`${REMOTE_PROTOCOL_PREFIX}/refs/list`, async (_req, reply) => {
    const refs = storage.listRefs();
    const body: RefsListResponse = { refs };
    return reply.send(body);
  });

  // ---------------------------------------------------------------------
  // objects/missing
  // ---------------------------------------------------------------------
  app.post(`${REMOTE_PROTOCOL_PREFIX}/objects/missing`, async (req, reply) => {
    const b = (req.body ?? {}) as Partial<ObjectsMissingRequest>;
    if (!Array.isArray(b.wants)) {
      return reply.code(400).send({ error: "invalid-request", message: "wants must be an array" });
    }
    const haves = new Set<string>(Array.isArray(b.haves) ? b.haves : []);
    const missing: string[] = [];
    for (const h of b.wants) {
      if (typeof h !== "string" || !HEX_64.test(h)) {
        return reply
          .code(400)
          .send({ error: "invalid-request", message: `bad hash: ${String(h)}` });
      }
      if (haves.has(h)) continue;
      if (!storage.hasObject(h)) missing.push(h);
    }
    const body: ObjectsMissingResponse = { missing };
    return reply.send(body);
  });

  // ---------------------------------------------------------------------
  // objects/upload (resumable)
  // ---------------------------------------------------------------------
  app.post(`${REMOTE_PROTOCOL_PREFIX}/objects/upload`, async (req, reply) => {
    const uploadIdHeader = req.headers["upload-id"];
    const uploadId =
      typeof uploadIdHeader === "string" ? uploadIdHeader.trim() : "";
    if (!UPLOAD_ID.test(uploadId)) {
      return reply.code(400).send({ error: "invalid-upload-id" });
    }
    const commit = (req.query as { commit?: string } | undefined)?.commit === "1";
    const rawBody = typeof req.body === "string" ? req.body : "";

    if (rawBody.length > maxChunkBytes) {
      return reply.code(413).send({ error: "chunk-too-large" });
    }

    const rejected: Array<{ hash: string; reason: string }> = [];
    if (rawBody.length > 0) {
      for (const line of rawBody.split("\n")) {
        if (line.trim().length === 0) continue;
        let parsed: UploadLine;
        try {
          parsed = JSON.parse(line) as UploadLine;
        } catch {
          rejected.push({ hash: "", reason: "invalid-json" });
          continue;
        }
        if (
          typeof parsed.hash !== "string" ||
          !HEX_64.test(parsed.hash) ||
          typeof parsed.body !== "object" ||
          parsed.body === null
        ) {
          rejected.push({ hash: String(parsed?.hash ?? ""), reason: "invalid-line" });
          continue;
        }
        const ok = storage.stagePending(uploadId, parsed.hash, parsed.body);
        if (!ok) {
          rejected.push({ hash: parsed.hash, reason: "hash-mismatch" });
        }
      }
    }

    let committed = false;
    if (commit) {
      storage.commitPending(uploadId);
      committed = true;
    }

    const received = committed ? [] : storage.listPending(uploadId);
    const body: ObjectsUploadResponse = {
      uploadId,
      received,
      rejected,
      committed,
    };
    return reply.send(body);
  });

  // ---------------------------------------------------------------------
  // objects/download (NDJSON)
  // ---------------------------------------------------------------------
  app.post(`${REMOTE_PROTOCOL_PREFIX}/objects/download`, async (req, reply) => {
    const b = (req.body ?? {}) as Partial<ObjectsDownloadRequest>;
    if (!Array.isArray(b.hashes)) {
      return reply.code(400).send({ error: "invalid-request" });
    }
    const lines: string[] = [];
    for (const h of b.hashes) {
      if (typeof h !== "string" || !HEX_64.test(h)) continue;
      const body = storage.readObject(h);
      if (body === null) continue;
      lines.push(JSON.stringify({ hash: h, body }));
    }
    reply.header("Content-Type", "application/x-ndjson");
    return reply.send(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  });

  // ---------------------------------------------------------------------
  // refs/update (CAS)
  // ---------------------------------------------------------------------
  app.post(`${REMOTE_PROTOCOL_PREFIX}/refs/update`, async (req, reply) => {
    const b = (req.body ?? {}) as Partial<RefsUpdateRequest>;
    if (
      typeof b.name !== "string" ||
      !REF_NAME.test(b.name) ||
      (b.type !== "branch" && b.type !== "tag" && b.type !== "session-head") ||
      typeof b.new !== "string" ||
      !HEX_64.test(b.new) ||
      (b.old !== null && (typeof b.old !== "string" || !HEX_64.test(b.old)))
    ) {
      return reply.code(400).send({ error: "invalid-request" });
    }
    const result = storage.updateRef(b.name, b.type, b.old ?? null, b.new);
    if (!result.ok) {
      return reply.code(409).send(result);
    }
    return reply.send({ ok: true });
  });

  // Expose storage to tests so they can corrupt the pending dir, etc.
  (app as unknown as { __storage: RemoteStorage }).__storage = storage;

  app.addHook("onClose", async () => {
    storage.close();
  });

  return app;
}

/** Extract the storage handle from a server built by {@link buildServer}. */
export function getStorage(app: FastifyInstance): RemoteStorage {
  return (app as unknown as { __storage: RemoteStorage }).__storage;
}

// Internal: typed access to the request type for downstream wiring.
export type AgentGitRequest = FastifyRequest;
