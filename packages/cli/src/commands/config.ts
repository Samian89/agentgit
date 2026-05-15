import { getConfigValue, loadConfig, saveConfig, setConfigValue } from "@agentgit/core";

export interface ConfigCommandOptions {
  /** When true, print the entire config as JSON to stdout. */
  list?: boolean;
}

/**
 * `agentgit config <key> [value]`
 *   - With value:    set the value and persist.
 *   - Without value: print the current value (or empty + exit 1 if unset).
 *   - With --list:   pretty-print the full config.
 *
 * Keys are dot-paths into the JSON config (e.g. `user.name`).
 */
export function configCommand(
  agentgitDir: string,
  key: string | undefined,
  value: string | undefined,
  options: ConfigCommandOptions = {},
): number {
  if (options.list) {
    const config = loadConfig(agentgitDir);
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return 0;
  }

  if (!key) {
    console.error("usage: agentgit config <key> [value]   |   agentgit config --list");
    return 1;
  }

  const config = loadConfig(agentgitDir);

  if (value === undefined) {
    const got = getConfigValue(config, key);
    if (got === undefined) return 1;
    process.stdout.write(got + "\n");
    return 0;
  }

  setConfigValue(config, key, value);
  saveConfig(agentgitDir, config);
  return 0;
}
