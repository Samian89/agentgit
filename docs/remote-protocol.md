# AgentGit Remote Protocol (v1)

Status: stable for v1.
Version header: clients send `AgentGit-Protocol: 1` on every request; servers
respond with the same header. Future versions are negotiated by bumping the
header and the URL prefix (`/api/v2/...`).

## 1. Goals & non-goals

The remote protocol moves session data between two AgentGit repositories over
HTTPS. It is intentionally simple: every payload is JSON, every endpoint is
idempotent, and there is no streaming pack format to maintain.

In scope:

- Reference advertisement and atomic ref updates (compare-and-swap).
- Per-object negotiation: client lists `wants`/`haves`, server replies with
  the subset of objects it does not yet have.
- Resumable, chunked uploads (per-object) keyed by a client-issued
  `Upload-Id`.
- Bulk download of object bodies as NDJSON.
- Bearer-token authentication.

Out of scope for v1:

- Server-driven merges (clients enforce fast-forward-only).
- Server-side garbage collection or maintenance.
- Multi-tenant ACL beyond a flat token list.
- Pack/packfile delta encoding (see §6 for the bandwidth tradeoff).

## 2. Auth model

All endpoints require `Authorization: Bearer <token>`. A request without a
valid token returns `401 Unauthorized` with body `{"error":"unauthorized"}`.

Tokens are issued out-of-band by the server operator and shipped to the
reference server via `--token-file <path>` — a newline-delimited UTF-8 file
of opaque strings (any printable ASCII, no whitespace). Tokens are compared
in constant time using HMAC-SHA-256 over a server-side secret so that
log-leaked tokens cannot be replayed on a different server.

Clients persist their token under `remotes.<name>.token` in
`~/.agentgitconfig`. The token file is created with `0600` permissions on
POSIX; on Windows the file inherits the user's profile ACLs.

There is no anonymous read mode in v1; every endpoint authenticates the
same way.

## 3. Endpoints

All endpoints accept and return `application/json` unless noted. Errors use
HTTP status codes and a JSON body `{ "error": "<code>", "message": "<msg>" }`.

### 3.1 `POST /api/v1/refs/list`

Request body: `{}` (reserved for future filters).

Response body:

```json
{
  "refs": [
    { "name": "sessions/main",         "target": "<64 hex>", "type": "branch" },
    { "name": "tags/v1",               "target": "<64 hex>", "type": "tag" }
  ]
}
```

`type` is one of `branch`, `tag`, `session-head` (matching the local `Ref`
shape from `@agentgit/core`).

Idempotent. Returns `200 OK` even if no refs exist.

### 3.2 `POST /api/v1/objects/missing`

Negotiation: the client tells the server which commits it wants to push and
which it already has on the server side; the server replies with the set of
objects it does not have.

Request body:

```json
{
  "wants": ["<commit hash>", "..."],
  "haves": ["<commit hash>", "..."]
}
```

Response body:

```json
{ "missing": ["<hash>", "..."] }
```

Implementation note: the client must enumerate the *full* reachable object
set (commit, tree, blob hashes) under `wants` and send them all in `wants`;
the server only checks presence, not reachability. A `have` simply prunes
the search: any hash listed in `haves` is treated as already present even
if it isn't, so the client can avoid uploading objects it already pushed in
a previous round (use the per-remote remote-state file).

### 3.3 `POST /api/v1/objects/upload`

Chunked, resumable upload of one or more objects. The client sends each
object body as a chunk; the server appends to a pending upload identified
by the client-chosen `Upload-Id`.

Headers:

- `Authorization: Bearer <token>` — required.
- `Upload-Id: <ulid-or-uuid>` — required. Client-chosen; the same value
  must be reused on retry.
- `Content-Type: application/x-ndjson` — required.

Request body: one or more `{"hash":"<hex>","body":<object>}` lines (NDJSON).
Each `body` is the canonical-JSON object as stored on disk under
`.agentgit/objects/<2>/<62>` — i.e., **without** the synthetic `hash`,
`signature`, or `publicKey` fields that the index attaches at read time.
The server recomputes SHA-256 over the canonical form and rejects the
chunk if it does not match the declared `hash`.

Response body:

```json
{
  "uploadId": "<upload-id>",
  "received": ["<hash>", "..."],
  "rejected": [{ "hash": "<hash>", "reason": "hash-mismatch" }]
}
```

`received` is the cumulative set across all requests with this `Upload-Id`.
After a network failure, the client re-issues `POST /objects/upload` with
the same `Upload-Id` and only the lines whose hashes are not in `received`.
Re-sending an already-received hash is allowed and treated as a no-op.

To finalize, the client sends `POST /api/v1/objects/upload?commit=1` with
the same `Upload-Id` (empty NDJSON body is fine). The server moves all
buffered objects from its pending area into the permanent object store and
clears the upload-id state. Calling `commit=1` against an unknown
`Upload-Id` returns `200 { "uploadId": "...", "received": [] }` (idempotent).

Resumability invariant: an object that appears in `received` is durably
stored in the server's pending area; a crash or restart does not lose it.

### 3.4 `POST /api/v1/objects/download`

Bulk fetch of object bodies.

Request body:

```json
{ "hashes": ["<hash>", "..."] }
```

Response: `Content-Type: application/x-ndjson` with one
`{"hash":"<hex>","body":<object>}` per line. Hashes the server does not have
are omitted from the stream — clients must verify the returned set matches
what they asked for.

Each `body` is canonical-JSON; the client recomputes SHA-256 and refuses
any object whose body does not hash to the declared hash.

### 3.5 `POST /api/v1/refs/update`

Atomic compare-and-swap on a ref.

Request body:

```json
{
  "name":   "sessions/<id>",
  "type":   "branch",
  "old":    "<64 hex>" | null,
  "new":    "<64 hex>"
}
```

Semantics: the server updates `refs/<name>` to `new` **only if** the current
value equals `old`. `old: null` means "the ref does not yet exist." On
conflict the server returns `409 Conflict` with `{ "error":"ref-conflict",
"current": "<hash or null>" }`. On success: `200 { "ok": true }`.

The server additionally requires that the `new` target is already an object
in the store (i.e., the client uploaded it first). Missing target → `409
{ "error":"missing-target" }`.

## 4. Wire-level conventions

- **Hash format**: lowercase hex, 64 characters. Servers reject anything
  else with `400`.
- **Chunk size**: clients should batch objects to roughly 1 MiB per upload
  request (the canonical JSON for a typical text blob is ~1–4 KB; one
  request commonly carries 200–1000 objects). The server tolerates any size
  up to `--max-chunk-bytes` (default 8 MiB).
- **Compression**: `Content-Encoding: gzip` is supported on both sides for
  `objects/download` and `objects/upload`. The reference server enables it
  by default.
- **Timeouts**: clients should set a generous per-request timeout
  (30 s default) and retry idempotently on network errors.
- **Rate limiting**: out of scope for v1. The reference server simply
  refuses concurrent uploads with the same `Upload-Id` (`423 Locked`).

## 5. Client/server failure model

| Failure                                         | Client behaviour                                    |
|-------------------------------------------------|-----------------------------------------------------|
| Network drop mid-upload                         | Re-issue `POST /objects/upload` with same Upload-Id |
| Server restart mid-upload                       | Same as above; pending dir is on disk and survives  |
| `ref-conflict` (someone else pushed first)      | Re-fetch refs, abort and surface to user            |
| `missing-target` on ref update                  | Re-run `objects/missing` and re-upload              |
| `hash-mismatch` on upload                       | Bug — local object corrupted, do not retry          |
| `401 unauthorized`                              | Refresh token from config and surface error         |

The client persists in-progress `Upload-Id` set under
`.agentgit/remote-state.json`:

```json
{
  "<remote-name>": {
    "uploadId":  "<ulid>",
    "wants":     ["<hash>", "..."],
    "received":  ["<hash>", "..."],
    "startedAt": 1731000000000
  }
}
```

`fetch` does not need persistent state — it is a strict request/response.

## 6. Bandwidth tradeoff vs. git packfiles

Git's smart-HTTP protocol streams a **packfile**: objects are delta-encoded
against neighbours in the same history, then zlib-compressed. For a typical
session that mostly mutates a few text files, the packfile is ~10–30%
smaller than the JSON-over-HTTPS payload this protocol uses, because:

1. **No delta encoding.** Two adjacent blobs that differ by one line still
   ship as two complete bodies. Trees ship in full each commit. With ~80%
   text overlap between adjacent commits this is the dominant overhead.
2. **JSON framing.** Object envelopes (`{"type":"blob","size":...,"encoding":...,"content":"..."}`)
   add ~80 bytes per object on top of the raw bytes. For small blobs this
   matters; for large ones it is negligible.
3. **base64 for binary.** Binary blobs are stored as base64 in canonical
   JSON, a fixed 33% overhead vs git's raw bytes.

Why we picked the simpler protocol anyway:

- **No pack-format engineering.** Implementing pack delta selection in
  TypeScript would be the largest single piece of code in the project and
  the hardest to keep correct.
- **Trivial debugging.** Every payload is readable in `curl | jq`; every
  intermediate state is greppable on disk.
- **No bottleneck.** Agent sessions are tiny by code-repo standards (a few
  hundred KB of state, dozens of commits). A 20% wire-size penalty on a
  300 KB session is 60 KB — vs. the engineering cost of building and
  maintaining a packfile path. We can reintroduce a pack codec in a future
  protocol version if real-world repos make it worthwhile, behind the same
  `AgentGit-Protocol:` header.

Operators who care about bandwidth can enable `Content-Encoding: gzip`
(default on for the reference server), which recovers ~50–60% of the
overhead on text-heavy sessions because the JSON envelopes and the
near-duplicate trees compress extremely well.

## 7. Reference server

`packages/remote-server/` ships a single-binary reference implementation:

```
agentgit-remote-server --port 8787 --data-dir ./data --token-file ./tokens
```

Storage layout under `--data-dir`:

```
data/
  objects/<2>/<62>             # canonical JSON, identical to the client
  pending/<upload-id>/<hash>   # buffered upload chunks
  refs.db                      # SQLite: refs(name, target, type, updated_at)
```

The pending directory is the durability boundary: once a chunk lands there
fsync'd, the protocol guarantees the client never has to re-send it.

## 8. Versioning & extension points

- Bumping `formatVersion` (request/response envelopes) is a breaking change
  and requires a new URL prefix.
- Adding new optional response fields (e.g. `serverTime`) is non-breaking.
- New endpoints under the same `/api/v1/` prefix are non-breaking as long
  as clients tolerate `404` for unknown ones (they do — the client only
  ever calls the five listed above).
