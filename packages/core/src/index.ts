export type {
  Hash,
  Timestamp,
  Blob,
  TreeEntry,
  Tree,
  ToolCallStatus,
  ToolCall,
  Author,
  Commit,
  RefType,
  Ref,
  SessionStatus,
  Session,
  DiffEntry,
  StepDiff,
} from "./types.js";

export { canonicalJson, sha256 } from "./hash.js";
export { ObjectStore } from "./object-store.js";
export { CommitGraph } from "./commit-graph.js";
export { RefStore } from "./ref-store.js";
export { SqliteIndex } from "./sqlite-index.js";
export { Repository } from "./repository.js";
export type { StateEntry, CommitInput } from "./repository.js";

export {
  MIGRATIONS,
  TARGET_VERSION,
  getCurrentVersion,
  pendingMigrations,
  migrationStatus,
  runMigrations,
  openRawIndexDb,
} from "./migrations/index.js";
export type { Migration, MigrationStatus } from "./migrations/index.js";

export {
  configPath,
  loadConfig,
  saveConfig,
  resolveAuthor,
  setConfigValue,
  getConfigValue,
} from "./config.js";
export type { AgentGitConfig, GuardsConfig } from "./config.js";

export { generateKeyPair, signMessage, verifyMessage } from "./signing.js";
export type { Ed25519KeyPair } from "./signing.js";

export {
  BUNDLE_FORMAT_VERSION,
  pack as packBundle,
  unpack as unpackBundle,
  readTar,
  writeTar,
  createBundleFile,
  importBundleFile,
} from "./bundle/index.js";
export type {
  BundleManifest,
  PackInput,
  PackResult,
  UnpackOptions,
  UnpackResult,
  TarEntry,
  CreateBundleOptions,
  ImportBundleOptions,
  ImportBundleResult,
} from "./bundle/index.js";

export type {
  Guard,
  GuardContext,
  GuardOutcome,
  GuardResult,
  GuardConfig,
  PromptFn,
  ReadFileFn,
} from "./guards/index.js";
export { ConfirmationGuard } from "./guards/index.js";
export type { ConfirmationGuardOptions } from "./guards/index.js";
export { SnapshotGuard } from "./guards/index.js";
export type { SnapshotGuardOptions } from "./guards/index.js";
export { GuardRegistry } from "./guards/index.js";
export {
  loadGuards,
  loadGuardsFromFile,
  buildDefaultGuards,
} from "./guards/index.js";
