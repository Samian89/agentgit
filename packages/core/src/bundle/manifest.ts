/**
 * `.agentgit-bundle` manifest schema.
 *
 *   formatVersion — the bundle layout itself. Bumping requires a documented
 *                   migration path in the bundle loader.
 *   schemaVersion — the SQLite schema version of the source repo. A client
 *                   refuses to import a bundle whose schemaVersion is higher
 *                   than its own TARGET_VERSION.
 */
export const BUNDLE_FORMAT_VERSION = 1;

export interface BundleManifest {
  formatVersion: number;
  schemaVersion: number;
  sessionIds: string[];
  createdAt: number;
  generator: string;
}
