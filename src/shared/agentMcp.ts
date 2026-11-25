/** Per-agent MCP servers, switched on the registry entry's `mcp` map and written into the
 *  agent's own CLI config at spawn: Codex's CODEX_HOME config.toml, Claude's --mcp-config
 *  file. agy reads only its global config, so it is not switchable per agent. */

/** The servers an agent can be given. `startupTimeoutSec` is Codex's
 *  `startup_timeout_sec`; keep it short for a server that depends on something the human
 *  may not have running. */
export const AGENT_MCP_SERVERS = {
  blender: { command: 'uvx', args: ['blender-mcp'], startupTimeoutSec: 10 }
} as const;

export type AgentMcpId = keyof typeof AGENT_MCP_SERVERS;
export type AgentMcp = Partial<Record<AgentMcpId, boolean>>;
export const AGENT_MCP_IDS = Object.keys(AGENT_MCP_SERVERS) as AgentMcpId[];

/** The known ids of a stored or submitted `mcp` map, booleans only; anything else is dropped. */
export function cleanAgentMcp(v: unknown): AgentMcp {
  const out: AgentMcp = {};
  if (!v || typeof v !== 'object') return out;
  for (const id of AGENT_MCP_IDS) {
    const on = (v as Record<string, unknown>)[id];
    if (typeof on === 'boolean') out[id] = on;
  }
  return out;
}

export function enabledAgentMcp(v: unknown): AgentMcpId[] {
  const m = cleanAgentMcp(v);
  return AGENT_MCP_IDS.filter((id) => m[id] === true);
}

/** Whether per-agent MCP servers can be attached for this provider. */
export function agentMcpSupported(provider: string | undefined): boolean {
  return provider === undefined || provider === 'claude' || provider === 'codex';
}

const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

/** The table path of a `[...]` header line, quotes removed, or null for a non-header. */
function tableHeader(line: string): string[] | null {
  const m = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return null;
  return m[1].split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => p.trim().replace(/^"(.*)"$/, '$1'));
}

/** The worker config.toml with each catalog server's `[mcp_servers.<id>]` table (and its
 *  subtables) replaced by ours when `enabled` lists it, and removed when it does not. A
 *  table inherited from the user's config.toml is replaced too, since TOML forbids it twice. */
export function setCodexMcpServers(cfg: string, enabled: readonly AgentMcpId[]): string {
  const lines = cfg.split('\n');
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const h = tableHeader(line);
    if (h) dropping = h[0] === 'mcp_servers' && h.length >= 2 && (AGENT_MCP_IDS as string[]).includes(h[1]);
    if (!dropping) kept.push(line);
  }
  let out = kept.join('\n');
  const tables = enabled.filter((id) => AGENT_MCP_SERVERS[id]).map((id) => {
    const s = AGENT_MCP_SERVERS[id];
    return `[mcp_servers.${tomlKey(id)}]\ncommand = ${JSON.stringify(s.command)}\nargs = ${JSON.stringify(s.args)}\nstartup_timeout_sec = ${s.startupTimeoutSec}`;
  });
  if (!tables.length) return out;
  const sep = out === '' || out.endsWith('\n') ? '' : '\n';
  out = `${out}${sep}\n${tables.join('\n\n')}\n`;
  return out;
}

/** Server names a Codex config.toml defines under `[mcp_servers.<name>]`. */
export function codexMcpServerNames(cfg: string): string[] {
  const out = new Set<string>();
  for (const line of cfg.split('\n')) {
    const h = tableHeader(line);
    if (h && h[0] === 'mcp_servers' && h.length >= 2) out.add(h[1]);
  }
  return [...out];
}

/** Codex's top-level `web_search` mode ("cached", "live" or "disabled"); null when unset,
 *  which Codex treats as cached. */
export function codexWebSearchMode(cfg: string): string | null {
  for (const line of cfg.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*web_search\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** Whether `codex features list` reports `feature` enabled. */
export function codexFeatureEnabled(listing: string, feature: string): boolean {
  return listing.split('\n').some((l) => {
    const cols = l.trim().split(/\s{2,}|\t+/);
    return cols[0] === feature && cols[cols.length - 1] === 'true';
  });
}

type ClaudeMcpServer = { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };

/** The `--mcp-config` file body for a Claude agent: the per-agent switches plus the
 *  default catalog servers (`catalog`, already probed), or null when it gets none. */
export function claudeMcpConfig(
  enabled: readonly AgentMcpId[],
  catalog: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
): { mcpServers: Record<string, ClaudeMcpServer> } | null {
  const mcpServers: Record<string, ClaudeMcpServer> = {};
  for (const [name, s] of Object.entries(catalog)) {
    mcpServers[name] = { type: 'stdio', command: s.command, args: [...s.args], ...(s.env ? { env: { ...s.env } } : {}) };
  }
  for (const id of enabled) {
    const s = AGENT_MCP_SERVERS[id];
    if (s) mcpServers[id] = { type: 'stdio', command: s.command, args: [...s.args] };
  }
  return Object.keys(mcpServers).length ? { mcpServers } : null;
}

export interface AgentToolsInput {
  provider: string;
  /** Codex: `image_generation` is on in `codex features list`. */
  imageGeneration?: boolean;
  /** Codex: the `web_search` mode, null when unset (cached). */
  webSearch?: string | null;
  mcpServers: string[];
  unity: boolean;
  skills: string[];
}

const MCP_NOTES: Record<string, string> = {
  blender: 'drives the human\'s open Blender through its add-on; when its tools fail, Blender is not open, so run Blender headless instead with `hive-blender -b` (on your PATH; it runs the Blender flatpak\'s own binary, since `flatpak` cannot start Blender inside the agent jail)'
};

/** The "tools you have" lines for an agent's identity prompt, built from what its spawn
 *  configured. Stable for a spawn, so it does not disturb the prompt cache. */
export function agentToolsLine(t: AgentToolsInput): string {
  const native: string[] = [];
  if (t.provider === 'codex') {
    if (t.imageGeneration) native.push('image generation');
    if (t.webSearch !== 'disabled') native.push(t.webSearch === 'live' ? 'web search (live)' : 'web search');
  }
  const lines = ['TOOLS YOU HAVE (as configured for this session):'];
  if (native.length) lines.push(`- Built in: ${native.join(', ')}.`);
  if (t.mcpServers.length) {
    lines.push(`- MCP servers: ${t.mcpServers.map((n) => (MCP_NOTES[n] ? `${n} (${MCP_NOTES[n]})` : n)).join('; ')}.`);
  }
  if (t.unity) lines.push('- Unity batch runs through the harness broker (see UNITY above).');
  if (t.skills.length) lines.push(`- Skills: ${[...t.skills].sort().join(', ')}.`);
  return lines.length > 1 ? lines.join('\n') : '';
}
