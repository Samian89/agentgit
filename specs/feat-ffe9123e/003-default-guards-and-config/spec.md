# Default-Safe Guards + Repository Config File

## Goal
Make `wrapAgentJS(agent)` and its Python/LangChain equivalents safe by default: the two existing guards (`ConfirmationGuard`, `SnapshotGuard`) are applied automatically with opt-out, and a new `.agentgit/config.json` provides guard allowlist/denylist/auto-confirm settings shared across CLI, SDK, and adapters.

## Context
- `packages/sdk/src/wrap.ts` calls `new GuardRegistry(options?.guards ?? [])` — passing no `guards` yields an *empty* registry, so destructive tool calls like `bash("rm -rf /")` are recorded but not intercepted.
- The guards themselves are complete: `packages/core/src/guards/confirmation-guard.ts` (~17 destructive-tool name variants), `snapshot-guard.ts` (snapshots prior file content for write tools).
- `loadGuards` / `loadGuardsFromFile` already exist in `packages/core/src/guards/load-guards.ts` — config-driven loading is partially in place, but no canonical config file location is fixed.
- Python adapter (`adapters/python/agentgit_adapter/adapter.py`) currently takes no guards. LangChain handler does not run guards either.
- Spec 002 adds `.agentgit/config.json` for user identity; this spec extends the same file with `guards` settings.

## Technical Approach
1. **Default guards in `wrapAgentJS`**
   - If `options.guards` is `undefined`, apply `[new ConfirmationGuard(...), new SnapshotGuard(...)]` with defaults sourced from `.agentgit/config.json` (allowlist/denylist/auto-confirm patterns).
   - If `options.guards === false`, apply none (explicit opt-out).
   - If `options.guards` is an array, apply that array verbatim (full override).
2. **`.agentgit/config.json` schema (extension of spec 002's file)**
   ```json
   {
     "user": { "name": "...", "email": "..." },
     "signing": { ... },
     "guards": {
       "enabled": true,
       "confirmation": {
         "allowlist": ["echo", "ls"],
         "denylist": ["rm -rf"],
         "autoConfirm": ["git status"]
       },
       "snapshot": { "enabled": true, "maxBlobBytes": 10485760 }
     }
   }
   ```
3. **Config loader (`packages/core/src/config.ts`)**
   - `loadConfig(agentgitDir): AgentGitConfig` — merges `.agentgit/config.json` over `~/.agentgitconfig`.
   - Schema-validated with `zod` or hand-rolled validator (prefer zero deps to keep core lean).
4. **Python parity**
   - Add `guards` parameter to `AgentWrapper.__init__` with the same default-on semantics.
   - Load `.agentgit/config.json` in `adapter.py` and translate to the Python guard equivalents (port `ConfirmationGuard` and `SnapshotGuard` to Python in `adapters/python/agentgit_adapter/guards/`).
5. **LangChain parity**
   - `AgentGitCallbackHandler` gains a `guards` kwarg, defaults to the same pair, evaluated in `on_tool_start`.
6. **Tests**
   - New test: a naive `wrapAgentJS(agent)` (no options) calling `agent.bash("rm -rf /tmp/x")` must throw a "blocked by guard" error.
   - Existing tests that *relied* on the empty-default behaviour are updated to either pass `{ guards: false }` or to expect the guarded path.
   - Python equivalent test.

## Acceptance Criteria
- [ ] `wrapAgentJS(agent)` with no options applies `ConfirmationGuard` + `SnapshotGuard` by default.
- [ ] `wrapAgentJS(agent, { guards: false })` applies no guards.
- [ ] `wrapAgentJS(agent, { guards: [customGuard] })` applies exactly the provided array.
- [ ] A new unit test invokes `agent.bash("rm -rf /")` on a naive wrap and asserts the call is blocked.
- [ ] `.agentgit/config.json` `guards` block overrides defaults (e.g. adding an `autoConfirm` entry suppresses the prompt for that tool).
- [ ] `AgentWrapper(agent)` in Python defaults to the same two guards; opt-out via `guards=False`.
- [ ] `AgentGitCallbackHandler()` defaults to the same two guards; opt-out via `guards=False`.
- [ ] All existing 117 core + 4 CLI + 29 Python + 20 LangChain tests still pass (updated where they relied on un-guarded defaults).

## Files to Touch
- packages/sdk/src/wrap.ts  (modify — default guard composition)
- packages/sdk/src/types.ts  (modify — WrapOptions.guards: Guard[] | false | undefined)
- packages/core/src/config.ts  (create — config loader + types)
- packages/core/src/guards/confirmation-guard.ts  (modify — read config defaults)
- packages/core/src/guards/snapshot-guard.ts  (modify — read config defaults)
- packages/core/src/index.ts  (modify — export config loader)
- packages/sdk/src/__tests__/default-guards.test.ts  (create)
- adapters/python/agentgit_adapter/adapter.py  (modify)
- adapters/python/agentgit_adapter/guards/  (create — Python guard ports)
- adapters/python/tests/test_default_guards.py  (create)
- adapters/langchain/agentgit_langchain/handler.py  (modify — guards default)
- adapters/langchain/tests/test_default_guards.py  (create)

## Test Strategy
- `pnpm test` and `pytest` in both adapter dirs.
- New tests prove default-on safety.
- Update CLI integration tests to cover `.agentgit/config.json` round-trip via `agentgit config`.
