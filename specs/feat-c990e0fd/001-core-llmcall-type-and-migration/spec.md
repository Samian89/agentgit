# Core LlmCall Type, Schema Migration, and Repository Capture

## Goal
Make LLM calls a first-class commit payload alongside tool calls. Add an `LlmCall` interface to the core type system, persist it through a new `llm_call` column on the `commits` table (migration 003), thread it through `Repository.commit()` and `recordLlmCall()`, and refresh the api-extractor baseline so the new public surface is locked in.

## Context
- `packages/core/src/types.ts` defines the canonical content-addressed object shapes. `ToolCall` (lines 75–94) is embedded in `Commit` as `toolCall: ToolCall | null` (lines 119–120). The same module is the source of truth for what `Repository.commit` serializes and what `SqliteIndex` reads back.
- `packages/core/src/repository.ts` `commit()` (lines 171–277) builds the commit body, writes it to the object store, and inserts a row into SQLite atomically. `CommitInput` (lines 64–80) accepts an optional `toolCall`; an LLM analog needs the same plumbing.
- `packages/core/src/sqlite-index.ts` `insertCommit` (lines 178–203) and `rowToCommit` (lines 372–393) explicitly JSON-encode/decode `tool_call`. A symmetric `llm_call` column requires the same treatment plus a new `CommitRow` field (lines 37–50).
- `packages/core/src/migrations/index.ts` registers ordered migrations (`MIGRATIONS`, lines 21–24) and exposes `TARGET_VERSION` (line 26). The runner is invoked from `SqliteIndex`'s constructor (`packages/core/src/sqlite-index.ts:91`), so any new migration is auto-applied on first open. The Python mirror at `adapters/python/agentgit_adapter/migrations.py` (lines 81–100) is kept byte-for-byte in sync; this ticket only modifies the TypeScript side — the Python mirror is owned by spec 005.
- `packages/core/etc/agentgit-core.api.md` is the api-extractor baseline. Adding `LlmCall` and `Repository.recordLlmCall` is a public-surface change that must be re-generated (`pnpm --filter @agentgit/core api:update`) so the `api-extractor` CI job (`.github/workflows/ci.yml:155-173`) stays green.
- The wire-format mirror at `packages/ui-components/src/types.ts` (`CommitRow`, lines 16–25; `ToolCall`, lines 50–59) is read by the Tauri UI and the web viewer. The new `llm_call` column must surface here too — but that propagation lives in spec 007; this spec only stops at the core public API.

## Technical Approach
1. **Add `LlmCall` to `packages/core/src/types.ts`** next to `ToolCall`. Mirror the same field-order conventions (lowercase camelCase, nullable secondary fields):
   ```ts
   export interface LlmUsage {
     promptTokens: number;
     completionTokens: number;
     totalTokens: number;
   }

   export interface LlmMessage {
     role: "system" | "user" | "assistant" | "tool";
     content: string;
   }

   export interface LlmCall {
     id: string;             // uuid v4
     provider: string;       // e.g. "anthropic", "openai", "vercel-ai-sdk"
     model: string;          // e.g. "claude-opus-4-7"
     messages: LlmMessage[]; // prompt input
     response: string;       // model response text (joined)
     usage: LlmUsage | null;
     costEstimateUsd: number | null;
     startedAt: Timestamp;
     completedAt: Timestamp | null;
     durationMs: number | null;
     status: "pending" | "success" | "error";
     error: string | null;
   }
   ```
   Re-export from `packages/core/src/index.ts` next to the existing `ToolCall` export.
2. **Extend `Commit`**: add `llmCall: LlmCall | null` to the `Commit` interface (after `toolCall`). Because the canonical-JSON hash sorts keys alphabetically, every existing commit body in the wild that does not include `llmCall` will continue to hash to its current value as long as `null` is written explicitly when the field is absent. Set `llmCall: null` in the body built by `Repository.commit()` so new commits include the field; old commits (without `llmCall`) parsed via `rowToCommit` synthesize `llmCall: null` from a missing column.
3. **Migration 003** — `packages/core/src/migrations/003_llm_call.ts`:
   ```sql
   ALTER TABLE commits ADD COLUMN llm_call TEXT;
   ```
   Register in `MIGRATIONS` (`packages/core/src/migrations/index.ts`). Bumping `TARGET_VERSION` to 3 makes `SqliteIndex` auto-apply on next open.
4. **Update `CommitInput`** (`packages/core/src/repository.ts:64-80`) to accept `llmCall?: LlmCall | null`.
5. **Update `Repository.commit()`** (`packages/core/src/repository.ts:171-277`): destructure `llmCall = null`, include `llmCall` in `commitBody`, and pass through to `index.insertCommit`. The commit/object-store hashing path is unchanged (canonical JSON re-sorts keys).
6. **Add `Repository.recordLlmCall(input)`** as a thin convenience wrapper that constructs the commit message (`"LLM: <model>"`), sets `stateEntries: []`, builds a complete `LlmCall` from the caller's payload (auto-stamping `id`, `startedAt`/`completedAt` if missing), and delegates to `commit()`. Returns the produced `Commit`. Surface in `packages/core/src/index.ts`.
7. **Update `SqliteIndex`**:
   - Extend `CommitRow` interface with `llm_call: string | null`.
   - `insertCommit`: add `llm_call` placeholder and value `commit.llmCall !== null ? JSON.stringify(commit.llmCall) : null`.
   - `rowToCommit`: parse the column and synthesize `llmCall: null` when missing (so reading a row from a pre-migration legacy DB after upgrade still works).
8. **Telemetry**: the `commit` span attrs (`{ entries, signed }` at `repository.ts:270-273`) are deliberately minimal. Add an `hasLlmCall: boolean` benign attribute so observability can distinguish LLM vs tool commits without leaking user data. Update the privacy comment at `packages/core/src/telemetry/reporter.ts:8-23` to mention the new attr.
9. **Re-run api-extractor baseline**: `pnpm --filter @agentgit/core build && pnpm --filter @agentgit/core api:update && pnpm api:check` so the new `LlmCall`, `LlmUsage`, `LlmMessage`, and `Repository.recordLlmCall` symbols are recorded.
10. **Add unit tests** under `packages/core/src/__tests__/` covering:
    - Round-tripping an `LlmCall` through `commit()` → SQLite → `getCommit()` preserves every field.
    - A commit constructed via `recordLlmCall` produces a deterministic hash given fixed inputs (canonical-JSON regression).
    - Migration 003 applies cleanly to a fixture DB built at v2 and adds the `llm_call` column.

## Acceptance Criteria
- [ ] `packages/core/src/types.ts` exports `LlmCall`, `LlmUsage`, `LlmMessage`, and a `Commit` interface that includes `llmCall: LlmCall | null`.
- [ ] `packages/core/src/migrations/003_llm_call.ts` exists, is registered in `MIGRATIONS`, and `TARGET_VERSION === 3`.
- [ ] Opening a v2 fixture DB via `SqliteIndex.init(path)` results in a v3 schema (column `llm_call` present on `commits`) and `migrationStatus().current === 3`.
- [ ] `Repository.commit({ ..., llmCall })` round-trips the field through SQLite and the content-addressed store. `getCommit(hash).llmCall` equals the input.
- [ ] `Repository.recordLlmCall(payload)` returns a `Commit` whose `llmCall` is the canonicalized payload and whose hash matches `Repository.hashObject(body)`.
- [ ] `commit` telemetry span includes `hasLlmCall: boolean`; reporter.ts privacy comment is updated; no other user data leaks.
- [ ] `pnpm --filter @agentgit/core api:check` and root `pnpm api:check` both exit 0 with the regenerated baseline committed.
- [ ] All existing `@agentgit/core` tests still pass (`pnpm --filter @agentgit/core test`).

## Files to Touch
- packages/core/src/types.ts  (modify)
- packages/core/src/index.ts  (modify)
- packages/core/src/repository.ts  (modify)
- packages/core/src/sqlite-index.ts  (modify)
- packages/core/src/migrations/index.ts  (modify)
- packages/core/src/migrations/003_llm_call.ts  (create)
- packages/core/src/telemetry/reporter.ts  (modify — privacy comment + attr type)
- packages/core/etc/agentgit-core.api.md  (modify — regenerated baseline)
- packages/core/src/__tests__/llm-call.test.ts  (create)
- packages/core/src/__tests__/migrations-003.test.ts  (create)

## Test Strategy
```bash
pnpm --filter @agentgit/core build
pnpm --filter @agentgit/core test
pnpm --filter @agentgit/core api:update
pnpm api:check
pnpm --filter @agentgit/core typecheck
```
The two new test files cover (a) round-trip + recordLlmCall hash determinism and (b) migration 003 applied to a v2 fixture. The api-extractor diff in CI is the regression gate for any future accidental change to the LLM types.
