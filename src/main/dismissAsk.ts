/**
 * What a dismissed ASK ME question tells the Boss. Dismissing only stamps `dismissedAt`
 * on the ask; the card stays open and blocked, with its branches, worktrees and folders
 * still around. The Boss gets one mail naming those loose ends and decides what happens
 * to the card. Nothing here deletes or closes anything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type HarnessFfMergeDeps } from './harnessFfMerge';
import { loadMergeRepos } from './hiveProjects';

type Ask = { q?: unknown; a?: unknown; askedAt?: unknown; dismissedAt?: unknown; supersededBy?: unknown; movedToResultsAt?: unknown };
/** The card fields this module reads. No index signature: HiveTask is an interface and would not satisfy one. */
type CardLike = { id?: unknown; humanQA?: unknown; testsReady?: unknown; description?: unknown; notes?: unknown; brief?: unknown; result?: unknown };

export interface LooseBranch { repo: string; branch: string; merged: boolean }
export interface LooseEnds { branches: LooseBranch[]; worktrees: string[]; folders: string[] }

const asks = (c: unknown): Ask[] => {
  const qa = (c as CardLike | null | undefined)?.humanQA;
  return Array.isArray(qa) ? qa.filter((e): e is Ask => !!e && typeof e === 'object') : [];
};
const keyOf = (e: Ask): string => `${String(e.askedAt ?? '')}\u0000${String(e.q ?? '')}`;

/** Asks the user dismissed between two versions of a card: not answered, not retired by a newer ask or moved to Results. */
export function newlyDismissedAsks(before: unknown, after: unknown): Ask[] {
  const was = new Map(asks(before).map((e) => [keyOf(e), e]));
  return asks(after).filter((e) => {
    if (typeof e.q !== 'string' || e.a || !e.dismissedAt || e.supersededBy || e.movedToResultsAt) return false;
    const prior = was.get(keyOf(e));
    return !!prior && !prior.dismissedAt;
  });
}

type Git = NonNullable<HarnessFfMergeDeps['git']>;
const defaultGit: Git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const CARD_TEXT_FIELDS = ['description', 'notes', 'brief', 'result'] as const;
const cardText = (c: CardLike): string =>
  CARD_TEXT_FIELDS.map((k) => { const v = c[k]; return Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : ''; }).join('\n');

const FOLDER_TOKEN = /[^\s"'`()<>,;]*(?:research|shots)[^\s"'`()<>,;]*/gi;

/** Branches (named by the card id, or declared by testsReady), their worktrees, and research or shots folders the card text names. */
export function looseEnds(card: CardLike, deps: { repos?: HarnessFfMergeDeps['repos']; git?: Git; hiveRoot?: string | null } = {}): LooseEnds {
  const git = deps.git ?? defaultGit;
  const id = String(card.id ?? '');
  const out: LooseEnds = { branches: [], worktrees: [], folders: [] };
  const declared = (card.testsReady as { branch?: unknown; worktree?: unknown } | undefined) ?? {};
  const repos = deps.repos ?? loadMergeRepos(deps.hiveRoot);
  for (const spec of repos) {
    const repo = spec.path;
    if (!repo || !existsSync(repo)) continue;
    const target = spec.branch;
    const listed = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (listed.status !== 0) continue;
    const names = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const mine = names.filter((n) => (id && n.includes(id)) || n === declared.branch);
    for (const branch of mine) {
      const merged = git(repo, ['merge-base', '--is-ancestor', branch, target]).status === 0;
      out.branches.push({ repo, branch, merged });
    }
    const trees = git(repo, ['worktree', 'list', '--porcelain']);
    let path = '';
    let branch = '';
    const flush = (): void => {
      if (path && path !== resolve(repo) && (mine.includes(branch) || (id && path.includes(id)) || path === declared.worktree) && !out.worktrees.includes(path)) out.worktrees.push(path);
      path = ''; branch = '';
    };
    for (const line of trees.stdout.split('\n')) {
      if (line.startsWith('worktree ')) { flush(); path = line.slice(9).trim(); }
      else if (line.startsWith('branch ')) branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    flush();
  }
  for (const token of cardText(card).match(FOLDER_TOKEN) ?? []) {
    const p = token.replace(/[.:]+$/, '');
    const abs = isAbsolute(p) ? p : deps.hiveRoot ? join(deps.hiveRoot, p) : '';
    if (abs && existsSync(abs) && !out.folders.includes(abs)) out.folders.push(abs);
  }
  return out;
}

export function dismissMailBody(card: { id: string; title?: string; assignee?: string }, ask: { q?: unknown }, ends: LooseEnds): string {
  const lines = [
    `The human dismissed the ASK ME question on card ${card.id} ("${card.title ?? card.id}", assignee ${card.assignee || 'none'}) without answering it:`,
    `  Q: ${String(ask.q ?? '')}`,
    'The card is still open and blocked; the harness has not closed it or removed anything.',
  ];
  const any = ends.branches.length + ends.worktrees.length + ends.folders.length > 0;
  if (!any) lines.push('No branches, worktrees or folders are tied to this card.');
  else {
    lines.push('Loose ends tied to the card:');
    for (const b of ends.branches) lines.push(`  branch ${b.branch} in ${b.repo}: ${b.merged ? 'merged' : 'unmerged'}`);
    for (const w of ends.worktrees) lines.push(`  worktree ${w}`);
    for (const f of ends.folders) lines.push(`  folder ${f}`);
  }
  lines.push(
    'Decide, and you close it: (a) close it as dropped (patch_card status done, merge false, a result saying why, then remove the loose ends above if wanted), (b) keep the card (re-plan it or ask again), or (c) reassign it.'
  );
  return lines.join('\n');
}
