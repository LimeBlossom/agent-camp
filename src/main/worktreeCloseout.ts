/**
 * Safety audit shared by every post-merge worktree closeout (approved, ordinary and
 * auto-merge, via cleanupMergedWorktree) and by the standup's leftover triage.
 * Each check fails closed: anything it cannot read keeps the tree.
 */

import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

/** Ignored folders a tree may hold and still be removed: tools rebuild them. */
export const REGENERABLE_DIRS = new Set(['Library', 'Temp', 'obj', 'bin', 'node_modules']);
const OPEN_STATUSES = new Set(['todo', 'doing', 'blocked']);
/** Names quoted in a refusal before the rest collapse into a count. */
const REPORT_MAX_NAMES = 10;

export const realpathOrNull = (p: string): string | null => {
  try { return realpathSync(p); } catch { return null; }
};

const within = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/** True when some folder on the entry's path is a regenerable cache. */
export function isRegenerable(entry: string): boolean {
  const dirs = entry.split('/').slice(0, -1);
  return dirs.some((d) => REGENERABLE_DIRS.has(d));
}

/** NUL-separated `git ls-files -z` output as entries. */
export const splitZ = (out: string): string[] => out.split('\0').filter(Boolean);

/** Quoted, capped list of names for a refusal reason. */
export function quoteNames(names: string[]): string {
  const shown = names.slice(0, REPORT_MAX_NAMES).map((n) => JSON.stringify(n)).join(', ');
  return names.length > REPORT_MAX_NAMES ? `${shown} and ${names.length - REPORT_MAX_NAMES} more` : shown;
}

export const IGNORED_DIRS_ARGS = ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'];
export const IGNORED_FILES_ARGS = (dir: string): string[] => ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', dir];

/** Ignored files that are not regenerable caches, or an error when git could not list them.
 *  `git` returns stdout or null on failure. Cache folders are never enumerated. */
export function ignoredNonCache(git: (args: string[]) => string | null): { files: string[] } | { error: string } {
  const top = git(IGNORED_DIRS_ARGS);
  if (top === null) return { error: 'git could not list its ignored files' };
  const files: string[] = [];
  for (const entry of splitZ(top)) {
    if (isRegenerable(entry)) continue;
    if (!entry.endsWith('/')) { files.push(entry); continue; }
    const inner = git(IGNORED_FILES_ARGS(entry));
    if (inner === null) return { error: `git could not list the ignored folder ${JSON.stringify(entry)}` };
    const kept = splitZ(inner).filter((f) => !isRegenerable(f));
    files.push(...(kept.length ? kept : [entry]));
  }
  return { files };
}

/** Pids whose working directory is `dir` or below it, or an error when /proc is unreadable. */
export function processCwdsUnder(dir: string): { pids: number[] } | { error: string } {
  const root = realpathOrNull(dir) ?? dir;
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return { error: 'process working directories cannot be read (/proc)' }; }
  const pids: number[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let cwd: string;
    try { cwd = readlinkSync(`/proc/${n}/cwd`); } catch { continue; }
    if (within(cwd.replace(/ \(deleted\)$/, ''), root)) pids.push(Number(n));
  }
  return { pids };
}

/** Registered agents whose cwd is the tree or inside it. */
export function agentsWithCwdUnder(dir: string, agents: Array<{ id: string; cwd?: string }>): string[] {
  const root = realpathOrNull(dir) ?? dir;
  return agents.filter((a) => {
    if (!a.cwd) return false;
    const cwd = realpathOrNull(a.cwd) ?? path.resolve(a.cwd);
    return within(cwd, root);
  }).map((a) => a.id);
}

/** Ids of todo/doing/blocked cards whose text names the tree (either spelling of its path). */
export function openCardsReferencing(tasks: readonly unknown[], dir: string): string[] {
  const needles = [...new Set([dir, realpathOrNull(dir) ?? dir])].map((p) => JSON.stringify(p).slice(1, -1));
  const ids: string[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const card = t as { id?: unknown; status?: unknown };
    if (typeof card.id !== 'string' || !OPEN_STATUSES.has(String(card.status))) continue;
    const text = JSON.stringify(card);
    if (needles.some((n) => text.includes(n))) ids.push(card.id);
  }
  return ids;
}
