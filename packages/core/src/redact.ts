import type { LlmCall, LlmMessage, ToolCall } from "./types.js";
import type { LlmRedactionConfig } from "./config.js";

/**
 * Validate redactPatterns at Repository.init time. Throws with a clear message
 * naming the offending pattern if any source is not a valid ECMAScript regex.
 */
export function validateRedactionPatterns(
  patterns: string[] | undefined,
  configPathForError?: string,
): void {
  if (!patterns || patterns.length === 0) return;
  for (const p of patterns) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(p, "g");
    } catch (e) {
      const loc = configPathForError ? ` in ${configPathForError}` : "";
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Invalid regex pattern${loc} in llm.redaction.redactPatterns: "${p}" — ${msg}`,
      );
    }
  }
}

/**
 * Build a redactor function from config, or null if redaction is disabled / no patterns.
 * Compiles patterns once. Throws on invalid regex (defensive; init should have caught).
 */
export function buildRedactor(
  cfg: LlmRedactionConfig | undefined,
): ((s: string) => string) | null {
  if (!cfg) return null;
  if (cfg.enabled === false) return null;
  const patterns = cfg.redactPatterns;
  if (!patterns || patterns.length === 0) return null;

  const placeholder = cfg.placeholder ?? "[REDACTED]";
  const regexes: RegExp[] = [];
  for (const p of patterns) {
    try {
      regexes.push(new RegExp(p, "g"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid regex in llm.redaction.redactPatterns: "${p}" — ${msg}`);
    }
  }

  return (s: string): string => {
    let out = s;
    for (const re of regexes) {
      out = out.replace(re, placeholder);
    }
    return out;
  };
}

/** Apply redaction to all text fields of an LlmCall (messages[].content, response, error). */
export function redactLlmCall(
  call: LlmCall | null,
  redact: ((s: string) => string) | null,
): LlmCall | null {
  if (!call || !redact) return call;
  return {
    ...call,
    messages: call.messages.map((m: LlmMessage) => ({
      ...m,
      content: redact(m.content),
    })),
    response: redact(call.response),
    error: call.error != null ? redact(call.error) : null,
  };
}

/**
 * Apply redaction to ToolCall:
 * - input: JSON.stringify → redact the JSON text → JSON.parse (preserves structure)
 * - output: if string, redact directly; if object/array, stringify→redact→parse to preserve structure
 * - error: redact if present
 */
export function redactToolCall(
  tc: ToolCall | null,
  redact: ((s: string) => string) | null,
): ToolCall | null {
  if (!tc || !redact) return tc;

  // Redact input (always a record)
  let redactedInput = tc.input;
  if (tc.input && typeof tc.input === "object") {
    const inputJson = JSON.stringify(tc.input);
    const redactedJson = redact(inputJson);
    try {
      redactedInput = JSON.parse(redactedJson) as Record<string, unknown>;
    } catch {
      redactedInput = tc.input; // defensive: keep original if parse fails (should not)
    }
  }

  // Redact output: preserve structure for objects/arrays via round-trip; strings direct
  let redactedOutput = tc.output;
  if (tc.output != null) {
    if (typeof tc.output === "string") {
      redactedOutput = redact(tc.output);
    } else if (typeof tc.output === "object" || Array.isArray(tc.output)) {
      const outJson = JSON.stringify(tc.output);
      const redactedJson = redact(outJson);
      try {
        redactedOutput = JSON.parse(redactedJson);
      } catch {
        redactedOutput = tc.output;
      }
    } else {
      // primitives (number, boolean) — no textual content to redact
      redactedOutput = tc.output;
    }
  }

  return {
    ...tc,
    input: redactedInput,
    output: redactedOutput,
    error: tc.error != null ? redact(tc.error) : null,
  };
}
