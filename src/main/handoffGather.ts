/**
 * What the handoff note reads from disk besides the session log: the agent's cards,
 * its recent mail, its memory file and the git state of its worktrees. The session log
 * can be empty (agy keeps none), so these are what tell the next session where things stand.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pickCards, type BoardCard, type HandoffCard, type HandoffMail, type HandoffRepo } from './handoff';

const MAX_REPOS = 3;
const MAX_MAIL = 6;
/** Newest files parsed per mail folder; inbox/.done runs to hundreds. */
const MAIL_SCAN = 40;
const GIT_TIMEOUT_MS = 10_000;
const UNPUSHED_SHOWN = 5;

export interface GatherInput {
  hiveRoot: string;
  agentId: string;
  /** hiveScratchRoot(): the agent's worktrees are the git checkouts in <scratchRoot>/<agentId>/. */
  scratchRoot: string;
  tasks: readonly BoardCard[];
  nowMs: number;
  /** Repos the session log points at. */
  extraDirs?: string[];
  /** The session's cwd, used only when no worktree or log hint is a repo. */
  fallbackDir?: string;
}

export interface Gathered {
  cards: HandoffCard[];
  hiddenBlocked: number;
  mail: HandoffMail[];
  memory: string;
  repos: HandoffRepo[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => res(err ? '' : String(stdout)));
  });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

async function unpushed(top: string): Promise<NonNullable<HandoffRepo['unpushed']>> {
  const list = async (range: string[]): Promise<{ count: number; commits: string[] }> => ({
    count: Number((await git(top, ['rev-list', '--count', ...range])).trim()) || 0,
    commits: (await git(top, ['log', `-n${UNPUSHED_SHOWN}`, '--format=%h %s', ...range])).split('\n').filter(Boolean)
  });
  const upstream = (await git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  if (upstream) {
    const { count, commits } = await list(['@{u}..HEAD']);
    return count ? { label: `${plural(count, 'commit')} not pushed to ${upstream}`, commits } : { label: `up to date with ${upstream}`, commits: [] };
  }
  if (!(await git(top, ['remote'])).trim()) return { label: 'no remote configured', commits: [] };
  const { count, commits } = await list(['HEAD', '--not', '--remotes']);
  return count
    ? { label: `${plural(count, 'commit')} on no remote (branch has no upstream)`, commits }
    : { label: 'branch has no upstream; every commit is on a remote', commits: [] };
}

async function worktreeDirs(scratchRoot: string, agentId: string): Promise<string[]> {
  const base = join(scratchRoot, agentId);
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && existsSync(join(base, e.name, '.git'))).map((e) => join(base, e.name));
  } catch {
    return [];
  }
}

/** Git state of the agent's worktrees, dirty or unpushed ones first, then by newest HEAD. */
export async function gatherRepos(dirs: string[], fallbackDir?: string): Promise<HandoffRepo[]> {
  const seen = new Set<string>();
  const found: Array<{ repo: HandoffRepo; busy: boolean; headAt: number }> = [];
  const visit = async (dir: string): Promise<void> => {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    if (!top || seen.has(top)) return;
    seen.add(top);
    const [branch, head, headAt, status, diffStat, pushed] = await Promise.all([
      git(top, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(top, ['log', '-1', '--format=%h %s']),
      git(top, ['log', '-1', '--format=%ct']),
      git(top, ['status', '--short']),
      git(top, ['diff', '--stat']),
      unpushed(top)
    ]);
    found.push({
      repo: { path: top, status, diffStat, branch: branch.trim() || undefined, head: head.trim() || undefined, unpushed: pushed },
      busy: !!status.trim() || pushed.commits.length > 0,
      headAt: Number(headAt.trim()) || 0
    });
  };
  for (const dir of dirs) await visit(dir);
  if (!found.length && fallbackDir) await visit(fallbackDir);
  found.sort((a, b) => Number(b.busy) - Number(a.busy) || b.headAt - a.headAt);
  return found.slice(0, MAX_REPOS).map((f) => f.repo);
}

async function newestJson(dir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const stats = await Promise.all(names.map(async (n) => {
    try { return { path: join(dir, n), mtimeMs: (await stat(join(dir, n))).mtimeMs }; } catch { return null; }
  }));
  return stats.filter((s): s is { path: string; mtimeMs: number } => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAIL_SCAN);
}

/** The last messages the agent received and sent, oldest first, written no later than nowMs.
 *  Task patches to the harness are left out: the cards already show what they changed. */
export async function recentMail(agentDir: string, nowMs: number): Promise<HandoffMail[]> {
  const folders: Array<{ dir: string; way: 'in' | 'out' }> = [
    { dir: join(agentDir, 'inbox', '.done'), way: 'in' },
    { dir: join(agentDir, 'inbox'), way: 'in' },
    { dir: join(agentDir, 'outbox', '.sent'), way: 'out' },
    { dir: join(agentDir, 'outbox'), way: 'out' }
  ];
  const mail: HandoffMail[] = [];
  for (const { dir, way } of folders) {
    for (const f of await newestJson(dir)) {
      let m: Record<string, unknown>;
      try { m = JSON.parse(await readFile(f.path, 'utf8')) as Record<string, unknown>; } catch { continue; }
      if (!m || typeof m !== 'object' || m.to === 'harness' || m.act === 'task-patch') continue;
      const created = Date.parse(str(m.created_at));
      const atMs = way === 'in' && Number.isFinite(created) ? created : f.mtimeMs;
      if (atMs > nowMs) continue;
      const body = typeof m.body === 'string' ? m.body : m.body === undefined ? '' : JSON.stringify(m.body);
      mail.push({ atMs, dir: way, peer: str(way === 'in' ? m.from : m.to) || '?', act: str(m.act) || '?', subject: str(m.subject), body });
    }
  }
  return mail.sort((a, b) => a.atMs - b.atMs).slice(-MAX_MAIL);
}

async function memoryLine(agentDir: string): Promise<string> {
  const path = join(agentDir, 'memory.md');
  try {
    const s = await stat(path);
    return `Read ${path} before acting: your own digest (${s.size} chars, last written ${new Date(s.mtimeMs).toISOString()}).`;
  } catch {
    return `No memory file at ${path} yet.`;
  }
}

export async function gatherHandoff(input: GatherInput): Promise<Gathered> {
  const agentDir = join(input.hiveRoot, 'agents', input.agentId);
  const { cards, hiddenBlocked } = pickCards(input.tasks, input.agentId);
  const [mail, memory, worktrees] = await Promise.all([
    recentMail(agentDir, input.nowMs),
    memoryLine(agentDir),
    worktreeDirs(input.scratchRoot, input.agentId)
  ]);
  const repos = await gatherRepos([...worktrees, ...(input.extraDirs ?? [])], input.fallbackDir);
  return { cards, hiddenBlocked, mail, memory, repos };
}

/** Why the note has no session history, in words the next session can act on. */
export function logGapReason(o: { provider?: string; hadSession: boolean; logPath: string | null; logChars: number }): string {
  if (o.provider === 'antigravity') {
    return 'antigravity (agy) keeps no session log the harness can read, so there is no record of that session\'s last messages or tool calls; the mail above comes from your inbox and outbox folders.';
  }
  if (!o.hadSession) return 'The harness had no live session on record for this agent, so there was no log to read.';
  if (!o.logPath) return `No session log was found for the ${o.provider ?? 'previous'} session.`;
  if (!o.logChars) return `The session log at ${o.logPath} was empty or could not be read.`;
  return `The end of the session log at ${o.logPath} held no assistant messages or tool calls.`;
}
