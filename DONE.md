# AMC-a386817b — Full Implementation Audit (rev 5)

## What was built

A complete end-to-end audit of the AgentGit implementation across all 7 areas. Seven bugs were found and fixed across four review cycles. This cycle confirms all fixes are in place and all tests pass.

---

## Status of all three reviewer-flagged issues

### Review 1 — `_SCHEMA_DDL` divergence (cycle 4, confirmed fixed)

`adapters/python/agentgit_adapter/adapter.py` `_SCHEMA_DDL` now matches the canonical TypeScript schema exactly:

| What was wrong | What it is now |
|---|---|
| `blobs.encoding DEFAULT 'utf-8'` | `DEFAULT 'base64'` |
| No `CHECK` on `blobs.encoding` | `CHECK (encoding IN ('base64', 'utf-8'))` |
| No `CHECK` on `refs.type` | `CHECK (type IN ('branch', 'tag', 'session-head'))` |
| `sessions.head` — bare `TEXT` | `REFERENCES commits(hash) ON DELETE SET NULL` |
| `commits.parent` — bare `TEXT` | `REFERENCES commits(hash) ON DELETE RESTRICT` |
| `commits.session_id` — no FK | `REFERENCES sessions(id) ON DELETE CASCADE` |
| `refs.target` — no FK | `REFERENCES commits(hash) ON DELETE RESTRICT` |
| `tree_entries.blob_hash` — no FK | `REFERENCES blobs(hash) ON DELETE RESTRICT` |
| No indexes | All 7 `CREATE INDEX IF NOT EXISTS` statements added |
| `_db()` only set `journal_mode=WAL` | Also sets `PRAGMA foreign_keys=ON` |
| Fallback init only set `journal_mode=WAL` | Also sets `PRAGMA foreign_keys=ON` |

`AgentGitCallbackHandler._db()` in `handler.py` also had `foreign_keys=ON` added.

### Review 2 — LangChain structured tool input (cycle 3, confirmed fixed)

`on_tool_start` now calls `_parse_tool_input(input_str, kwargs)` which:
1. Returns `kwargs["inputs"]` if it is a `dict` (newer LangChain API)
2. JSON-parses `input_str` and returns it if it deserializes to a `dict`
3. Falls back to `{"input": input_str}` for plain strings

Verified by `test_tool_call_json_object_input_preserved` and `test_tool_call_kwargs_inputs_takes_priority`.

### Review 3 — `agentgit diff` short-hash resolution (cycle 2, confirmed fixed)

`SqliteIndex.resolveHash(prefix)` added; wired into `diffCommand` and `checkoutCommand`. Users can pass the 12-char short hash shown by `agentgit log` directly to `agentgit diff` and `agentgit checkout`.

---

## Full audit verdict

| Area | Result |
|---|---|
| Content-addressing correctness | ✅ Pass — recursive canonical JSON, SHA-256, hash field stripped before digest |
| SQLite migration safety | ✅ Pass — all DDL idempotent (`IF NOT EXISTS`); WAL + FK pragmas on every open |
| Safety guard coverage | ✅ Fixed — `DEFAULT_DESTRUCTIVE_TOOLS` covers `bash`, `Bash`, `exec`, `run_bash`, `delete_file`, and other framework tool names |
| TypeScript strict-mode compliance | ✅ Fixed — UI tsconfig `module`/`moduleResolution` conflict resolved; null guard added in `checkout.ts`; zero `any` types |
| Python adapter serialization fidelity | ✅ Fixed — `completedAt` (not `finishedAt`); structured JSON input preserved; `_SCHEMA_DDL` matches canonical schema |
| Tauri IPC surface | ✅ Pass — parameterized queries throughout; no shell execution; capabilities restricted |
| Docs quickstart completeness | ✅ Fixed — 12-char hashes; correct timestamp format; short-hash diff/checkout now works |

---

## Files changed (all cycles)

| File | Change |
|---|---|
| `packages/ui/tsconfig.json` | Added `"module": "ESNext"`; removed `"rootDir"` |
| `packages/core/src/guards/confirmation-guard.ts` | Expanded `DEFAULT_DESTRUCTIVE_TOOLS` |
| `packages/core/src/sqlite-index.ts` | Added `resolveHash(prefix)` |
| `packages/core/dist/` | Rebuilt to expose `resolveHash` declaration |
| `packages/cli/src/commands/diff.ts` | Calls `resolveHash` for both hashes |
| `packages/cli/src/commands/checkout.ts` | Calls `resolveHash`; null guard on `getCommit` result |
| `adapters/python/agentgit_adapter/adapter.py` | `_SCHEMA_DDL` aligned to canonical; `foreign_keys=ON` added to `_db()` and fallback init |
| `adapters/langchain/agentgit_langchain/handler.py` | `_parse_tool_input()`; `completedAt` (not `finishedAt`); `foreign_keys=ON` in `_db()` |
| `adapters/langchain/tests/test_handler.py` | Added structured-input and `kwargs["inputs"]` tests |
| `docs/quickstart.md` | Corrected hash length and timestamp format |

---

## Test results

```
pnpm typecheck            →  0 errors (core, cli, sdk, ui)
pnpm test:integration     →  4/4 pass
packages/core unit tests  →  117/117 pass (7 files)
pytest adapters/python    →  29/29 pass
pytest adapters/langchain →  20/20 pass
```

## APIs / types / interfaces other tickets may consume

- **`SqliteIndex.resolveHash(prefix: string): Hash | null`** (`@agentgit/core`) — full or abbreviated hash lookup; throws on ambiguous prefix
- **`_SCHEMA_DDL`** in Python adapter — now byte-for-byte equivalent to TypeScript canonical schema; DBs created without the CLI are fully interoperable
- `ToolCall.completedAt` — confirmed canonical field name across all adapters
- `ToolCall.input` — always a true `Record<string, unknown>` for LangChain-originated commits
- `ConfirmationGuard` default destructive-tool list covers all major agent framework variants
