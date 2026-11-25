import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { IGNORED_DIRS_ARGS, IGNORED_FILES_ARGS, agentsWithCwdUnder, isRegenerable, openCardsReferencing, processCwdsUnder, quoteNames, splitZ } from './worktreeCloseout';

/** A folder the hive probably left behind. `worktree` is a linked git worktree,
 *  `clone` a second checkout of another repo found in the scan, `copy` a Unity
 *  project outside git that duplicates a tracked one or carries an agent's name. */
export interface Leftover {
  kind: 'worktree' | 'clone' | 'copy';
  path: string;
  /** The repo or project it belongs to. */
  of: string;
  branch?: string;
  /** The main branch a 'merged' leftover is already in. */
  into?: string;
  /** 'merged': its HEAD is already in the main branch and the tree is clean.
   *  'idle': nothing touched it for LEFTOVER_IDLE_DAYS. 'orphan': a clone whose local
   *  origin folder is gone. 'copy': outside git. */
  reason: 'merged' | 'idle' | 'orphan' | 'copy';
  lastTouchedMs: number;
  sizeBytes: number | null;
  /** The closeout safety audit of a merged worktree. Missing means not audited, which
   *  never counts as safe. */
  audit?: { ok: boolean; issues: string[] };
}

export const LEFTOVER_IDLE_DAYS = 7;
const DAY_MS = 86_400_000;
/** Folders deeper than this under a scan root are not looked at. */
const SCAN_DEPTH = 2;
const SKIP_DIRS = new Set(['node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds']);
const GIT_TIMEOUT_MS = 30_000;
const DU_TIMEOUT_MS = 180_000;
/** Lines listed before the rest collapse into one "and N more" line. */
const REPORT_MAX_LINES = 20;

export interface LeftoverDeps {
  /** stdout, or null when git failed. */
  git(cwd: string, args: string[]): Promise<string | null>;
  sizeOf(path: string): Promise<number | null>;
  now(): number;
}

function run(cmd: string, args: string[], cwd: string | undefined, timeout: number): Promise<string | null> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => res(err ? null : String(stdout)));
  });
}

export const realLeftoverDeps: LeftoverDeps = {
  // --no-optional-locks keeps `status` from rewriting the index, whose mtime is the idle clock.
  git: (cwd, args) => run('git', ['--no-optional-locks', '-C', cwd, ...args], undefined, GIT_TIMEOUT_MS),
  sizeOf: async (path) => {
    const out = await run('nice', ['-n', '19', 'du', '-sb', path], undefined, DU_TIMEOUT_MS);
    const n = out ? Number(out.split('\t')[0]) : NaN;
    return Number.isFinite(n) ? n : null;
  },
  now: () => Date.now()
};

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function mtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function isUnityProject(p: string): boolean {
  return isDir(join(p, 'Assets')) && isDir(join(p, 'ProjectSettings'));
}

function productName(p: string): string | null {
  try {
    const m = /^\s*productName:\s*(.+?)\s*$/m.exec(readFileSync(join(p, 'ProjectSettings', 'ProjectSettings.asset'), 'utf8'));
    return m && m[1] ? m[1] : null;
  } catch { return null; }
}

interface Found { repos: string[]; unity: string[] }

/** Main git repos (a `.git` directory, not a worktree's `.git` file) and non-git Unity
 *  projects at most SCAN_DEPTH below each root. Neither is descended into. */
export function findProjects(roots: string[]): Found {
  const repos = new Set<string>();
  const unity = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (isDir(join(dir, '.git'))) { repos.add(dir); return; }
    if (existsSync(join(dir, '.git'))) return;
    if (isUnityProject(dir)) { unity.add(dir); return; }
    if (depth >= SCAN_DEPTH) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
      const child = join(dir, n);
      if (isDir(child)) walk(child, depth + 1);
    }
  };
  for (const r of roots) if (isDir(r)) walk(resolve(r), 0);
  return { repos: [...repos].sort(), unity: [...unity].sort() };
}

interface WorktreeEntry { path: string; head: string; branch?: string }

function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const head = /^HEAD (\w+)$/m.exec(block)?.[1];
    if (!path || !head || /^bare$/m.test(block)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    out.push({ path, head, ...(branch ? { branch } : {}) });
  }
  return out;
}

/** HEAD's commit time or the index's mtime, whichever is later. */
async function lastTouched(d: LeftoverDeps, path: string): Promise<number> {
  const ct = Number((await d.git(path, ['log', '-1', '--format=%ct']))?.trim()) * 1000 || 0;
  const gitDir = (await d.git(path, ['rev-parse', '--absolute-git-dir']))?.trim();
  return Math.max(ct, gitDir ? mtime(join(gitDir, 'index')) : 0);
}

async function isClean(d: LeftoverDeps, path: string): Promise<boolean> {
  const out = await d.git(path, ['status', '--porcelain']);
  return out !== null && out.trim() === '';
}

/** 'merged' when `head` is already in `mainRef` of `repo` and the tree is clean,
 *  'idle' when untouched for LEFTOVER_IDLE_DAYS, else null. */
async function judge(d: LeftoverDeps, repo: string, mainRef: string, path: string, head: string, touched: number): Promise<'merged' | 'idle' | null> {
  const merged = (await d.git(repo, ['merge-base', '--is-ancestor', head, mainRef])) !== null;
  if (merged && await isClean(d, path)) return 'merged';
  return d.now() - touched >= LEFTOVER_IDLE_DAYS * DAY_MS ? 'idle' : null;
}

/** The same checks the post-merge closeout makes, minus the git ones `judge` already did. */
async function auditWorktree(d: LeftoverDeps, path: string, opts: ScanOptions): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  const agents = agentsWithCwdUnder(path, opts.agents ?? []);
  if (agents.length) issues.push(`agent ${agents.join(', ')} has its cwd in it`);
  const procs = processCwdsUnder(path);
  if ('error' in procs) issues.push(procs.error);
  else if (procs.pids.length) issues.push(`process ${procs.pids.slice(0, 5).join(', ')} has its cwd in it`);
  const cards = openCardsReferencing(opts.tasks ?? [], path);
  if (cards.length) issues.push(`open card ${cards.join(', ')} references it`);
  const top = await d.git(path, IGNORED_DIRS_ARGS);
  if (top === null) issues.push('git could not list its ignored files');
  else {
    const files: string[] = [];
    for (const entry of splitZ(top)) {
      if (isRegenerable(entry)) continue;
      if (!entry.endsWith('/')) { files.push(entry); continue; }
      const inner = await d.git(path, IGNORED_FILES_ARGS(entry));
      const kept = inner === null ? [entry] : splitZ(inner).filter((f) => !isRegenerable(f));
      files.push(...(kept.length ? kept : [entry]));
    }
    if (files.length) issues.push(`ignored files that are not caches: ${quoteNames(files)}`);
  }
  return { ok: issues.length === 0, issues };
}

export interface ScanOptions {
  copiesSinceMs?: number;
  /** The ledger: an open card naming a merged tree keeps it out of the safe list. */
  tasks?: readonly unknown[];
  /** Registered agents: one working in a merged tree keeps it out of the safe list. */
  agents?: Array<{ id: string; cwd?: string }>;
}

function normRemote(url: string): string {
  return url.trim().replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

function hasAgentName(name: string, agentNames: string[]): boolean {
  const lower = name.toLowerCase();
  return agentNames.some((a) => lower.includes(a));
}

/** Every leftover under `roots`. Report only: nothing here writes or deletes.
 *  `agentNames` are the hive's agent names; single words of four letters or more are
 *  matched, case-insensitively, inside folder names. A Unity copy last touched before
 *  `copiesSinceMs` (the hive's birth) is the human's own and is not listed. */
export async function scanLeftovers(
  roots: string[],
  agentNames: string[],
  opts: ScanOptions = {},
  d: LeftoverDeps = realLeftoverDeps
): Promise<Leftover[]> {
  const names = agentNames.map((n) => n.toLowerCase()).filter((n) => /^[a-z]{4,}$/.test(n));
  const { repos, unity } = findProjects(roots);
  const out: Leftover[] = [];

  const mainOf = new Map<string, string>();
  const remoteOf = new Map<string, string>();
  for (const repo of repos) {
    const wts = parseWorktrees((await d.git(repo, ['worktree', 'list', '--porcelain'])) ?? '');
    const main = wts[0];
    if (!main) continue;
    mainOf.set(repo, main.branch ?? main.head);
    const remote = (await d.git(repo, ['remote', 'get-url', 'origin']))?.trim();
    if (remote) remoteOf.set(repo, remote);
    for (const wt of wts.slice(1)) {
      if (!isDir(wt.path)) continue;
      const touched = await lastTouched(d, wt.path);
      const reason = await judge(d, repo, mainOf.get(repo)!, wt.path, wt.head, touched);
      if (reason) out.push({ kind: 'worktree', path: wt.path, of: repo, ...(wt.branch ? { branch: wt.branch } : {}), ...(reason === 'merged' ? { into: mainOf.get(repo)!, audit: await auditWorktree(d, wt.path, opts) } : {}), reason, lastTouchedMs: touched, sizeBytes: null });
    }
  }

  const clones = new Set<string>();
  for (const repo of repos) {
    const remote = remoteOf.get(repo);
    if (!remote) continue;
    const name = basename(repo);
    const original = repos.find((o) => o !== repo && (
      resolve(dirname(repo), remote) === o
      || (remoteOf.has(o) && normRemote(remoteOf.get(o)!) === normRemote(remote)
        && (name.startsWith(`${basename(o)}-`) || hasAgentName(name, names)))));
    const localOrigin = remote.startsWith('/') || remote.startsWith('.') ? resolve(dirname(repo), remote) : null;
    if (!original && localOrigin && !existsSync(localOrigin)) {
      clones.add(repo);
      const branch = (await d.git(repo, ['branch', '--show-current']))?.trim();
      out.push({ kind: 'clone', path: repo, of: localOrigin, ...(branch ? { branch } : {}), reason: 'orphan', lastTouchedMs: await lastTouched(d, repo), sizeBytes: null });
      continue;
    }
    if (!original) continue;
    clones.add(repo);
    const head = (await d.git(repo, ['rev-parse', 'HEAD']))?.trim();
    if (!head) continue;
    const branch = (await d.git(repo, ['branch', '--show-current']))?.trim();
    const touched = await lastTouched(d, repo);
    const into = mainOf.get(original) ?? 'HEAD';
    const reason = await judge(d, original, into, repo, head, touched);
    if (reason) out.push({ kind: 'clone', path: repo, of: original, ...(branch ? { branch } : {}), ...(reason === 'merged' ? { into } : {}), reason, lastTouchedMs: touched, sizeBytes: null });
  }

  const trackedProducts = new Map<string, string>();
  for (const repo of repos) {
    if (clones.has(repo)) continue;
    const p = isUnityProject(repo) ? productName(repo) : null;
    if (p && !trackedProducts.has(p)) trackedProducts.set(p, repo);
  }
  for (const proj of unity) {
    const p = productName(proj);
    const twin = p ? trackedProducts.get(p) : undefined;
    if (!twin && !hasAgentName(basename(proj), names)) continue;
    let touched = 0;
    for (const sub of ['', 'Assets', 'ProjectSettings']) {
      const dir = join(proj, sub);
      touched = Math.max(touched, mtime(dir));
      try { for (const n of readdirSync(dir)) touched = Math.max(touched, mtime(join(dir, n))); } catch { /* unreadable */ }
    }
    if (opts.copiesSinceMs !== undefined && touched < opts.copiesSinceMs) continue;
    out.push({ kind: 'copy', path: proj, of: twin ?? p ?? basename(proj), reason: 'copy', lastTouchedMs: touched, sizeBytes: null });
  }

  for (const l of out) l.sizeBytes = await d.sizeOf(l.path);
  return out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

function gb(bytes: number | null): string {
  return bytes === null ? 'size ?' : `${(bytes / 1e9).toFixed(1)} GB`;
}

function day(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : 'unknown';
}

/** A merged, clean worktree touched this recently may be a fresh one for a new card
 *  (its branch still sits at main), so it is not called safe yet. */
export const SAFE_QUIET_MS = DAY_MS;

const mergedWorktree = (l: Leftover): boolean => l.kind === 'worktree' && l.reason === 'merged';

/** Split leftovers into the ones safe to remove without asking (a linked worktree whose
 *  HEAD is already in main, with a clean tree, a passed closeout audit, quiet for
 *  SAFE_QUIET_MS), merged worktrees whose audit failed or never ran (needsAudit), and
 *  the stale rest, which need their owner's say. */
export function triageLeftovers(list: Leftover[], nowMs: number): { safe: Leftover[]; needsAudit: Leftover[]; stale: Leftover[] } {
  const safe: Leftover[] = [];
  const needsAudit: Leftover[] = [];
  const stale: Leftover[] = [];
  for (const l of list) {
    if (!mergedWorktree(l)) stale.push(l);
    else if (l.audit?.ok !== true) needsAudit.push(l);
    else (nowMs - l.lastTouchedMs >= SAFE_QUIET_MS ? safe : stale).push(l);
  }
  return { safe, needsAudit, stale };
}

/** The standup's Leftovers section, or null when there is nothing to list. Only the safe
 *  set is listed, each with its remove command; the stale rest is one count line. Paths
 *  under `home` are shown with `~`. */
export function formatLeftovers(list: Leftover[], home: string, nowMs = Date.now()): string | null {
  if (!list.length) return null;
  const tilde = (p: string): string => (home && p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p);
  const { safe, needsAudit, stale } = triageLeftovers(list, nowMs);
  const lines = safe.slice(0, REPORT_MAX_LINES).map((l) =>
    `- \`${tilde(l.path)}\`${l.branch ? ` [${l.branch}]` : ''} of ${basename(l.of)}: merged into ${l.into ?? 'main'}, clean, ${gb(l.sizeBytes)}, last touched ${day(l.lastTouchedMs)}. \`git -C ${tilde(l.of)} worktree remove ${tilde(l.path)}\``);
  const rest = safe.slice(REPORT_MAX_LINES);
  if (rest.length) lines.push(`- and ${rest.length} more (${gb(rest.reduce((s, l) => s + (l.sizeBytes ?? 0), 0))})`);
  const staleLine = stale.length
    ? `${stale.length} stale leftover(s) (${gb(stale.reduce((s, l) => s + (l.sizeBytes ?? 0), 0))}: idle, orphaned or outside git) not listed; they need their owner's say.`
    : '';
  const audit = needsAudit.length
    ? [`Merged worktrees that need audit before removal (${needsAudit.length}; nothing was removed):`,
      ...needsAudit.slice(0, REPORT_MAX_LINES).map((l) =>
        `- \`${tilde(l.path)}\`${l.branch ? ` [${l.branch}]` : ''} of ${basename(l.of)}: needs audit, ${l.audit ? l.audit.issues.join('; ') : 'not audited'}.`),
      ...(needsAudit.length > REPORT_MAX_LINES ? [`- and ${needsAudit.length - REPORT_MAX_LINES} more`] : [])]
    : [];
  if (!safe.length) {
    const head = staleLine ? `Leftovers: none safe to remove. ${staleLine}` : audit.length ? 'Leftovers: none safe to remove.' : null;
    return head ? [head, ...audit].join('\n') : null;
  }
  const total = gb(safe.reduce((s, l) => s + (l.sizeBytes ?? 0), 0));
  return [`Leftovers safe to remove (${safe.length}, ${total}; report only, nothing was removed):`, ...lines, ...(staleLine ? [staleLine] : []), ...audit].join('\n');
}
