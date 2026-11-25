import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * Linux only: start agent work in its own systemd scope under `agents.slice`, so the
 * camp UI (launched into `camp-ui.slice`) keeps CPU, IO and memory headroom when
 * agents and their Unity builds load the machine. Children inherit the parent's
 * cgroup, so without this every agent would land in the UI's slice.
 *
 * `systemd-run --scope` execs the command in place, so the pid node-pty or
 * child_process reports is the agent's own pid and kill/pgid logic is unchanged.
 */
export const AGENT_SLICE = 'agents.slice';

/** The systemd-run prefix, before the agent's own file and args. */
export function agentScopePrefix(slice = AGENT_SLICE): string[] {
  return ['--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, '--'];
}

/** Rewrite (file, args) to run inside an agent scope; unchanged when `enabled` is false. */
export function wrapForAgentScope(
  file: string, args: string[], enabled: boolean, systemdRun = 'systemd-run'
): { file: string; args: string[] } {
  if (!enabled) return { file, args };
  return { file: systemdRun, args: [...agentScopePrefix(), file, ...args] };
}

let probed: boolean | null = null;

/** True when a user scope can actually be created here: Linux, systemd-run present,
 *  the user manager reachable. Probed once per app run; `MD_NO_AGENT_SCOPE=1` turns it off. */
export function agentScopeAvailable(): boolean {
  if (probed !== null) return probed;
  if (process.platform !== 'linux' || process.env.MD_NO_AGENT_SCOPE === '1') {
    probed = false;
    return probed;
  }
  try {
    const r = spawnSync('systemd-run', [...agentScopePrefix(), 'true'], { timeout: 5000, stdio: 'ignore' });
    probed = r.status === 0;
  } catch {
    probed = false;
  }
  if (!probed) console.warn('[agentScope] systemd-run unavailable; agents run in the app\'s own cgroup.');
  return probed;
}

/**
 * CPU and IO priority for every agent and hive job, so the human's games, editor and desktop
 * win contention while idle cores still go to agents. Set at spawn because `ulimit -e`
 * is 0 on a typical Linux host: an unprivileged process can lower priority but never raise it.
 * `nice` is relative (an agent's own children land at 19); ioClass 2 = best-effort,
 * ioLevel 7 its lowest. Never a negative nice or ioClass 1 (realtime).
 */
export const BACKGROUND_PRIORITY = { nice: 10, ioClass: 2, ioLevel: 7 } as const;

export interface PriorityTools { nice: string | null; ionice: string | null }

export function backgroundPriorityPrefix(tools: PriorityTools, p = BACKGROUND_PRIORITY): string[] {
  return [
    ...(tools.nice ? [tools.nice, '-n', String(p.nice)] : []),
    ...(tools.ionice ? [tools.ionice, '-c', String(p.ioClass), '-n', String(p.ioLevel)] : [])
  ];
}

/** Rewrite (file, args) to run at background priority; unchanged when neither tool exists. */
export function wrapForBackgroundPriority(
  file: string, args: string[], tools: PriorityTools
): { file: string; args: string[] } {
  const prefix = backgroundPriorityPrefix(tools);
  if (prefix.length === 0) return { file, args };
  return { file: prefix[0], args: [...prefix.slice(1), file, ...args] };
}

/** Agent scope outermost, then priority, then the command; nice and ionice exec in place. */
export function wrapAgentCommand(
  file: string, args: string[], opts: { scope: boolean; tools: PriorityTools }
): { file: string; args: string[] } {
  const inner = wrapForBackgroundPriority(file, args, opts.tools);
  return wrapForAgentScope(inner.file, inner.args, opts.scope);
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let priorityTools: PriorityTools | null = null;

/** nice/ionice found on PATH, probed once; none on Windows or with `MD_NO_BACKGROUND_PRIORITY=1`. */
export function backgroundPriorityTools(): PriorityTools {
  if (process.platform === 'win32' || process.env.MD_NO_BACKGROUND_PRIORITY === '1') return { nice: null, ionice: null };
  if (priorityTools === null) {
    priorityTools = { nice: onPath('nice'), ionice: process.platform === 'linux' ? onPath('ionice') : null };
    if (!priorityTools.nice || !priorityTools.ionice) {
      console.warn(`[agentScope] background priority partial: nice=${priorityTools.nice ?? 'missing'} ionice=${priorityTools.ionice ?? 'missing'}`);
    }
  }
  return priorityTools;
}

/** wrapForBackgroundPriority with the live probe, for heavy jobs outside an agent scope. */
export function inBackgroundPriority(file: string, args: string[]): { file: string; args: string[] } {
  return wrapForBackgroundPriority(file, args, backgroundPriorityTools());
}

/** Agent scope plus background priority, with the live probes. */
export function inAgentScope(file: string, args: string[]): { file: string; args: string[] } {
  return wrapAgentCommand(file, args, { scope: agentScopeAvailable(), tools: backgroundPriorityTools() });
}
