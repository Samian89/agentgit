# Web Viewer + Tauri UI — Render LlmCall in Session Timeline

## Goal
Make LLM commits visible in the shared `StepCard` component so both the read-only web viewer (`packages/web-viewer`) and the Tauri desktop UI (`packages/ui`) display them. Each LlmCall row shows the model name as the headline, with token counts and cost estimate as secondary text, and an expand control that reveals the prompt (last user turn) and response text. Bundle/wire-format support is added in lockstep so a session exported to a `.agentgit-bundle` and opened in the web viewer renders identically to the Tauri view.

## Context
- The wire-format type used by both UIs is `CommitRow` at `packages/ui-components/src/types.ts:16-25`. It currently exposes `tool_call: string | null` (serialized JSON). Adding `llm_call: string | null` is the smallest change that keeps both UIs in sync. The corresponding `ToolCall` type is at lines 50–59.
- The shared `StepCard` component at `packages/ui-components/src/components/StepCard.tsx` (101 lines) parses `commit.tool_call` and renders `tc.name`, status, input, output. Lines 47–51 render a tool-call summary; lines 58–76 render the expanded detail. The LlmCall branch slots in next to this one.
- The web viewer's `InMemoryIndex.toCommitRow` (`packages/web-viewer/src/in-memory-index.ts:138-149`) maps a bundle commit to a `CommitRow`. It needs to serialize `c.llmCall` to `llm_call`.
- The Tauri IPC layer in `packages/ui` returns rows from SQLite directly; the existing column order is what `CommitRow` mirrors. Once the `commits` table has the `llm_call` column (spec 001 migration 003), the IPC just needs to SELECT it. The Tauri Rust code is under `packages/ui/src-tauri/` — find the `get_commits` query (likely `src-tauri/src/db.rs` or similar) and add the new column.
- The bundle format manifest schema check at `packages/web-viewer/src/bundle/unpack.ts:88-123` refuses bundles whose `schemaVersion` exceeds `VIEWER_SCHEMA_VERSION` (defined in `bundle/types.ts`). Migration 003 bumps the SQLite schema version to 3, so `VIEWER_SCHEMA_VERSION` must rise to 3 as well or the viewer will refuse to open new bundles.
- The web viewer has its own copy of the bundle/commit types under `packages/web-viewer/src/bundle/types.ts` — verify and extend the local `Commit` type so it includes `llmCall`. The validator in `unpack.ts:126-169` does not currently inspect `llmCall`; adding the field is permissive (extra JSON keys are accepted), but a guarded `if (c.llmCall && typeof c.llmCall !== "object") throw` keeps integrity tight.
- Tests for the web viewer live under `packages/web-viewer/src/__tests__/` and use vitest with happy-dom (see `vitest.config.ts`). The shared components have no test directory of their own today; this spec adds vitest tests for the LlmCall render path inside `packages/web-viewer` to avoid spinning up a new test infra.

## Technical Approach
1. **`packages/ui-components/src/types.ts`**:
   - Add `llm_call: string | null` to `CommitRow`.
   - Add an `LlmCall` interface mirroring the core spec from 001 (snake_case where it crosses the wire):
     ```ts
     export interface LlmCall {
       id: string;
       provider: string;
       model: string;
       messages: Array<{ role: string; content: string }>;
       response: string;
       usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
       cost_estimate_usd: number | null;
       started_at: number;
       completed_at: number | null;
       duration_ms: number | null;
       status: "pending" | "success" | "error";
       error: string | null;
     }
     ```
     (Match whatever casing convention the existing rows use end-to-end — the TS core writes camelCase JSON; the SQL columns are snake_case; the wire-format `CommitRow` is snake_case. Verify by reading `tool_call` JSON in practice and using the same convention for `llm_call`.)
2. **`packages/ui-components/src/components/StepCard.tsx`**:
   - Add a `parseLlmCall(raw)` helper.
   - In the headline area (after the tool-name span at lines 47–51), add an llm summary line:
     ```tsx
     {lc && (
       <div style={{ fontSize: 11, color: "var(--llm-accent)", marginTop: 2 }}>
         {lc.model} · {lc.usage?.totalTokens ?? "?"} tok
         {lc.cost_estimate_usd !== null && ` · ~$${lc.cost_estimate_usd.toFixed(4)}`}
       </div>
     )}
     ```
   - In the expanded body (lines 58–76), add an llm detail block: model, provider, prompt (last user message truncated to 800 chars with an in-place "show more" toggle), response (same treatment), usage breakdown, duration, cost, status, optional error.
   - Both branches render if a commit somehow carries both. (Future-proof; spec 001 doesn't forbid it.)
   - Add a `--llm-accent` CSS variable to `packages/ui-components/src/styles.css` for the new color (default to a muted purple).
3. **`packages/web-viewer/src/in-memory-index.ts`**:
   - Update `toCommitRow` (lines 138–149) to include `llm_call: c.llmCall ? JSON.stringify(c.llmCall) : null`.
4. **`packages/web-viewer/src/bundle/types.ts`**:
   - Add `llmCall: LlmCall | null` to `Commit`.
   - Bump `VIEWER_SCHEMA_VERSION` from 2 to 3.
5. **`packages/web-viewer/src/bundle/unpack.ts`**:
   - Schema-version check at lines 119–123 stays — bumping the constant to 3 lets v3 bundles in.
   - Optionally add a defensive `typeof c.llmCall !== "object" && c.llmCall !== null` guard in the commit validator (lines 126–169).
6. **Tauri side** (`packages/ui/src-tauri/...`):
   - The Rust IPC handler that returns `Vec<CommitRow>` (search for `get_commits` and `tool_call` in `src-tauri/src/`) must SELECT the new column and serialize it through the existing serde shape so the front-end receives `llm_call`. Bumping `migration version` is handled by the core (spec 001) — the Tauri shell uses the same SQLite file written by `Repository.init`.
7. **Tests**:
   - `packages/web-viewer/src/App.test.tsx` and a new `step-card-llm.test.tsx` (still under `packages/web-viewer/src/__tests__/`):
     - Mounting `<StepCard commit={...} />` with an `llm_call` JSON renders the model + tokens line.
     - Expanding the card reveals prompt and response text.
     - A commit carrying both `tool_call` and `llm_call` renders both summaries.
   - Bundle round-trip test: an in-memory bundle including a commit with `llmCall` is parsed by `readBundle` and reshaped by `InMemoryIndex.getCommits()` into a `CommitRow` whose `llm_call` parses back to the original object.

## Acceptance Criteria
- [ ] `CommitRow.llm_call: string | null` exists in `@agentgit/ui-components`; the `LlmCall` interface exists alongside `ToolCall`.
- [ ] `StepCard` renders an `llm: <model> · <N> tok` headline for commits with an `llmCall` and a detail panel with prompt + response on expand.
- [ ] `VIEWER_SCHEMA_VERSION === 3` and `readBundle` accepts a bundle whose `schemaVersion = 3` without throwing.
- [ ] `InMemoryIndex.getCommits(sessionId)` returns rows whose `llm_call` round-trips to the original `LlmCall` via `JSON.parse`.
- [ ] Tauri UI `get_commits` IPC returns `llm_call` populated from the SQLite column; the front-end StepCard renders it without code changes (because the shared component already handles it).
- [ ] `pnpm --filter @agentgit/web-viewer test` and `pnpm --filter @agentgit/ui test` pass; `pnpm --filter @agentgit/web-viewer typecheck` and `pnpm --filter @agentgit/ui typecheck` pass.

## Files to Touch
- packages/ui-components/src/types.ts  (modify)
- packages/ui-components/src/components/StepCard.tsx  (modify)
- packages/ui-components/src/styles.css  (modify)
- packages/web-viewer/src/bundle/types.ts  (modify)
- packages/web-viewer/src/bundle/unpack.ts  (modify — VIEWER_SCHEMA_VERSION + optional guard)
- packages/web-viewer/src/in-memory-index.ts  (modify)
- packages/web-viewer/src/__tests__/step-card-llm.test.tsx  (create)
- packages/ui/src-tauri/src/db.rs  (modify — adjust commit SELECT; exact filename per current source)
- packages/ui/src/__tests__/StepCard.test.tsx  (modify or create as a sanity wrapper)

## Test Strategy
```bash
pnpm --filter @agentgit/core build
pnpm --filter @agentgit/web-viewer build
pnpm --filter @agentgit/web-viewer test
pnpm --filter @agentgit/web-viewer typecheck
pnpm --filter @agentgit/ui test
pnpm --filter @agentgit/ui typecheck
```
The Tauri Rust portion is not built in CI (release.yml owns that), so verify the Rust change locally by running `pnpm --filter @agentgit/ui build:tauri` on a machine with the Tauri toolchain installed.
