import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Author } from "./types.js";

/**
 * Shape of the optional `guards` section in `.agentgit/config.json`.
 * Lets a project tune the default `ConfirmationGuard` + `SnapshotGuard`
 * without writing code: tweak destructive-tool lists, add patterns that
 * skip the prompt (autoConfirm/allowlist), or hard-block matching tool
 * names or input strings (denylist).
 */
export interface GuardsConfig {
  /** Master switch: when false, no default guards run. */
  enabled?: boolean;
  confirmation?: {
    enabled?: boolean;
    /** Tool names treated as destructive (overrides the built-in list). */
    destructiveTools?: string[];
    /** Tool names or input substrings that bypass the prompt and are allowed. */
    allowlist?: string[];
    /** Tool names or input substrings that are unconditionally blocked. */
    denylist?: string[];
    /** Tool names or input substrings that are auto-confirmed (no prompt). */
    autoConfirm?: string[];
  };
  snapshot?: {
    enabled?: boolean;
    /** Tool names whose inputs are snapshotted before execution. */
    writeTools?: string[];
    /** Skip snapshotting files larger than this (bytes). */
    maxBlobBytes?: number;
  };
}

/**
 * Opt-in telemetry config. No spans are emitted unless `enabled === true`.
 * Reporters receive span names + durations + benign attributes only.
 */
export interface TelemetryConfigShape {
  /** Master switch — default `false`. */
  enabled?: boolean;
  /** Reporter implementation — default `"console"`. */
  reporter?: "console" | "otlp";
  /** OTLP endpoint (required for `reporter: "otlp"`). */
  endpoint?: string;
  /** Optional service-name attribute. */
  serviceName?: string;
}

/**
 * Optional redaction config under `llm.redaction` in `.agentgit/config.json`.
 * When `redactPatterns` are provided, matching substrings in LLM messages/response
 * (and tool call I/O when `includeToolCalls` is not false) are replaced by the
 * placeholder **before** the commit is hashed and persisted.
 */
export interface LlmRedactionConfig {
  /** Master switch; default true when redactPatterns are present. */
  enabled?: boolean;
  /** ECMAScript regex source strings (e.g. "sk-[A-Za-z0-9]+"). Invalid patterns throw on Repository.init. */
  redactPatterns?: string[];
  /** Replacement text for matches. Default "[REDACTED]". */
  placeholder?: string;
  /** Apply redaction to ToolCall.input/output JSON strings too. Default true. */
  includeToolCalls?: boolean;
}

/** Shape of `.agentgit/config.json`. */
export interface AgentGitConfig {
  user?: Partial<Author>;
  signing?: {
    /** Master switch — when false, commits are not signed even if keys are present. */
    enabled?: boolean;
    /** Base64-encoded raw Ed25519 private key (32 bytes). */
    privateKey?: string;
    /** Base64-encoded raw Ed25519 public key (32 bytes). */
    publicKey?: string;
  };
  guards?: GuardsConfig;
  telemetry?: TelemetryConfigShape;
  llm?: { redaction?: LlmRedactionConfig };
  [key: string]: unknown;
}

export function configPath(agentgitDir: string): string {
  return join(agentgitDir, "config.json");
}

export function loadConfig(agentgitDir: string): AgentGitConfig {
  const path = configPath(agentgitDir);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as AgentGitConfig;
}

export function saveConfig(agentgitDir: string, config: AgentGitConfig): void {
  const path = configPath(agentgitDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Resolve the committer identity from config, returning null when neither
 * name nor email is present. Both fields must be set for the identity to be
 * recorded on commits.
 */
export function resolveAuthor(config: AgentGitConfig): Author | null {
  const user = config.user;
  if (!user || !user.name || !user.email) return null;
  return { name: user.name, email: user.email };
}

/**
 * Set a dotted config key — e.g. ("user.name", "Alice"). The key is split on
 * '.' and traversed; intermediate objects are created as needed.
 */
export function setConfigValue(
  config: AgentGitConfig,
  key: string,
  value: string,
): AgentGitConfig {
  const parts = key.split(".");
  if (parts.length === 0 || parts.some((p) => p === "")) {
    throw new Error(`Invalid config key: '${key}'`);
  }
  let cursor: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = cursor[part];
    if (next === undefined || next === null || typeof next !== "object") {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return config;
}

/** Read a dotted config key. Returns undefined when any segment is missing. */
export function getConfigValue(
  config: AgentGitConfig,
  key: string,
): string | undefined {
  const parts = key.split(".");
  let cursor: unknown = config;
  for (const p of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  if (cursor === undefined || cursor === null) return undefined;
  return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
}
