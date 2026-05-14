import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentGitConfig, GuardsConfig } from "../config.js";
import type { ObjectStore } from "../object-store.js";
import { ConfirmationGuard } from "./confirmation-guard.js";
import type { ConfirmationGuardOptions } from "./confirmation-guard.js";
import { SnapshotGuard } from "./snapshot-guard.js";
import type { SnapshotGuardOptions } from "./snapshot-guard.js";
import { GuardRegistry } from "./registry.js";
import type { Guard, GuardConfig } from "./types.js";

/** Build a GuardRegistry from an explicit (legacy) config object. */
export function loadGuards(
  config: GuardConfig,
  objectStore?: ObjectStore,
): GuardRegistry {
  const guards: Guard[] = [];

  if (config.confirmationGuard?.enabled !== false) {
    const confirmOpts: ConfirmationGuardOptions = {};
    const destructiveTools = config.confirmationGuard?.destructiveTools;
    if (destructiveTools !== undefined) {
      confirmOpts.destructiveTools = destructiveTools;
    }
    guards.push(new ConfirmationGuard(confirmOpts));
  }

  if (config.snapshotGuard?.enabled !== false && objectStore !== undefined) {
    const snapshotOpts: SnapshotGuardOptions = { objectStore };
    const writeTools = config.snapshotGuard?.writeTools;
    if (writeTools !== undefined) {
      snapshotOpts.writeTools = writeTools;
    }
    guards.push(new SnapshotGuard(snapshotOpts));
  }

  return new GuardRegistry(guards);
}

/**
 * Load guards from .agentgit/config.json.
 * Returns an empty registry if the file does not exist.
 *
 * Supports both the legacy top-level `confirmationGuard`/`snapshotGuard`
 * shape and the new `guards: { confirmation, snapshot }` nested shape.
 */
export function loadGuardsFromFile(
  agentgitDir: string,
  objectStore?: ObjectStore,
): GuardRegistry {
  const configPath = join(agentgitDir, "config.json");

  if (!existsSync(configPath)) {
    return new GuardRegistry([]);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;

  // New nested shape under `guards` takes priority when present.
  if (raw.guards !== undefined && raw.guards !== null) {
    return new GuardRegistry(
      buildDefaultGuards(raw as AgentGitConfig, objectStore),
    );
  }

  return loadGuards(raw as GuardConfig, objectStore);
}

/**
 * Construct the default-on guard chain (`ConfirmationGuard` + `SnapshotGuard`)
 * honoring whatever is set under `config.guards`.
 *
 * If `config.guards.enabled === false`, returns an empty array.
 * If `config.guards.confirmation.enabled === false`, ConfirmationGuard is omitted.
 * If `config.guards.snapshot.enabled === false`, SnapshotGuard is omitted.
 * SnapshotGuard is also omitted when no objectStore is provided.
 */
export function buildDefaultGuards(
  config: AgentGitConfig | undefined,
  objectStore?: ObjectStore,
): Guard[] {
  const g: GuardsConfig | undefined = config?.guards;
  if (g?.enabled === false) return [];

  const guards: Guard[] = [];

  if (g?.confirmation?.enabled !== false) {
    const confirmOpts: ConfirmationGuardOptions = {};
    if (g?.confirmation?.destructiveTools !== undefined) {
      confirmOpts.destructiveTools = g.confirmation.destructiveTools;
    }
    if (g?.confirmation?.allowlist !== undefined) {
      confirmOpts.allowlist = g.confirmation.allowlist;
    }
    if (g?.confirmation?.denylist !== undefined) {
      confirmOpts.denylist = g.confirmation.denylist;
    }
    if (g?.confirmation?.autoConfirm !== undefined) {
      confirmOpts.autoConfirm = g.confirmation.autoConfirm;
    }
    guards.push(new ConfirmationGuard(confirmOpts));
  }

  if (g?.snapshot?.enabled !== false && objectStore !== undefined) {
    const snapshotOpts: SnapshotGuardOptions = { objectStore };
    if (g?.snapshot?.writeTools !== undefined) {
      snapshotOpts.writeTools = g.snapshot.writeTools;
    }
    if (g?.snapshot?.maxBlobBytes !== undefined) {
      snapshotOpts.maxBlobBytes = g.snapshot.maxBlobBytes;
    }
    guards.push(new SnapshotGuard(snapshotOpts));
  }

  return guards;
}
