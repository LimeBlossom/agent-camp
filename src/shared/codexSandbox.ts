/** Per-agent Codex sandbox level, stored on the agent's registry entry.
 *  - sandboxed: `-s workspace-write`; writable = cwd, the agent dir, the hive root and the
 *    agent's extra folders (the default).
 *  - full: `-s danger-full-access`, so the agent can reach the display and licence servers. */
export const CODEX_SANDBOX_LEVELS = ['sandboxed', 'full'] as const;
export type CodexSandboxLevel = typeof CODEX_SANDBOX_LEVELS[number];
export const DEFAULT_CODEX_SANDBOX: CodexSandboxLevel = 'sandboxed';
export { cleanExtraDirs } from './workspace';

export function isCodexSandboxLevel(v: unknown): v is CodexSandboxLevel {
  return typeof v === 'string' && (CODEX_SANDBOX_LEVELS as readonly string[]).includes(v);
}

/** A stored level read as one of the current two. The retired 'hive' and 'projects'
 *  levels, and anything unrecognised, read as sandboxed: only an explicit 'full' drops it. */
export function normalizeCodexSandbox(v: unknown): CodexSandboxLevel {
  return v === 'full' ? 'full' : 'sandboxed';
}

/** The level a Codex spawn runs at. A jailed agent always runs full: bwrap is its boundary,
 *  and Codex's own bubblewrap sandbox cannot start inside the jail. Without the hive OS
 *  sandbox every agent runs full; otherwise the stored registry level applies. */
export function codexSandboxLevelFor(o: { jailed: boolean; agentSandbox: boolean; stored: CodexSandboxLevel }): CodexSandboxLevel {
  return o.jailed || !o.agentSandbox ? 'full' : o.stored;
}

export function codexSandboxMode(level: CodexSandboxLevel): 'workspace-write' | 'danger-full-access' {
  return level === 'full' ? 'danger-full-access' : 'workspace-write';
}

/** Codex argv with its `-s`/`--sandbox` value set for <paramref name="level"/>. `sandboxed`
 *  leaves the args as they are (its writable roots come from --add-dir and the worker
 *  config). `full` rewrites an existing sandbox flag, or adds one when the args carry no
 *  sandbox stance at all; an explicit full bypass flag is left alone. */
export function applyCodexSandbox(args: string[], level: CodexSandboxLevel): string[] {
  if (level !== 'full') return args;
  if (args.includes('--dangerously-bypass-approvals-and-sandbox')) return args;
  const mode = codexSandboxMode(level);
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if ((out[i] === '-s' || out[i] === '--sandbox') && i + 1 < out.length) {
      out[i + 1] = mode;
      return out;
    }
    if (out[i].startsWith('--sandbox=')) {
      out[i] = `--sandbox=${mode}`;
      return out;
    }
  }
  return ['-s', mode, ...out];
}

/** Sets a top-level TOML key (before the file's first table): an existing assignment is
 *  rewritten in place, otherwise the line is prepended. A stale value is never kept. */
export function setTopLevelTomlKey(cfg: string, key: string, value: string | boolean): string {
  const line = `${key} = ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`;
  const lines = cfg.split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable < 0 ? lines.length : firstTable;
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  for (let i = 0; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  return `${line}\n${cfg}`;
}

/** Sets `key` inside `[table]`: an existing assignment there is rewritten, otherwise the
 *  line goes first in the table, and a missing table is appended. */
export function setTomlTableKey(cfg: string, table: string, key: string, value: string | boolean): string {
  const line = `${key} = ${typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`;
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = cfg.split('\n');
  const head = lines.findIndex((l) => new RegExp(`^\\s*\\[${esc(table)}\\]\\s*(#.*)?$`).test(l));
  if (head < 0) {
    const sep = cfg === '' || cfg.endsWith('\n') ? '' : '\n';
    return `${cfg}${sep}\n[${table}]\n${line}\n`;
  }
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const re = new RegExp(`^\\s*${esc(key)}\\s*=`);
  for (let i = head + 1; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  lines.splice(head + 1, 0, line);
  return lines.join('\n');
}

const NETWORK_KEY = 'sandbox_workspace_write.network_access';

/** Is this argv pair a `-c sandbox_workspace_write.network_access=…` override? */
function isNetworkOverride(flag: string, value: string | undefined): boolean {
  return (flag === '-c' || flag === '--config') && typeof value === 'string' && value.replace(/\s/g, '').startsWith(`${NETWORK_KEY}=`);
}

/** Codex argv with the agent's network switch applied. Sandboxed: any earlier override is
 *  dropped and, when `network` is on, `-c sandbox_workspace_write.network_access=true` goes
 *  first (global options precede the prompt and any `resume`). Full: args unchanged, the
 *  sandbox that would block the network is not there. */
export function applyCodexNetwork(args: string[], level: CodexSandboxLevel, network: boolean): string[] {
  if (level === 'full') return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (isNetworkOverride(args[i], args[i + 1])) { i++; continue; }
    out.push(args[i]);
  }
  return network ? ['-c', `${NETWORK_KEY}=true`, ...out] : out;
}

/** The worker config.toml with its `[sandbox_workspace_write]` table carrying the agent's
 *  writable roots and network switch. A table the user's own config already defines keeps
 *  its writable_roots (TOML forbids a second table), but network_access is always set to the
 *  agent's value, so turning the switch off rewrites a stale `true`. */
export function setSandboxWorkspaceWrite(cfg: string, writableRoots: string[], network: boolean): string {
  const netLine = `network_access = ${network ? 'true' : 'false'}`;
  const lines = cfg.split('\n');
  const head = lines.findIndex((l) => /^\s*\[sandbox_workspace_write\]\s*(#.*)?$/.test(l));
  if (head < 0) {
    const roots = writableRoots.length ? `writable_roots = ${JSON.stringify(writableRoots)}\n` : '';
    const sep = cfg === '' || cfg.endsWith('\n') ? '' : '\n';
    return `${cfg}${sep}\n[sandbox_workspace_write]\n${roots}${netLine}\n`;
  }
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  for (let i = head + 1; i < end; i++) {
    if (/^\s*network_access\s*=/.test(lines[i])) {
      lines[i] = netLine;
      return lines.join('\n');
    }
  }
  lines.splice(head + 1, 0, netLine);
  return lines.join('\n');
}

/** A worker config.toml with every hook-trust approval the hive already holds, so one
 *  approval covers every Codex agent. Codex keys an approval by `<config path>:<event>:
 *  <group>:<hook>` and fingerprints only the hook's definition, and every worker gets the
 *  same generated hooks, so an approval written into one agent's config is valid in any
 *  other once its key is rewritten to that agent's `configPath`. A hook whose definition
 *  changed no longer matches its fingerprint and is still re-reviewed. Where sources
 *  disagree on a slot the newest file wins; slots `next` already defines are left alone,
 *  since TOML forbids a table twice. */
export function mergeHookTrust(
  sources: ReadonlyArray<{ text: string; mtimeMs: number }>,
  configPath: string,
  next: string
): string {
  const entry = /^\s*\[hooks\.state\."(.+):([a-z_]+:\d+:\d+)"\]\s*\n\s*trusted_hash\s*=\s*"([^"]+)"/gm;
  const bySlot = new Map<string, string>();
  for (const src of [...sources].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    for (const m of src.text.matchAll(entry)) bySlot.set(m[2], m[3]);
  }
  const taken = new Set<string>();
  for (const m of next.matchAll(entry)) taken.add(m[2]);
  const tables = [...bySlot]
    .filter(([slot]) => !taken.has(slot))
    .map(([slot, hash]) => `[hooks.state.${JSON.stringify(`${configPath}:${slot}`)}]\ntrusted_hash = ${JSON.stringify(hash)}`);
  if (!tables.length) return next;
  const sep = next === '' || next.endsWith('\n') ? '' : '\n';
  return `${next}${sep}\n${tables.join('\n\n')}\n`;
}

/** One row of Codex's `hooks/list` reply, the fields trustOwnHooks reads. */
export interface ListedCodexHook {
  key: string;
  command: string;
  currentHash: string;
  trustStatus: string;
}

/** A worker config.toml with every hook the hive itself generated marked trusted, using
 *  the key and fingerprint Codex reported for it in `hooks/list`. `isOwn` decides which
 *  hooks count as ours; anything else keeps Codex's own review. An existing approval for
 *  the same key is replaced, since a stale fingerprint there would leave the hook blocked. */
export function trustOwnHooks(cfg: string, hooks: readonly ListedCodexHook[], isOwn: (command: string) => boolean): string {
  let out = cfg;
  const add: string[] = [];
  for (const h of hooks) {
    if (h.trustStatus === 'trusted' || !isOwn(h.command) || !h.key || !h.currentHash) continue;
    const header = `[hooks.state.${JSON.stringify(h.key)}]`;
    const line = `trusted_hash = ${JSON.stringify(h.currentHash)}`;
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.trim() === header);
    if (at < 0) { add.push(`${header}\n${line}`); continue; }
    let end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    lines.splice(at + 1, end - at - 1, line, '');
    out = lines.join('\n');
  }
  if (!add.length) return out;
  const sep = out === '' || out.endsWith('\n') ? '' : '\n';
  return `${out}${sep}\n${add.join('\n\n')}\n`;
}
