/**
 * Per-agent bubblewrap jail around the agent's whole CLI process (hive-sandbox-2).
 *
 * The whole filesystem is read-only; the agent may write its own hive folder, the hive's
 * research/ and vault-inbox/, its own scratch folder (worktrees live there) and the CLI's
 * own state folder, plus agy-ask's usage-log folder. The hive root (tasks.json, board.md,
 * other agents) stays read-only, as do projects and home; ~/.ssh is an empty tmpfs. The app runtime is bound back over
 * the private /tmp, since the hook launcher execs it and exits 0 (allow) when it is gone.
 * With a net plan the jail has its own network namespace: jail-net.cjs forwards a
 * loopback proxy port (and listed loopback ports) to main's jailProxy.ts over a unix
 * socket. The Unity broker runs in main and reads requests from the agent folder.
 *
 * Only agents named in config.sandboxedAgents are jailed. A provider with no entry in
 * PROVIDER_STATE is refused, so a jailed agent is never silently spawned unjailed.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { gitDirsOf } from './gitDirs';

export const JAIL_BWRAP = '/usr/bin/bwrap';

/** Home-relative folders a CLI writes while it runs, and its files that must stay read-only. */
const PROVIDER_STATE: Record<string, {
  writable: string[];
  readOnly: string[];
  env?: Record<string, string>;
  /** Agent-folder links into the CLI's home-state folder: each target is bound writable,
   *  but only when it resolves inside `linkRoot` (home-relative). */
  agentLinks?: string[];
  linkRoot?: string;
  /** Agent-folder files laid read-only over the writable agent folder. */
  agentReadOnly?: string[];
}> = {
  // ~/.claude itself, its config, hooks, plugins and ~/.claude.json stay read-only; a save
  // of ~/.claude.json fails its lock and is skipped, and main pre-writes project trust.
  claude: {
    writable: ['projects', 'todos', 'shell-snapshots', 'statsig', 'session-env', 'sessions', 'file-history', 'plans', 'debug', 'paste-cache']
      .map((d) => `.claude/${d}`),
    readOnly: [],
    // The updater's host is not reachable from the jail, so each spawn would ask the Boss.
    env: { DISABLE_AUTOUPDATER: '1' }
  },
  antigravity: {
    writable: ['.gemini/antigravity-cli'],
    // agy loads hooks from here; a writable copy would let the agent drop its own hooks.
    readOnly: ['.gemini/antigravity-cli/hooks.json']
  },
  // CODEX_HOME is <agentDir>/.codex (hive.installCodexHooks), already writable. Its session
  // folders and auth.json link into ~/.codex; the login must save a token refresh, or the
  // rotated refresh token is lost for every Codex session. config.toml holds the hooks and
  // the user's PreToolUse guards, and main rewrites it each spawn.
  codex: {
    writable: [],
    readOnly: [],
    agentLinks: ['.codex/sessions', '.codex/archived_sessions', '.codex/auth.json'],
    linkRoot: '.codex',
    agentReadOnly: ['.codex/config.toml']
  }
};

/** Hosts the CLI itself must reach through the jail proxy, beyond any card's netAllow. */
export const PROVIDER_NET_HOSTS: Record<string, string[]> = {
  antigravity: ['googleapis.com', 'google.com', 'gstatic.com', 'googleusercontent.com'],
  // Measured 2026-11-22: api. and mcp-proxy.anthropic.com; Datadog intake is left denied.
  claude: ['anthropic.com'],
  // chatgpt.com/backend-api (ChatGPT login), auth.openai.com (token refresh), api.openai.com.
  codex: ['chatgpt.com', 'openai.com']
};

/** Hosts a CLI dials on every spawn that stay denied without asking the Boss to grant them. */
export const PROVIDER_QUIET_DENY: Record<string, string[]> = {
  // Log intakes and the auto-updater (the jail's ~/.claude is read-only, so it cannot update).
  claude: ['datadoghq.com', 'browser-intake-us5-datadoghq.com', 'registry.npmjs.org', 'downloads.claude.ai']
};

/** Background telemetry any CLI emits, whatever the provider. Still denied (403) and logged;
 *  only the Boss mail is skipped. Exact host or subdomain match, so add the narrowest host
 *  that is purely telemetry; never a domain that also serves an API (chatgpt.com, nuget.org). */
export const QUIET_DENY_TELEMETRY: string[] = ['ab.chatgpt.com', 'mobile.events.data.microsoft.com'];

/** Telemetry hosts are denied even under an allowed parent domain (ab.chatgpt.com). */
export function telemetryHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return QUIET_DENY_TELEMETRY.some((e) => h === e || h.endsWith(`.${e}`));
}

function quietDenied(provider: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return telemetryHost(h) || (PROVIDER_QUIET_DENY[provider] ?? []).some((e) => h === e || h.endsWith(`.${e}`));
}

/** What the jail proxy does with a denied host: always logs it, asks the Boss unless quiet. */
export function reportJailDeny(provider: string, host: string, deps: {
  log: (entry: { hosts: string[]; quiet?: true }) => void;
  ask: (host: string) => void;
}): void {
  if (quietDenied(provider, host)) { deps.log({ hosts: [host], quiet: true }); return; }
  deps.log({ hosts: [host] });
  deps.ask(host);
}

/** Auto-memory folders Claude sessions outside the jail load; writable projects/ must not
 *  let a jailed agent plant text in them. */
function claudeMemoryDirs(home: string): string[] {
  const projects = join(home, '.claude', 'projects');
  try {
    return readdirSync(projects).map((n) => join(projects, n, 'memory')).filter((d) => existsSync(d));
  } catch { return []; }
}

/** Loopback ports the jail forwards: the configured ones, plus Camp's telemetry collector
 *  for Claude, whose OTLP export dials 127.0.0.1 directly (NO_PROXY) and would otherwise
 *  hit the jail's empty network namespace. */
export function jailLoopbackPorts(configured: unknown, provider: string, otelEndpoint: string | null): number[] {
  const ports = Array.isArray(configured) ? configured.filter((n): n is number => Number.isInteger(n) && n > 0 && n < 65536) : [];
  if (provider === 'claude' && otelEndpoint) {
    try {
      const u = new URL(otelEndpoint);
      const port = Number(u.port);
      if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && port > 0 && !ports.includes(port)) ports.push(port);
    } catch { /* not a URL: nothing to forward */ }
  }
  return ports;
}

/** Hive-root folders a jailed agent may write besides its own folder. */
const HIVE_WRITABLE = ['research', 'vault-inbox'];

/** Home-relative folders any jailed agent's tools write (agy-ask's usage.log); created when
 *  missing, since a bind needs the folder and the tool's own mkdir fails in a read-only home. */
const HOME_TOOL_STATE = ['.local/share/agy-ask'];

/** Home-relative paths covered by an empty tmpfs. */
const HIDDEN_HOME = ['.ssh'];

export interface JailNet {
  /** Holds proxy.sock and jail-net.cjs; bound read-only into the jail. */
  dir: string;
  /** Node runtime that runs jail-net.cjs inside the jail. */
  node: string;
  proxyPort: number;
  /** Host loopback ports reachable from inside (e.g. Blender MCP). */
  loopbackPorts: number[];
}

export interface JailPlan {
  writable: string[];
  /** Laid read-only over a writable folder, after the writable binds. */
  readOnly: string[];
  hidden: string[];
  cwd: string;
  env: Record<string, string>;
  net?: JailNet;
}

/** Providers the jail can run today; any other is refused at spawn. */
export const JAIL_PROVIDERS: readonly string[] = Object.keys(PROVIDER_STATE);

export function jailSupports(provider: string): boolean { return Object.hasOwn(PROVIDER_STATE, provider); }

export function isJailed(cfg: { sandboxedAgents?: string[] }, agentId: string): boolean {
  return Array.isArray(cfg.sandboxedAgents) && cfg.sandboxedAgents.includes(agentId);
}

function real(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** What the jail binds for one agent. Paths are resolved to their real location, since
 *  bwrap mounts on the real path; missing read-only and hidden paths are dropped. */
export function jailPlan(o: {
  provider: string;
  agentId: string;
  home: string;
  agentDir: string;
  hiveRoot: string;
  scratchRoot: string;
  cwd: string;
  /** Folders granted on top (the registry entry's extra folders, the memory palace). */
  extraWritable: string[];
  /** Folders the hook launcher needs (the app runtime); refused when one is missing. */
  runtimeDirs: string[];
  net?: JailNet;
}): { ok: true; plan: JailPlan } | { ok: false; error: string } {
  const state = PROVIDER_STATE[o.provider];
  if (!state) return { ok: false, error: `the agent sandbox does not support provider "${o.provider}" yet` };
  const scratch = real(join(o.scratchRoot, o.agentId));
  if (!scratch) return { ok: false, error: `the agent's scratch folder ${join(o.scratchRoot, o.agentId)} does not exist` };
  const agentDir = real(o.agentDir);
  if (!agentDir) return { ok: false, error: `${o.agentDir} does not exist` };
  if (!real(o.hiveRoot)) return { ok: false, error: `${o.hiveRoot} does not exist` };
  const runtime: string[] = [];
  for (const d of o.runtimeDirs) {
    const r = real(d);
    if (!r) return { ok: false, error: `the app runtime ${d} does not exist, so the agent's hooks could not run` };
    runtime.push(r);
  }
  const writable: string[] = [agentDir, scratch];
  for (const d of HIVE_WRITABLE) { const r = real(join(o.hiveRoot, d)); if (r) writable.push(r); }
  const cwd = real(o.cwd) ?? o.cwd;
  // A worktree in the scratch folder commits through the main repo's git dir.
  if (inside(cwd, scratch)) for (const g of gitDirsOf(cwd)) { const r = real(g); if (r) writable.push(r); }
  for (const p of [...state.writable, ...HOME_TOOL_STATE]) { try { mkdirSync(join(o.home, p), { recursive: true }); } catch { /* dropped below */ } }
  for (const d of [...[...state.writable, ...HOME_TOOL_STATE].map((p) => join(o.home, p)), ...o.extraWritable]) {
    const r = real(d);
    if (r) writable.push(r);
  }
  const linkRoot = state.linkRoot ? real(join(o.home, state.linkRoot)) : null;
  if (linkRoot) {
    for (const l of state.agentLinks ?? []) {
      const r = real(join(agentDir, l));
      if (r && r !== linkRoot && inside(r, linkRoot)) writable.push(r);
    }
  }
  const providerRo = [
    ...(o.provider === 'claude' ? claudeMemoryDirs(o.home) : []),
    ...(state.agentReadOnly ?? []).map((p) => join(agentDir, p))
  ];
  const readOnly = [...[join(o.hiveRoot, 'bin'), ...state.readOnly.map((p) => join(o.home, p)), ...providerRo]
    .map(real).filter((p): p is string => !!p), ...runtime];
  const hidden = HIDDEN_HOME.map((p) => real(join(o.home, p))).filter((p): p is string => !!p);
  let net: JailNet | undefined;
  if (o.net) {
    const dir = real(o.net.dir);
    if (!dir) return { ok: false, error: `the jail network folder ${o.net.dir} does not exist` };
    net = { ...o.net, dir };
  }
  // Parents first: a later bind of a parent would cover a bind made inside it.
  const ordered = [...new Set(writable)].sort((a, b) => a.length - b.length);
  return { ok: true, plan: { writable: ordered, readOnly, hidden, cwd: o.cwd, env: state.env ?? {}, ...(net ? { net } : {}) } };
}

/** The proxy port inside the jail's own network namespace, so it never collides. */
export const JAIL_PROXY_PORT = 18080;
export const JAIL_NET_SCRIPT = 'jail-net.cjs';
export const JAIL_NET_SOCK = 'proxy.sock';

export function jailArgv(plan: JailPlan, command: string[]): string[] {
  const net = plan.net;
  const cmd = net
    ? [net.node, join(net.dir, JAIL_NET_SCRIPT), join(net.dir, JAIL_NET_SOCK), String(net.proxyPort), net.loopbackPorts.join(','), '--', ...command]
    : command;
  return [
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--tmpfs', '/dev/shm',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...plan.writable.flatMap((d) => ['--bind', d, d]),
    ...plan.readOnly.flatMap((d) => ['--ro-bind', d, d]),
    ...plan.hidden.flatMap((d) => ['--tmpfs', d]),
    ...(net ? ['--ro-bind', net.dir, net.dir, '--unshare-net'] : []),
    ...Object.entries(plan.env ?? {}).flatMap(([k, v]) => ['--setenv', k, v]),
    '--unshare-pid',
    '--die-with-parent',
    '--chdir', plan.cwd,
    '--',
    ...cmd
  ];
}

/** Rewrite (file, args) to run inside the jail; unchanged without a plan. */
export function withJail(file: string, args: string[], plan: JailPlan | undefined, bwrap = JAIL_BWRAP): { file: string; args: string[] } {
  if (!plan) return { file, args };
  return { file: bwrap, args: jailArgv(plan, [file, ...args]) };
}

/** False when bwrap is missing, so the caller can refuse the spawn. */
export function jailAvailable(bwrap = JAIL_BWRAP): boolean {
  return process.platform === 'linux' && existsSync(bwrap);
}

/** Write the in-jail forwarder into a net dir. */
export function installJailNet(dir: string): string {
  const p = join(dir, JAIL_NET_SCRIPT);
  writeFileSync(p, JAIL_NET_FORWARDER, { mode: 0o644 });
  return p;
}

/** Runs inside the jail's network namespace: argv sock proxyPort ports -- command.
 *  Fails closed: if a listener cannot start, the command never runs. */
const JAIL_NET_FORWARDER = `'use strict';
const net = require('net');
const { spawn } = require('child_process');
const [sock, portArg, portsArg, sep, ...cmd] = process.argv.slice(2);
if (sep !== '--' || !cmd.length) { console.error('jail-net: bad argv'); process.exit(1); }
const proxyPort = Number(portArg);
const ports = portsArg ? portsArg.split(',').map(Number).filter((n) => n > 0) : [];
function pipeTo(c, preface) {
  const up = net.createConnection(sock);
  up.on('error', () => c.destroy());
  c.on('error', () => up.destroy());
  if (!preface) { c.pipe(up); up.pipe(c); return; }
  up.write(preface);
  let head = Buffer.alloc(0);
  const onData = (d) => {
    head = Buffer.concat([head, d]);
    const end = head.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    up.removeListener('data', onData);
    if (!/^HTTP\\/1\\.[01] 200/.test(head.toString('latin1'))) { c.destroy(); up.destroy(); return; }
    const rest = head.subarray(end + 4);
    if (rest.length) c.write(rest);
    c.pipe(up); up.pipe(c);
  };
  up.on('data', onData);
}
function listen(port, onConn) {
  return new Promise((ok, fail) => {
    const s = net.createServer(onConn);
    s.once('error', fail);
    s.listen(port, '127.0.0.1', () => ok(s));
  });
}
(async () => {
  try {
    await listen(proxyPort, (c) => pipeTo(c));
    for (const p of ports) await listen(p, (c) => pipeTo(c, 'CONNECT 127.0.0.1:' + p + ' HTTP/1.1\\r\\nHost: 127.0.0.1:' + p + '\\r\\n\\r\\n'));
  } catch (e) { console.error('jail-net: ' + e.message); process.exit(1); }
  const proxy = 'http://127.0.0.1:' + proxyPort;
  const env = { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => { console.error('jail-net: ' + e.message); process.exit(127); });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 128 + (require('os').constants.signals[sig] || 0) : 1)));
})();
`;
