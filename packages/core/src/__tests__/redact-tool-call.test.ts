import { describe, expect, it } from "vitest";
import { buildRedactor, redactToolCall } from "../redact.js";
import type { ToolCall } from "../types.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_ID = "tool-1234-uuid";

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: overrides.id ?? FIXED_ID,
    name: overrides.name ?? "search",
    input: overrides.input ?? { q: "find sk-ABCDEF123456" },
    output: overrides.output ?? { results: ["hit with sk-XYZ"] },
    startedAt: overrides.startedAt ?? FIXED_NOW,
    completedAt: overrides.completedAt ?? FIXED_NOW + 7,
    status: overrides.status ?? "success",
    error: overrides.error ?? null,
    ...overrides,
  };
}

describe("redactToolCall", () => {
  it("redacts input JSON strings and output strings, preserving structure", () => {
    const redact = buildRedactor({ redactPatterns: ["sk-[A-Z0-9]+"] })!;
    const tc = makeToolCall();
    const red = redactToolCall(tc, redact)!;

    expect(red.input.q).toBe("find [REDACTED]");
    expect(red.output).toEqual({ results: ["hit with [REDACTED]"] });
    expect(red.name).toBe("search"); // unchanged
  });

  it("round-trips non-string output (objects, arrays) via JSON.stringify→redact→parse", () => {
    const redact = buildRedactor({ redactPatterns: ["secret"] })!;
    const tc = makeToolCall({
      input: { data: { token: "secret123" } },
      output: ["a", { nested: "secret-value" }, 42, true, null],
    });
    const red = redactToolCall(tc, redact)!;

    expect(red.input).toEqual({ data: { token: "[REDACTED]123" } });
    expect(red.output).toEqual(["a", { nested: "[REDACTED]-value" }, 42, true, null]);
  });

  it("redacts string output directly (no extra quotes)", () => {
    const redact = buildRedactor({ redactPatterns: ["sk-"] })!;
    const tc = makeToolCall({ output: "result sk-123" });
    const red = redactToolCall(tc, redact)!;
    expect(red.output).toBe("result [REDACTED]123");
  });

  it("redacts tool error field", () => {
    const redact = buildRedactor({ redactPatterns: ["password=\\S+"] })!;
    const tc = makeToolCall({
      status: "error",
      error: "failed password=supersecret123",
      output: null,
    });
    const red = redactToolCall(tc, redact)!;
    expect(red.error).toBe("failed [REDACTED]");
  });

  it("returns null / unchanged when no redactor or no tc", () => {
    expect(redactToolCall(null, null)).toBeNull();
    const tc = makeToolCall();
    expect(redactToolCall(tc, null)).toBe(tc);
  });
});
