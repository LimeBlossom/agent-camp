/**
 * Merges the harness runs itself once the human approves them on an ASK card.
 *
 * The Boss attaches an approve action to a merge sign-off question (ask_human
 * on_approve). A bare approve answer ("good") makes the harness run merge_preflight
 * and fast-forward the target; nothing here ever pushes. A moved target becomes a
 * rebase request to the worker and a retry on its next done. Everything else the
 * harness cannot settle (failed checks, a rebase that changed the approved commits,
 * a hedged or negative answer) goes to the Boss.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { mergePreflight, type PreflightCheck } from './mergePreflight';
import { agentsWithCwdUnder, ignoredNonCache, openCardsReferencing, processCwdsUnder, quoteNames, realpathOrNull } from './worktreeCloseout';

export interface PendingRebase {
  approvedAt: string;
  /** the human's answer, kept for the Boss mail if the retry fails. */
  answer: string;
  approvedHead: string;
  /** When the latest rebase request went out; the Boss hears if no done follows in time. */
  requestedAt: string;
  /** `git patch-id --stable` of the approved commits; the rebased branch must match. */
  patchIds: string[];
  attempts: number;
}

export interface ApproveAction {
  type: 'merge';
  repo: string;
  worktree: string;
  branch: string;
  target: string;
  /** The branch tip the human was shown; ask_human fills it at ask time. A different tip goes to the Boss. */
  head: string;
  /** The question this action belongs to; the harness binds it from humanQAAppend. */
  q?: string;
  askedAt?: string;
  pendingRebase?: PendingRebase;
}

/** Rebase requests per approval before the Boss takes over. */
export const MAX_REBASE_ROUNDS = 2;
/** How long a rebase request waits for the worker's done before the Boss takes over. */
export const APPROVED_REBASE_TIMEOUT_MS = 30 * 60 * 1000;

const ASK_KEYS = ['type', 'repo', 'worktree', 'branch', 'target', 'head'] as const;
const STORED_KEYS = new Set<string>([...ASK_KEYS, 'q', 'askedAt', 'pendingRebase']);
const SHA = /^[0-9a-f]{7,40}$/i;
/** A ref name git will not read as an option or a range. */
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** Null when `v` is a usable merge action, else why not. `input` is ask_human's argument,
 *  before it pins the head; `patch` is a ledger write (head required); `stored` also
 *  accepts the fields the harness adds after the ask lands. */
export function validateApproveAction(v: unknown, stage: 'input' | 'patch' | 'stored' = 'patch'): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'on_approve must be an object {type:"merge", repo, worktree, branch, target, head?}';
  const a = v as Record<string, unknown>;
  if ('push' in a) return 'on_approve never pushes; drop "push" (pushing stays with the human)';
  const allowed = stage === 'stored' ? STORED_KEYS : new Set<string>(ASK_KEYS);
  const extra = Object.keys(a).filter((k) => !allowed.has(k));
  if (extra.length) return `on_approve field not allowed: ${extra.join(', ')}`;
  if (a.type !== 'merge') return 'on_approve type must be "merge"';
  for (const k of ['repo', 'worktree', 'branch', 'target'] as const) {
    if (typeof a[k] !== 'string' || !(a[k] as string).trim()) return `on_approve needs ${k}`;
  }
  for (const k of ['repo', 'worktree'] as const) {
    if (!path.isAbsolute(a[k] as string)) return `on_approve ${k} must be an absolute path`;
  }
  for (const k of ['branch', 'target'] as const) {
    if (!REF.test(a[k] as string)) return `on_approve ${k} is not a plain branch name`;
  }
  if (a.head === undefined && stage !== 'input') return 'on_approve needs head, the branch tip the human is approving';
  if (a.head !== undefined && (typeof a.head !== 'string' || !SHA.test(a.head))) return 'on_approve head must be a commit sha';
  return null;
}

/** The commit `branch` points at, read from the worker's worktree; null if git cannot. */
export function resolveBranchTip(worktree: string, branch: string): string | null {
  const r = git(worktree, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  const sha = r.stdout.trim();
  return r.status === 0 && SHA.test(sha) ? sha : null;
}

/** The full sha of `head` when it names a commit reachable from `branch` in `worktree`; null otherwise. */
export function headOnBranch(worktree: string, branch: string, head: string): string | null {
  if (!SHA.test(head)) return null;
  const c = git(worktree, ['rev-parse', '--verify', '-q', `${head}^{commit}`]);
  const sha = c.stdout.trim();
  if (c.status !== 0 || !SHA.test(sha)) return null;
  return git(worktree, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]).status === 0 ? sha : null;
}

/** The fixed reply line appended to the question, so the human knows the word that merges. */
export function approveReplyLine(a: Pick<ApproveAction, 'branch' | 'target' | 'head'>): string {
  return `Reply **good** to merge \`${a.branch}\` @ \`${short(a.head)}\` into \`${a.target}\` (fast-forward only, nothing is pushed). Any other reply goes to the worker as a change request.`;
}

export type ApproveClass = 'approve' | 'ambiguous' | 'change';

const APPROVE_WORDS = ['good', 'approve', 'approved', 'lgtm', 'looks good', 'ship it', 'merge', 'merge it', 'yes', 'ok', 'okay'];
/** Approve words that, followed by more text, hedge the approval ("good but ..."). */
const APPROVE_LEADS = ['good', 'approve', 'approved', 'lgtm', 'looks good', 'ship it', 'merge'];
const NEGATIVE = /^(?:no|nope|nah|not|wait|hold|reject(?:ed)?|don'?t|do not|bad)\b/;

const normAnswer = (a: string): string =>
  a.trim().toLowerCase().replace(/^[\s`'"*_]+/, '').replace(/[\s`'"*_.!]+$/, '').replace(/\s+/g, ' ');

/** approve: the whole answer is one approve word. ambiguous: a hedged approve, a
 *  negative or a question, for the Boss. change: anything else, for the worker. */
export function classifyApproveAnswer(a: string): ApproveClass {
  const n = normAnswer(a);
  if (!n) return 'ambiguous';
  if (APPROVE_WORDS.includes(n)) return 'approve';
  if (n.includes('?') || NEGATIVE.test(n)) return 'ambiguous';
  if (APPROVE_LEADS.some((w) => n.startsWith(w) && /^[\s,;:.!-]/.test(n.slice(w.length)))) return 'ambiguous';
  return 'change';
}

export { latestNoteAwaitingMerge as notesAwaitingMerge } from './mergeNote';

type GitResult = { status: number; stdout: string; stderr: string };
const git = (cwd: string, args: string[], input?: string): GitResult => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};
const short = (sha: string): string => sha.slice(0, 8);

function patchIds(repo: string, range: string): string[] | null {
  const log = git(repo, ['log', '-p', '--no-color', '--no-merges', '--no-ext-diff', '--format=medium', range]);
  if (log.status !== 0) return null;
  const ids = git(repo, ['patch-id', '--stable'], log.stdout);
  if (ids.status !== 0) return null;
  return ids.stdout.split('\n').map((l) => l.split(' ')[0]).filter(Boolean).sort();
}

export type MergeAttempt =
  | { kind: 'merged'; head: string }
  | { kind: 'already-merged'; head: string; tip: string }
  | { kind: 'needs-rebase'; approvedHead: string; patchIds: string[] }
  | { kind: 'exception'; reason: string; checks?: PreflightCheck[] };

/** One merge attempt for an approved action: merge_preflight (no test run; the Boss
 *  reviewed the tests before asking), then `git merge --ff-only` of the fetched tip in
 *  the target repo. `expectPatchIds` is set on the retry after a rebase: the rebased
 *  commits must carry the same changes the human approved. Never pushes. */
export function attemptApprovedMerge(action: ApproveAction, expectPatchIds?: string[]): MergeAttempt {
  const invalid = validateApproveAction(action, 'stored');
  if (invalid) return { kind: 'exception', reason: invalid };
  const { repo, worktree, branch, target } = action;
  const current = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  if (current !== target) return { kind: 'exception', reason: `the target repo is on ${current || 'a detached HEAD'}, not ${target}` };

  const pf = mergePreflight({ repo, worktree, branch, target, skipTests: true });
  if (pf.error) return { kind: 'exception', reason: pf.error };
  const ff = pf.checks.find((c) => c.name === 'fast-forward');
  if (!ff || ff.detail.startsWith('git fetch failed')) return { kind: 'exception', reason: ff?.detail ?? 'fetch did not run', checks: pf.checks };
  const tip = git(repo, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}']).stdout.trim();
  if (!tip) return { kind: 'exception', reason: `could not read the fetched tip of ${branch}`, checks: pf.checks };
  if (!expectPatchIds && !tip.toLowerCase().startsWith(action.head.toLowerCase())) {
    return { kind: 'exception', reason: `${branch} head is ${short(tip)}, which moved since the ask (asked about ${short(action.head)})` };
  }
  if (git(repo, ['merge-base', '--is-ancestor', tip, target]).status === 0) {
    return { kind: 'already-merged', head: git(repo, ['rev-parse', target]).stdout.trim(), tip };
  }

  const failing = pf.checks.filter((c) => c.status === 'fail');
  const others = failing.filter((c) => c.name !== 'fast-forward');
  if (others.length) return { kind: 'exception', reason: others.map((c) => `${c.name}: ${c.detail}`).join('; '), checks: pf.checks };
  if (ff.status === 'fail') {
    if (expectPatchIds) return { kind: 'needs-rebase', approvedHead: tip, patchIds: expectPatchIds };
    const base = git(repo, ['merge-base', target, tip]).stdout.trim();
    const ids = base ? patchIds(repo, `${base}..${tip}`) : null;
    if (!ids) return { kind: 'exception', reason: `could not read the approved commits of ${branch}` };
    return { kind: 'needs-rebase', approvedHead: tip, patchIds: ids };
  }

  if (expectPatchIds) {
    const now = patchIds(repo, `${target}..${tip}`);
    if (!now || now.join() !== [...expectPatchIds].sort().join()) {
      return { kind: 'exception', reason: `the rebased ${branch} (${short(tip)}) differs from the commits the human approved, so it needs a fresh review` };
    }
  }
  const merge = git(repo, ['merge', '--ff-only', tip]);
  if (merge.status !== 0) return { kind: 'exception', reason: `fast-forward failed: ${(merge.stderr || merge.stdout).trim()}` };
  const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== tip) return { kind: 'exception', reason: `${target} is at ${short(head)} after the merge, expected ${short(tip)}` };
  return { kind: 'merged', head };
}

export interface CleanupResult {
  removed: boolean;
  reason: string;
  /** Closeout is switched off, so none of the checks ran. */
  disabled?: boolean;
}

export const CLEANUP_DISABLED_REASON = 'post-merge cleanup is off (config harnessMergeCleanup)';

export interface CloseoutOptions {
  repo: string; worktree: string; branch: string; target: string; head: string; workerId: string; scratchRoot: string;
  /** false skips everything and says so; unset counts as on (the caller already chose). */
  enabled?: boolean;
  /** The ledger after the merge: an open card naming the tree keeps it. */
  tasks?: readonly unknown[];
  /** Registered agents: one working in the tree keeps it. */
  agents?: Array<{ id: string; cwd?: string }>;
}

/** The one post-merge closeout. Removes the worker's worktree only when every check holds:
 *  it sits inside `<scratchRoot>/<workerId>/`, git lists it on the merged branch and
 *  unlocked, it has no changes or untracked files, its tip is the merged head, the branch
 *  is an ancestor of the target, no registered agent or running process works in it, no
 *  open card names it, and its ignored files are all regenerable caches. `git worktree
 *  remove` runs without --force, and the branch ref is kept. */
export function cleanupMergedWorktree(o: CloseoutOptions): CleanupResult {
  const keep = (reason: string): CleanupResult => ({ removed: false, reason });
  if (o.enabled === false) return { removed: false, reason: CLEANUP_DISABLED_REASON, disabled: true };
  const wt = realpathOrNull(o.worktree);
  const own = realpathOrNull(path.join(o.scratchRoot, o.workerId));
  if (!wt) return keep(`${o.worktree} does not exist`);
  if (!own || !wt.startsWith(own + path.sep)) return keep(`it is outside your own scratch folder ${path.join(o.scratchRoot, o.workerId)}`);
  if (wt === realpathOrNull(o.repo)) return keep('it is the main tree');

  const list = git(o.repo, ['worktree', 'list', '--porcelain']);
  if (list.status !== 0) return keep(`git worktree list failed: ${list.stderr.trim()}`);
  const blocks = list.stdout.split(/\n\n+/).filter(Boolean);
  const idx = blocks.findIndex((b) => {
    const m = /^worktree (.+)$/m.exec(b);
    return !!m && realpathOrNull(m[1]) === wt;
  });
  if (idx < 0) return keep('git does not list it as a worktree of the repo');
  if (idx === 0) return keep('it is the main worktree');
  const block = blocks[idx];
  if (!new RegExp(`^branch refs/heads/${o.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)) return keep(`it is not on ${o.branch}`);
  if (/^locked\b/m.test(block)) return keep('it is locked');

  const status = git(wt, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) return keep(`git status failed: ${status.stderr.trim()}`);
  if (status.stdout.trim()) return keep('it has uncommitted or untracked files');
  const wtHead = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
  const ref = git(o.repo, ['rev-parse', '--verify', '-q', `refs/heads/${o.branch}`]).stdout.trim();
  if (wtHead !== o.head || ref !== o.head) return keep(`its tip moved after the merge (${short(wtHead)}, branch ${short(ref)}, merged ${short(o.head)})`);
  if (git(o.repo, ['merge-base', '--is-ancestor', `refs/heads/${o.branch}`, o.target]).status !== 0) return keep(`${o.branch} is not merged into ${o.target}`);

  const agents = agentsWithCwdUnder(wt, o.agents ?? []);
  if (agents.length) return keep(`agent ${agents.join(', ')} has its cwd in it`);
  const procs = processCwdsUnder(wt);
  if ('error' in procs) return keep(procs.error);
  if (procs.pids.length) return keep(`process ${procs.pids.slice(0, 5).join(', ')} has its cwd in it (in use)`);
  const cards = openCardsReferencing(o.tasks ?? [], o.worktree);
  if (cards.length) return keep(`open card ${cards.join(', ')} still references it`);
  const ignored = ignoredNonCache((args) => {
    const r = git(wt, args);
    return r.status === 0 ? r.stdout : null;
  });
  if ('error' in ignored) return keep(ignored.error);
  if (ignored.files.length) return keep(`it holds ignored files that are not regenerable caches and need an audit: ${quoteNames(ignored.files)}`);

  const rm = git(o.repo, ['worktree', 'remove', wt]);
  if (rm.status !== 0) return keep(`git worktree remove refused: ${(rm.stderr || rm.stdout).trim()}`);
  return { removed: true, reason: 'merged, clean, tip unchanged, only regenerable ignored files' };
}

type CardRef = { id: string; title?: string };

export function mergedWorkerBody(card: CardRef, action: ApproveAction, answer: string, head: string, cleanup?: CleanupResult): string {
  const lines = [
    `The human answered "${answer}" on ${card.id} ("${card.title ?? ''}"). The harness merged ${action.branch} into ${action.target} (fast-forward to ${short(head)}); nothing was pushed. The card is closed as done.`
  ];
  if (cleanup?.disabled) {
    lines.push(`It kept your worktree ${action.worktree}: ${cleanup.reason}.`);
  } else if (cleanup) {
    lines.push(cleanup.removed
      ? `It removed your worktree ${action.worktree} (${cleanup.reason}); the branch ref is kept.`
      : `It kept your worktree ${action.worktree}: ${cleanup.reason}.`);
    lines.push('Now delete your own non-git scratch for this card (clips, builds, captures). Never touch anything shared or another agent\'s folder. Send the Boss one inform listing what you deleted and the size of each.');
  }
  return lines.join('\n');
}

export function rebaseRequestBody(card: CardRef, action: ApproveAction): string {
  return [
    `The human approved ${card.id} ("${card.title ?? ''}"), but ${action.target} moved since ${action.branch} was cut, so it no longer fast-forwards.`,
    `Rebase ${action.branch} onto ${action.target} in ${action.worktree}, rerun your tests, then send your done to the Boss naming ${card.id} as usual.`,
    'The harness retries the merge itself when that done arrives, as long as the rebased commits carry the same changes the human approved. Nothing is pushed.'
  ].join('\n');
}

export function bossExceptionNote(action: ApproveAction, reason: string): string {
  return `The card carries an approved merge of ${action.branch} into ${action.target}, but the harness did not merge: ${reason}. The card stays blocked; merge it yourself or send it back.`;
}

export function rebaseTimeoutReason(assignee: string, waitedMs: number): string {
  return `${assignee || 'the worker'} sent no done within ${Math.round(waitedMs / 60000)} min of the rebase request, so the harness dropped the held merge`;
}

export const AMBIGUOUS_NOTE = 'The card carries an approved-merge action, but this answer is not a plain approve, so the harness neither merged nor reopened the card.';

export function awaitingMergeNote(assignee: string, unblocked: boolean): string {
  return `This card was awaiting boss merge. The harness ${unblocked ? 'moved it to todo and ' : ''}mailed ${assignee} the answer as a change request.`;
}
