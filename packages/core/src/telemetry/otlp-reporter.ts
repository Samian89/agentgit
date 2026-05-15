import type { Reporter, Span } from "./reporter.js";

/**
 * Buffered OTLP/HTTP reporter. Flushes spans as a minimal OpenTelemetry trace
 * payload to `${endpoint}/v1/traces` using `fetch`. We hand-roll the payload
 * to keep `@opentelemetry/*` out of the default dependency tree — projects
 * that need richer OTel semantics can install the SDK and pass their own
 * {@link Reporter}.
 *
 * Failures are swallowed (telemetry must not break the host program).
 *
 * @beta
 */
export class OTLPReporter implements Reporter {
  private readonly buffer: Span[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly serviceName: string = "agentgit",
    private readonly flushIntervalMs: number = 1000,
  ) {
    if (!endpoint) {
      throw new Error("OTLPReporter requires a non-empty endpoint");
    }
  }

  recordSpan(span: Span): void {
    this.buffer.push(span);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const spans = this.buffer.splice(0, this.buffer.length);
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [kv("service.name", this.serviceName)] },
          scopeSpans: [
            {
              scope: { name: "agentgit", version: "0.1.0" },
              spans: spans.map((s) => toOtlpSpan(s)),
            },
          ],
        },
      ],
    };
    try {
      await fetch(`${this.endpoint.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Telemetry must never break the host program.
    }
  }
}

function kv(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function toOtlpSpan(span: { name: string; durationMs: number; attrs?: Record<string, unknown> }) {
  const endNs = BigInt(Math.floor(Date.now() * 1e6));
  const startNs = endNs - BigInt(Math.floor(span.durationMs * 1e6));
  return {
    name: span.name,
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    attributes: Object.entries(span.attrs ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => {
        if (typeof v === "number") return { key: k, value: { doubleValue: v } };
        if (typeof v === "boolean") return { key: k, value: { boolValue: v } };
        return { key: k, value: { stringValue: String(v) } };
      }),
  };
}
