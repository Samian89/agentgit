# Optional Sensitive-Data Redaction for LLM Captures

## Goal
Add an opt-in `llm.redactPatterns: string[]` field to `.agentgit/config.json` whose regex (or substring) patterns are applied to every LLM `messages[i].content`, `response`, and tool input/output **before** the commit is hashed and persisted. Redaction is deterministic and visible in the resulting `llmCall` (matches are replaced by `[REDACTED]`), so the audit log keeps structure while keeping secrets out of the content-addressed store.

## Context
- `.agentgit/config.json` is loaded via `loadConfig` at `packages/core/src/config.ts:70-76`. The `AgentGitConfig` interface (lines 51–64) is the documented shape; today it includes `user`, `signing`, `guards`, and `telemetry`. Adding a `llm` section keeps the pattern consistent.
- `Repository.recordLlmCall` (added by spec 001) is the single funnel for LLM commits from the SDK and adapters. Applying redaction inside this method covers all writers. For tool calls, `Repository.commit` already takes a `toolCall` payload — redaction needs to apply there too when `redactPatterns` is configured for tools.
- Redaction must happen *before* `objects.write(commitBody)` so the hash reflects the redacted content. Hashing the un-redacted payload first and then storing a redacted version would break the content-addressed invariant.
- The privacy contract in `packages/core/src/telemetry/reporter.ts:8-23` explicitly bans user data from leaving the process through telemetry. Redaction is **about persisted storage**, not telemetry — telemetry already never sees prompt/response text. The two concerns are independent; do not couple them.
- The Python adapter family (spec 005) has its own `_record_commit` path. To keep cross-language hashes identical, both implementations must use the same regex syntax (ECMAScript-compatible) and the same redaction sentinel string `[REDACTED]`. Python uses `re.compile(pattern)` with the same source string.

## Technical Approach
1. **Config shape** in `packages/core/src/config.ts`:
   ```ts
   export interface LlmRedactionConfig {
     enabled?: boolean;       // master switch; default true if redactPatterns set
     redactPatterns?: string[]; // ECMAScript regex sources
     placeholder?: string;    // default "[REDACTED]"
     /** Apply to tool call input/output JSON strings too. Default true. */
     includeToolCalls?: boolean;
   }

   export interface AgentGitConfig {
     ...existing fields...
     llm?: { redaction?: LlmRedactionConfig };
   }
   ```
   Export from `packages/core/src/index.ts`.
2. **Redactor module** at `packages/core/src/redact.ts`:
   ```ts
   export function buildRedactor(cfg: LlmRedactionConfig | undefined):
     ((s: string) => string) | null;
   ```
   - Compiles each pattern once (`new RegExp(p, "g")`). Invalid patterns throw at construction with a clear error so misconfig surfaces early.
   - Returns `null` when redaction is disabled or no patterns are configured (callers short-circuit and skip the cost).
   - Provides `redactLlmCall(call, redact)` and `redactToolCall(tc, redact)` helpers that apply the redactor to the canonical text fields:
     - LlmCall: every `messages[i].content`, `response`, and `error`.
     - ToolCall: `JSON.stringify(input)` → re-parse, `String(output)`, `error`.
3. **Hook into Repository**:
   - `Repository` ctor stays the same, but `commit()` (`packages/core/src/repository.ts:171`) loads `config.llm?.redaction` (use the already-loaded `config` at line 190 — no extra disk read) and constructs a redactor.
   - If the redactor is non-null and `toolCall !== null`, replace `toolCall = redactToolCall(toolCall, redact)` before building the commit body. Same treatment for the new `llmCall` parameter.
   - Hashing happens after redaction, so the content-addressed store never sees the unredacted bytes.
4. **Python mirror** in `adapters/python/agentgit_adapter/adapter.py`:
   - Read `config["llm"]["redaction"]` in `_record_commit`.
   - Apply Python `re.compile(pattern).sub(placeholder, text)` over the same fields.
   - Keep the placeholder default `[REDACTED]` so cross-language hashes match.
   - Re-use the same logic in `agentgit_langchain/handler.py` either by importing the helper or by replicating it (mirror with the same `re.compile` and placeholder default).
5. **Validation**:
   - Reject invalid regex sources via a clear error message including the offending pattern and config path. Surface during `Repository.init` so misconfig fails fast on first open rather than mid-session.
   - Document compatibility caveats: ES regex `\u{...}` and named groups may differ slightly from Python — recommend ASCII patterns for cross-language portability.
6. **Tests**:
   - `packages/core/src/__tests__/redact.test.ts` — patterns applied to LlmCall.response and messages produce expected replacement; toolCall input/output redacted; same commit hash regardless of whether redaction was applied at write time or input was already pre-redacted (regression: idempotent).
   - `packages/core/src/__tests__/redact-tool-call.test.ts` — non-string output values (objects, arrays) round-trip through JSON-stringify→redact→JSON.parse without losing structure.
   - `adapters/python/tests/test_redaction.py` — Python applies the same patterns and produces a byte-identical commit hash to the TS reference for a shared fixture.
   - Mis-config (`["[invalid"]`) throws on `Repository.init`.
7. **Docs**: add a "Redaction" subsection to `docs/safety-guards.md` (it already documents guard configuration) explaining `llm.redaction.redactPatterns`, placeholder default, regex compatibility caveats, and a worked example (`(?i)sk-[A-Za-z0-9]{20,}` to scrub OpenAI keys).

## Acceptance Criteria
- [ ] `.agentgit/config.json` with `"llm": { "redaction": { "redactPatterns": ["sk-[A-Za-z0-9]+"] } }` causes any subsequent `Repository.recordLlmCall` or `Repository.commit` invocation to substitute `[REDACTED]` for matching substrings in `messages[i].content`, `response`, and (when `includeToolCalls !== false`) tool call input/output JSON.
- [ ] The commit hash is computed from the redacted payload, so re-reading the commit via `getCommit(hash)` returns the redacted text and the object file on disk contains only the redacted text.
- [ ] An invalid regex in `redactPatterns` causes `Repository.init` to throw with a message naming the offending pattern.
- [ ] The Python adapter applies the same patterns and produces a byte-identical canonical-JSON hash to the TS implementation for a shared test fixture.
- [ ] `pnpm --filter @agentgit/core test` and `python -m pytest adapters/python -q -k redact` pass.

## Files to Touch
- packages/core/src/config.ts  (modify — add LlmRedactionConfig)
- packages/core/src/index.ts  (modify — export new types)
- packages/core/src/redact.ts  (create)
- packages/core/src/repository.ts  (modify — apply redactor in commit())
- packages/core/src/__tests__/redact.test.ts  (create)
- packages/core/src/__tests__/redact-tool-call.test.ts  (create)
- adapters/python/agentgit_adapter/adapter.py  (modify — apply redactor in _record_commit)
- adapters/python/tests/test_redaction.py  (create)
- docs/safety-guards.md  (modify — add Redaction subsection)

## Test Strategy
```bash
pnpm --filter @agentgit/core test
python -m pytest adapters/python -q -k redact
```
A cross-language hash fixture in `packages/core/src/__tests__/fixtures/redacted-llm-call.json` is consumed by both test suites to guarantee byte-identical canonical-JSON output.
