# AMC-b5ac1afd — Bundle format and web viewer

## 1. What was built

### 1.1 The `.agentgit-bundle` format (`packages/core/src/bundle/`)

A portable single-file format that captures one or more sessions plus their
reachable objects, refs, and metadata. Container is a **gzipped POSIX ustar
archive** with the following top-level entries:

| Entry              | Contents                                                            |
|--------------------|---------------------------------------------------------------------|
| `manifest.json`    | `{ formatVersion, schemaVersion, sessionIds, createdAt, generator }`|
| `objects/<2>/<62>` | Canonical-JSON object bodies (blobs/trees/commits, deduplicated).   |
| `commits.jsonl`    | One denormalised `Commit` JSON per line, ordered by timestamp.      |
| `refs.json`        | Array of `Ref` rows whose target is included in the bundle.         |
| `sessions.json`    | Array of full `Session` records for the included sessions.          |

### 1.2 Core implementation

- `bundle/tar.ts` — minimal POSIX ustar writer/reader on `Uint8Array`,
  runs in Node and the browser unchanged.
- `bundle/pack.ts` — walks reachability per session (`commit → tree →
  blob`) and emits objects in sorted hash order for reproducibility.
- `bundle/unpack.ts` — the **single validation gate**. Enforces:
  - **manifest field shape**: positive-integer `formatVersion` /
    `schemaVersion`, array-of-non-empty-strings `sessionIds`, finite
    `createdAt`, string `generator` — all checked before version
    comparisons;
  - **manifest ↔ sessions.json agreement** (new this cycle):
    `manifest.sessionIds` must exactly match the id set in
    `sessions.json` (no extras either way);
  - object/commit body **hash integrity**;
  - **no duplicate hashes** in `commits.jsonl`, **no duplicate ids** in
    `sessions.json`;
  - **row shape** for commits (hash/tree/sessionId/message strings,
    timestamp finite, parent null|string), refs (name/target/type with
    type ∈ {branch, tag, session-head}), sessions (id/name/status with
    status ∈ {active, completed, failed, abandoned},
    createdAt/updatedAt finite, head null|string), tree entries (path
    non-empty, size finite ≥ 0, blobHash string);
  - **reachability** for every internal reference: commit→tree,
    non-null commit→parent, commit→sessionId, ref→commit target,
    non-null session→head, tree-entry→blob.
- `bundle/node-file.ts` — Node-only `createBundleFile` /
  `importBundleFile`. Import is strictly atomic:
  1. `unpack()` validates the bundle fully.
  2. **One** SQLite transaction inserts sessions, commits, blobs,
     tree_entries, refs, **and** reattaches each session's head.
  3. Object files are written to `.agentgit/objects/` **last**.
  A rejected bundle leaves `.agentgit/objects/` and `index.db`
  identical to their pre-import state.

### 1.3 CLI: `agentgit bundle`

- `agentgit bundle create <session...> [-o file.agentgit-bundle]` — packs
  one or more sessions (by id or name). Defaults output to
  `<first-session-name>.agentgit-bundle` in cwd.
- `agentgit bundle import <file>` — restores a bundle, verifying every
  hash and every internal reference.

### 1.4 Shared component package (`packages/ui-components/`)

The four React components previously in `packages/ui/src/components/`
(`StepCard`, `DiffView`, `BlameView`, `TimelineScrollbar`) live in a new
workspace package `@agentgit/ui-components`, with their theme stylesheet
(`styles.css`) and the wire-format row types. The Tauri UI re-exports
them; all existing UI tests pass untouched.

### 1.5 Browser viewer (`packages/web-viewer/`)

A Vite + React app with **no native dependencies** that opens a dropped
`.agentgit-bundle` (or `?bundle=<url>`) and renders it through the
shared components:

- `bundle/{tar.ts, hash.ts, unpack.ts}` — browser copies of the bundle
  reader. Gunzip uses **pako**; SHA-256 uses **SubtleCrypto**. Mirrors
  the core unpack's full validation contract.
- `in-memory-index.ts` — read-only adapter that reshapes a parsed bundle
  into the wire-format row types the shared components expect.
- `App.tsx` — drag-and-drop entry point with a `?bundle=<url>`
  auto-loader.

Production bundle size: **229 kB JS / 73 kB gzipped**, 2.3 kB CSS.

## 2. Reviewer-flag resolution

Review 1 (2026-05-14T20:39:42) — *"bundle import accepts missing reachable
objects and can leave partial writes after rejected tampered metadata."*

This cycle closes the manifest↔payload consistency gap. Previously
`manifest.sessionIds` was read straight from JSON and used only as
informational metadata; it was never cross-checked against the session
ids actually present in `sessions.json`. A doctored bundle could declare
`["sess-a"]` in the manifest while shipping `[sess-b]` in
`sessions.json` — every other validator passed, and the import quietly
proceeded with whatever was in the payload, leaving the bundle
internally inconsistent. `unpack` now requires the two sets to be
equal — extras on either side raise a precise error.

Together with the earlier cycles' work (reachability, commit/ref/
session/tree/manifest shape, duplicate-hash/duplicate-id rejection,
commit→sessionId reachability, disk-after-DB ordering, single-txn DB
phase), `unpack` is the sole validation gate: every reason an import
could fail surfaces before any disk or DB mutation.

## 3. Files changed

### Added (prior cycles)
- `packages/core/src/bundle/{tar.ts, manifest.ts, pack.ts, unpack.ts, node-file.ts, index.ts}`
- `packages/core/src/__tests__/bundle.test.ts`
- `packages/cli/src/commands/bundle.ts`
- `packages/cli/tests/integration/bundle.test.ts`
- `packages/ui-components/{package.json, tsconfig.json}`
- `packages/ui-components/src/{index.ts, types.ts, styles.css}`
- `packages/ui-components/src/components/{StepCard.tsx, DiffView.tsx, BlameView.tsx, TimelineScrollbar.tsx}`
- `packages/web-viewer/{package.json, tsconfig.json, vite.config.ts, index.html}`
- `packages/web-viewer/src/{main.tsx, App.tsx, in-memory-index.ts}`
- `packages/web-viewer/src/bundle/{tar.ts, hash.ts, types.ts, unpack.ts}`

### Modified (prior cycles)
- `packages/core/src/index.ts` — re-exports the bundle API.
- `packages/cli/src/index.ts` — wires the `bundle` subcommand.
- `packages/ui/src/components/{StepCard.tsx, DiffView.tsx, BlameView.tsx, TimelineScrollbar.tsx}` — thin re-exports from `@agentgit/ui-components`.
- `packages/ui/src/types.ts` — re-exports row types from the shared package.
- `packages/ui/package.json` — depends on `@agentgit/ui-components`.

### Modified this cycle
- `packages/core/src/bundle/unpack.ts` — added the manifest↔sessions.json
  consistency check.
- `packages/web-viewer/src/bundle/unpack.ts` — mirror.
- `packages/core/src/__tests__/bundle.test.ts` — two regression tests
  covering both mismatch directions.

`pnpm-workspace.yaml` did not need editing.

## 4. Test results

```
pnpm test
  Test Files  32 passed (32)
  Tests       288 passed (288)         # +2 bundle tests this cycle

pnpm --filter @agentgit/web-viewer build
  ✓ 44 modules transformed.
  dist/index.html          0.40 kB
  dist/assets/index.css    2.29 kB │ gzip:  0.77 kB
  dist/assets/index.js   228.94 kB │ gzip: 73.25 kB
  ✓ built in 1.04s
```

Bundle test coverage (`packages/core/src/__tests__/bundle.test.ts`):
tar round-trip; pack manifest shape; unpack happy path; create → import
→ `agentgit log` round-trip; idempotent re-import; refusals for
schema/format-version mismatch, byte-flipped object body (no partial
writes), tampered commit body, missing tree/blob/parent/ref-target/
session-head/sessionId-in-sessions.json, malformed tree entry,
duplicate commit hash, invalid ref type, missing required commit field,
invalid session status, duplicate session id, manifest.formatVersion
missing, manifest.schemaVersion is a string,
**manifest.sessionIds missing a session present in sessions.json (new
this cycle)**, **manifest.sessionIds naming a phantom session (new this
cycle)**; atomicity (failure + happy paths, head-inside-txn);
canonical-JSON safety.

CLI integration (`packages/cli/tests/integration/bundle.test.ts`, 4
tests): create → import round-trip; tampered-bundle refusal with no
partial writes; unknown-session refusal; missing-file refusal.

## 5. APIs / types other tickets may consume

### `@agentgit/core` — bundle exports

```ts
const BUNDLE_FORMAT_VERSION: number;
interface BundleManifest {
  formatVersion: number;
  schemaVersion: number;
  sessionIds: string[];
  createdAt: number;
  generator: string;
}

// Low-level (Node + browser-safe pure logic)
function packBundle(input: PackInput): PackResult;
function unpackBundle(tar: Uint8Array, opts: UnpackOptions): UnpackResult;
function readTar(buf: Uint8Array): TarEntry[];
function writeTar(entries: readonly TarEntry[]): Uint8Array;

// Node-only convenience
function createBundleFile(opts: CreateBundleOptions): PackResult & { bytesWritten: number };
function importBundleFile(opts: ImportBundleOptions): ImportBundleResult;
```

### `@agentgit/ui-components` — workspace package

```ts
export { StepCard, DiffView, BlameView, TimelineScrollbar };
export type { SessionRow, CommitRow, DiffResult, DiffEntry, BlameEntry, ToolCall };
// Theme stylesheet: import "@agentgit/ui-components/styles.css";
```

### CLI surface

```
agentgit bundle create <session...> [-o file.agentgit-bundle]
agentgit bundle import <file>
```

### Behavioural invariants downstream tickets can rely on

1. `unpack(tar, opts)` returns a `UnpackResult` only if:
   - `manifest.json` has a fully-shaped, well-typed payload AND its
     `sessionIds` set matches `sessions.json` exactly,
   - every object body hash matches its content,
   - every commit row is fully shaped and uniquely hashed,
   - every ref row has a valid `name`/`target`/`type`,
   - every session row has a valid `id`/`name`/`status`/`createdAt`/
     `updatedAt`/`head` with no duplicate ids,
   - every tree entry has a valid `path`/`size`/`blobHash`,
   - every internal reference resolves.
2. `importBundleFile(opts)` is strictly all-or-nothing across both disk
   and DB. If it throws, `.agentgit/objects/` has zero new files, no
   new SQLite rows exist, and no session has been left with a stale
   `head = null`.
3. The web viewer's `readBundle` shares the same invariants and error
   vocabulary (`Bundle: ...`).
4. Bundle output is deterministic: packing the same session twice
   produces the same inner tar bytes (gzip framing aside) — objects are
   emitted in sorted hash order.
