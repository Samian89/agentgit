import { loadConfig, saveConfig, type AgentGitConfig } from "@agentgit/core";

export interface RemoteRecord {
  url: string;
  token?: string;
}

export interface RemotesMap {
  [name: string]: RemoteRecord;
}

function getRemotes(config: AgentGitConfig): RemotesMap {
  const r = (config as Record<string, unknown>)["remotes"];
  if (r === undefined || r === null || typeof r !== "object") return {};
  return r as RemotesMap;
}

function setRemotes(config: AgentGitConfig, remotes: RemotesMap): AgentGitConfig {
  (config as Record<string, unknown>)["remotes"] = remotes;
  return config;
}

export function getRemote(agentgitDir: string, name: string): RemoteRecord | null {
  const config = loadConfig(agentgitDir);
  const remotes = getRemotes(config);
  return remotes[name] ?? null;
}

export interface RemoteAddOptions {
  token?: string;
}

/** `agentgit remote add <name> <url> [--token=...]` */
export function remoteAddCommand(
  agentgitDir: string,
  name: string,
  url: string,
  options: RemoteAddOptions = {},
): number {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error(`remote add: invalid remote name '${name}'`);
    return 1;
  }
  if (!/^https?:\/\//.test(url)) {
    console.error(`remote add: URL must start with http(s):// (got '${url}')`);
    return 1;
  }
  const config = loadConfig(agentgitDir);
  const remotes = getRemotes(config);
  if (remotes[name]) {
    console.error(`remote add: '${name}' already exists`);
    return 1;
  }
  const record: RemoteRecord = options.token
    ? { url, token: options.token }
    : { url };
  remotes[name] = record;
  saveConfig(agentgitDir, setRemotes(config, remotes));
  process.stdout.write(`Added remote '${name}' → ${url}\n`);
  return 0;
}

/** `agentgit remote list` */
export function remoteListCommand(agentgitDir: string): number {
  const remotes = getRemotes(loadConfig(agentgitDir));
  const names = Object.keys(remotes).sort();
  if (names.length === 0) {
    process.stdout.write("(no remotes)\n");
    return 0;
  }
  for (const name of names) {
    const r = remotes[name]!;
    const flagged = r.token ? " [token]" : "";
    process.stdout.write(`${name}\t${r.url}${flagged}\n`);
  }
  return 0;
}

/** `agentgit remote remove <name>` */
export function remoteRemoveCommand(agentgitDir: string, name: string): number {
  const config = loadConfig(agentgitDir);
  const remotes = getRemotes(config);
  if (!remotes[name]) {
    console.error(`remote remove: '${name}' not found`);
    return 1;
  }
  delete remotes[name];
  saveConfig(agentgitDir, setRemotes(config, remotes));
  process.stdout.write(`Removed remote '${name}'\n`);
  return 0;
}
