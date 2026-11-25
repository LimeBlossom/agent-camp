/**
 * Default MCP server catalog (Workstream 3). A dependency-free, importable-by-both
 * (main + renderer) registry of the MCP servers Munder Difflin can give each Claude
 * agent through its per-agent `--mcp-config` file. Keep it free of electron/UI/node
 * imports.
 *
 * Tiers gate consent:
 *   - 'safe-readonly' → no secret, no write. Only context7 ships ON: the others duplicate
 *                       Claude Code built-ins (extended thinking, `date`, WebFetch).
 *   - 'write'         → can mutate files or repos; OFF by default, consent-gated. MCP
 *                       write tools bypass hooks that match Bash/Write/Edit by name.
 *                       `filesystem`/`git` are scoped to the agent cwd at merge time.
 *   - 'secret'        → needs an API key / token / connection string; OFF by default,
 *                       consent-gated, and dropped while any required env is empty.
 *
 * `catalogMcpServers` does the merge; main then drops any server whose stdio handshake
 * fails (mcpProbe.ts) before writing the file.
 */

export type McpTier = 'safe-readonly' | 'write' | 'secret';

export interface McpCatalogEntry {
  /** Stable catalog id (also the consent key in `config.mcpDefaults`). The merge
   *  step namespaces the written server id (e.g. `munder-<id>`) to avoid clobbering
   *  a user's own `~/.claude` MCP server of the same name. */
  id: string;
  /** Human label for the consent UI. */
  label: string;
  /** One-line description for the consent UI / hire import preview. */
  description: string;
  /** The MCP stdio server launch spec. `filesystem`/`git` carry a placeholder cwd
   *  arg that Workstream 3 replaces with the agent cwd at merge time. */
  spec: {
    command: string;
    args: string[];
    /** Required env (e.g. an API token). Present only on write/secret entries; the
     *  value is supplied via consent, never hard-coded here. */
    env?: Record<string, string>;
  };
  tier: McpTier;
  /** Seed for `config.mcpDefaults[id].enabled`. Always === (tier === 'safe-readonly'). */
  defaultEnabled: boolean;
}

/** The default MCP bundle. Only context7 is ON; everything else is OFF until the user
 *  consents. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── Safe, read-only, no-secret ───────────────────────────────────────────
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversions.',
    spec: { command: 'uvx', args: ['mcp-server-time'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and return its content as markdown (read-only HTTP GET).',
    spec: { command: 'uvx', args: ['mcp-server-fetch'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date library/framework documentation lookups.',
    spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },

  // ─── Write / secret — shipped OFF, consent-gated ──────────────────────────
  {
    id: 'filesystem',
    label: 'Filesystem (cwd)',
    description: 'Read/edit files within the agent workspace only (scoped to cwd at spawn). Its write tools skip Bash/Write/Edit hooks.',
    // The trailing arg is the allowed root — Workstream 3 replaces this placeholder
    // with the agent cwd at merge time so it is NEVER whole-disk.
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<cwd>'] },
    tier: 'write',
    defaultEnabled: false
  },
  {
    id: 'git',
    label: 'Git (cwd)',
    description: 'Git status/log/diff plus commit, add, reset and checkout for the workspace repo (scoped to cwd at spawn). Its write tools skip Bash hooks.',
    // Exits at startup when the cwd is not a git repo, so the probe drops it there.
    spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '<cwd>'] },
    tier: 'write',
    defaultEnabled: false
  },
  {
    id: 'github-token',
    label: 'GitHub',
    description: 'Read/write GitHub issues, PRs, and repos. Requires a personal access token.',
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'db',
    label: 'Database',
    description: 'Query a SQL database. Requires a connection string.',
    // TODO-verify exact server package for the user's DB engine (Postgres assumed).
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: '' }
    },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'email-calendar',
    label: 'Email & Calendar',
    description: 'Read/send mail and read/write calendar events. Requires account credentials.',
    // TODO-verify provider package (Gmail/Google Calendar assumed).
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-gsuite'], env: { GOOGLE_OAUTH_TOKEN: '' } },
    tier: 'secret',
    defaultEnabled: false
  },
  {
    id: 'search-with-key',
    label: 'Web Search',
    description: 'Keyed web search. Requires a search-provider API key.',
    // TODO-verify provider package (Brave Search assumed).
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '' } },
    tier: 'secret',
    defaultEnabled: false
  }
];

/** Look up a catalog entry by id. */
export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** Whether an id is a known safe-readonly server (the only tier a hire manifest may
 *  request without surfacing for human consent — Workstream 3 validation). */
export function isSafeReadonlyMcp(id: string): boolean {
  return mcpCatalogEntry(id)?.tier === 'safe-readonly';
}

/** Servers an install seeded ON that are now OFF by default. */
export const MCP_TURNED_OFF_V1: readonly string[] = ['filesystem', 'git', 'sequential-thinking', 'time', 'fetch'];

/** `consent` with every MCP_TURNED_OFF_V1 server off. Run once per install
 *  (config `mcpWriteRetierV1`), so a later re-enable in Settings sticks. */
export function retierMcpConsent(
  consent: Record<string, { enabled: boolean }> | undefined
): Record<string, { enabled: boolean }> {
  const out = { ...(consent ?? defaultMcpDefaults()) };
  for (const id of MCP_TURNED_OFF_V1) out[id] = { enabled: false };
  return out;
}

/** Seed for `DEFAULTS.mcpDefaults` — derived from the catalog so the two never
 *  drift (safe-readonly ON, write/secret OFF). */
export function defaultMcpDefaults(): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const e of MCP_CATALOG) out[e.id] = { enabled: e.defaultEnabled };
  return out;
}

export interface McpStdioSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The enabled catalog servers for an agent in `cwd`, keyed `munder-<id>` so a server of
 *  the same name in the user's own Claude config is never shadowed. Undefined `consent`
 *  gives none. A write/secret server needs an explicit `enabled:true`, never a default,
 *  and every required env var filled (from `env`); otherwise it lands in `dropped`.
 *  `dropped` reasons name env keys only, never their values. */
export function catalogMcpServers(
  cwd: string,
  consent: Record<string, { enabled: boolean }> | undefined,
  env: Record<string, string | undefined> = {}
): { servers: Record<string, McpStdioSpec>; dropped: { id: string; reason: string }[] } {
  const servers: Record<string, McpStdioSpec> = {};
  const dropped: { id: string; reason: string }[] = [];
  if (!consent) return { servers, dropped };
  for (const e of MCP_CATALOG) {
    const consented = consent[e.id]?.enabled;
    if (!(consented ?? e.defaultEnabled)) continue;
    if (e.tier !== 'safe-readonly' && consented !== true) continue;
    // A value found only in `env` is left out of the file: the server inherits it from
    // the agent's environment, so no secret is copied to disk.
    const own = Object.fromEntries(Object.entries(e.spec.env ?? {}).filter(([, v]) => v));
    const missing = Object.keys(e.spec.env ?? {}).filter((k) => !own[k] && !env[k]);
    if (missing.length) { dropped.push({ id: e.id, reason: `not configured: ${missing.join(', ')} is empty` }); continue; }
    servers[`munder-${e.id}`] = {
      command: e.spec.command,
      args: e.spec.args.map((a) => (a === '<cwd>' ? cwd : a)),
      ...(Object.keys(own).length ? { env: own } : {})
    };
  }
  return { servers, dropped };
}
