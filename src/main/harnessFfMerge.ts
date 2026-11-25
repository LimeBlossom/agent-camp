import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { humanWords } from './humanName';
import { loadMergeRepos, mentionsAny, namesProject, type MergeRepo } from './hiveProjects';
import { hasOpenHumanQA } from './autoUnblockDependents';
import { isArtWorkKind } from '../shared/workKind';


export interface HarnessFfMergeDeps {
  /** The repos to merge into; unset reads `<hive>/projects.json`. */
  repos?: readonly MergeRepo[];
  git?: (cwd: string, args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface HiveMessageLike {
  act?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  conversation?: unknown;
}

export type HarnessFfMergeOutcome =
  | {
      ok: true;
      repo: string;
      branch: string;
      head: string;
      target: string;
      testLine: string;
      cardId?: string;
      /** The worktree the branch was fetched from, when git lists one. */
      worktree?: string;
    }
  | {
      ok: false;
      repo: string;
      branch: string;
      target: string;
      reason: string;
      gate: 1 | 2 | 3;
      cardId?: string;
    }
  | {
      /** The named branch is merged but the worker's worktree is ahead: the Boss must pick the branch. */
      ok: false;
      refused: true;
      repo: string;
      branch: string;
      target: string;
      reason: string;
      cardId?: string;
    }
  | {
      /** Not merged and not a failure: nothing for the worker to redo, so no retry mail. */
      ok: false;
      skipped: true;
      /** Set when a the human/visual review must happen first; the Boss is mailed. */
      reviewGate?: true;
      /** Set when the branch's work is already on the target, so nothing is left unmerged. */
      alreadyMerged?: true;
      repo: string;
      branch: string;
      target: string;
      reason: string;
      cardId?: string;
    };



export interface RosterEntry {
  id: string;
  name?: string;
}

const defaultGit = (cwd: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    status: r.status ?? (r.error ? 1 : 0),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? r.error.message : '')
  };
};


const isRaw = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** True when `id` appears in `text` as a whole card id, not as part of a longer one. */
export function mentionsCardId(text: string, id: string): boolean {
  let at = text.indexOf(id);
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + id.length] ?? '';
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
    at = text.indexOf(id, at + 1);
  }
  return false;
}

/** The repo a card or done message targets: its project (or an alias), else the one repo its text mentions. */
export function resolveRepo(
  card: { project?: unknown; title?: unknown; description?: unknown } | null,
  text: string,
  repos: readonly MergeRepo[],
  branch?: string | null
): MergeRepo | null {
  const proj = typeof card?.project === 'string' ? card.project : '';
  // A card's own project outranks words in its text: a report on one repo may mention another.
  if (proj.trim()) return repos.find((r) => namesProject(r, proj)) ?? null;

  const fullText = [
    typeof card?.title === 'string' ? card.title : '',
    typeof card?.description === 'string' ? card.description : '',
    text,
    branch || ''
  ]
    .filter(Boolean)
    .join('\n');
  const mentioned = repos.filter((r) => r.mentions.length > 0 && mentionsAny(fullText, r.mentions));
  return mentioned.length === 1 ? mentioned[0] : null;
}

function cleanBranch(b: string): string {
  return b.replace(/^refs\/heads\//, '').replace(/^origin\//, '').replace(/[`'",;:]+$/, '').trim();
}

const RESERVED_BRANCHES = new Set(['head', 'master', 'main', 'origin', 'fetch_head', 'upstream']);

function isValidBranch(b: string): boolean {
  const c = cleanBranch(b).toLowerCase();
  return c.length > 0 && !RESERVED_BRANCHES.has(c);
}

const BRANCH_PATTERNS: readonly RegExp[] = [
  // branch <name> / branch: <name> / branch @ <name> / branch `<name>`
  /(?:^|[\s`'"(])branch\s*(?::|@|is)?\s*[`'"]?([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)[`'"]?/i,
  // on <worker/branch>
  /(?:^|[\s`'"(])on\s+[`'"]?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)[`'"]?/i,
  // rebased <worker/branch>
  /(?:^|[\s`'"(])rebased\s+[`'"]?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)[`'"]?/i
];

function branchNamedIn(source: string): string | null {
  for (const re of BRANCH_PATTERNS) {
    const m = re.exec(source);
    if (m && isValidBranch(m[1])) return cleanBranch(m[1]);
  }
  return null;
}

/** Extract branch name from card data, message text, and optionally verify against repo branches. */
export function extractBranchName(
  card: { branch?: unknown; brief?: unknown; notes?: unknown } | null,
  text: string,
  repo?: string,
  gitCmd = defaultGit
): string | null {
  if (typeof card?.branch === 'string' && isValidBranch(card.branch)) {
    return cleanBranch(card.branch);
  }

  const sources = [text, typeof card?.brief === 'string' ? card.brief : '', typeof card?.notes === 'string' ? card.notes : ''].filter(Boolean);
  // Source order outranks pattern order: the done message is the latest word, and a brief
  // still names the branch of an earlier round that may already be merged.
  for (const source of sources) {
    const named = branchNamedIn(source);
    if (named) return named;
  }

  return repo ? knownBranchIn(repo, sources.join('\n'), gitCmd) : null;
}

/** The longest existing local branch of `repo` named verbatim in `text`. */
function knownBranchIn(repo: string, text: string, gitCmd = defaultGit): string | null {
  const branchRes = gitCmd(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (branchRes.status !== 0) return null;
  const known = branchRes.stdout.split('\n').map((l) => l.trim()).filter((b) => isValidBranch(b));
  // Sort longer branch names first to prevent partial prefix matches
  known.sort((a, b) => b.length - a.length);
  return known.find((b) => text.includes(b)) ?? null;
}

/** Full sha of `rev` in `repo`, or null when it names no commit there. */
function resolveCommit(repo: string, rev: string, gitCmd = defaultGit): string | null {
  const r = gitCmd(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The first commit of `repo` that a hex token of `text` (7 to 40 digits) names, else null. */
function headNamedIn(repo: string, text: string, gitCmd = defaultGit): string | null {
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    const sha = resolveCommit(repo, m[0], gitCmd);
    if (sha) return sha;
  }
  return null;
}

/** Parses dirty paths from `git status --porcelain`. */
export function parseDirtyPaths(porcelainOutput: string): Set<string> {
  const paths = new Set<string>();
  const lines = porcelainOutput.split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.length < 3) continue;
    let p = line.slice(3).trim();
    if (p.includes(' -> ')) {
      const parts = p.split(' -> ');
      for (const part of parts) {
        let clean = part.trim();
        if (clean.startsWith('"') && clean.endsWith('"')) {
          clean = clean.slice(1, -1);
        }
        if (clean) paths.add(clean);
      }
      continue;
    }
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1);
    }
    if (p) paths.add(p);
  }
  return paths;
}

/** Result summaries that mean the run failed. */
const FAILURE_PATTERNS = [
  /\bPassed!\s*-\s*Failed:\s*([1-9]\d*)/gi,
  /\bFailed:?\s*([1-9]\d*)/gi,
  /\bfailed=([1-9]\d*)/gi,
  /^#\s*fail\s+([1-9]\d*)/gim,
  /\bnode\s+--test\s+(\d+)\/(?!\1\b)\d+/gi,
  // Python unittest
  /\bFAILED\s*\((?:failures|errors)=\d+/g,
  /\b([1-9]\d*)\s+(?:test|check)s?\s+fail(?:ed)?\b/gi,
  /\b([1-9]\d*)\s+FAIL\s+lines?\b/gi,
  /\b([1-9]\d*)\s+errors?\s+CS\b/gi,
  /\b([1-9]\d*)\s+CS\s+errors?\b/gi,
  // NUnit results.xml <test-run ... failed="2" ...>
  /<test-run\b[^>]*\bfailed="[1-9]\d*"[^>]*>/gi
];

/** Result summaries that mean the run passed. */
const PASSING_PATTERNS = [
  // dotnet test
  /\bPassed!?\s*-?\s*Failed:?\s*0\b/gi,
  /\bFailed:\s*0,\s*Passed:\s*\d+/gi,
  /\bPassed\s+(\d+)\/\1\b/gi,
  // node --test
  /^#\s*fail\s+0\b/gim,
  /\bnode\s+--test\s+(\d+)\/\1\b/gi,
  // Python unittest; "Ran 0 tests" is no evidence
  /\bRan\s+[1-9]\d*\s+tests?\s+in\s+[\d.]+s\s*OK\b/gi,
  // Unity compile / Tundra
  /\bTundra build success\b/gi,
  /\b0\s+error\s+CS\b/gi,
  /\b0\s+CS\s+errors?\b/gi,
  // Game broker / runner test outputs
  /\bALL\s+PASS\b/g,
  /\b(?:total|passed)=\d+.*?\bfailed=0\b/gi,
  /\b\d+\/\d+\s+checks\s+PASS\b/gi,
  /\b\d+\/\d+\s+pass(?:ed)?\b/gi,
  /\b\d+\s+pass(?:ed)?,\s*0\s+fail(?:ed)?\b/gi,
  // NUnit results.xml <test-run ... result="Passed" ... failed="0" ...>
  /<test-run\b(?=[^>]*\bresult="Passed")(?=[^>]*\bfailed="0")[^>]*>/gi
];

const LABELLED_RESULT = /(?:verbatim(?:\s+output|\s+final\s+line)?|test(?:s|\s+suite)?):\s*[`'"]?([^\n`'"]+)/i;

/**
 * Extracts a verbatim test result line from message text, or reports why it failed.
 *
 * The LAST result summary in the text decides. A report that shows an intentional
 * red-first run and then a green final run passes; a green run followed by a red one,
 * or red evidence with no later green result, is refused. Only recognised summary
 * formats count, so arbitrary failure wording after a pass cannot be waved through
 * and a later pass cannot be fabricated from prose.
 */
export function extractVerbatimTestLine(text: string): { ok: boolean; line?: string; reason?: string } {
  const events: Array<{ at: number; end: number; pass: boolean }> = [];
  for (const [patterns, pass] of [[FAILURE_PATTERNS, false], [PASSING_PATTERNS, true]] as const) {
    for (const pat of patterns) {
      for (const m of text.matchAll(pat)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        if (pass && /\b0\s+pass(?:ed)?\b/i.test(m[0]) && !/\bfailed:?\s*0\b/i.test(m[0])) continue;
        events.push({ at, end, pass });
      }
    }
  }

  if (events.length) {
    // The latest summary wins; at the same position a failure beats a pass.
    events.sort((a, b) => a.at - b.at || Number(b.pass) - Number(a.pass));
    let last = events[events.length - 1];
    if (last.pass) {
      // Report the first line of the final all-green stretch, after any red-first run.
      let k = events.length - 1;
      while (k > 0 && events[k - 1].pass) k--;
      last = events[k];
    }
    const lineStart = text.lastIndexOf('\n', last.at) + 1;
    const nl = text.indexOf('\n', last.end);
    const line = text.slice(lineStart, nl < 0 ? undefined : nl).trim();
    return last.pass ? { ok: true, line } : { ok: false, reason: `tests failed: ${line}` };
  }

  const labelled = LABELLED_RESULT.exec(text);
  if (labelled) return { ok: true, line: labelled[1] };

  return { ok: false, reason: 'done message is missing a verbatim test result line' };
}

/** Finds worktree path for branch if known in `git worktree list --porcelain`, or falls back to `.`. */
export function findWorktree(repo: string, branch: string, text?: string, gitCmd = defaultGit): string {
  const res = gitCmd(repo, ['worktree', 'list', '--porcelain']);
  if (res.status === 0) {
    const blocks = res.stdout.split(/\n\n+/);
    for (const block of blocks) {
      const pathMatch = /^worktree (.+)$/m.exec(block);
      const branchMatch = /^branch refs\/heads\/(.+)$/m.exec(block);
      if (pathMatch && branchMatch && branchMatch[1] === branch) {
        return pathMatch[1];
      }
    }
  }

  if (text) {
    const wtMatch = /(?:^|[\s`'"(=:])(\/[^\s`'"()<>|,;*]+(?:worktree|[\w.-]+))/i.exec(text);
    if (wtMatch) {
      const candidate = wtMatch[1];
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }

  return '.';
}


/** The worktree that has `branch` checked out, or null; `main` is true for the repo's own tree. */
function checkoutOf(repo: string, branch: string, gitCmd = defaultGit): { path: string; main: boolean } | null {
  const res = gitCmd(repo, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return null;
  const blocks = res.stdout.split(/\n\n+/);
  for (let i = 0; i < blocks.length; i++) {
    const at = /^worktree (.+)$/m.exec(blocks[i]);
    const on = /^branch refs\/heads\/(.+)$/m.exec(blocks[i]);
    if (at && on && on[1] === branch) return { path: at[1], main: i === 0 };
  }
  return null;
}

/** Why `target` cannot take a merge in `repo`, or null when it is a local branch there. */
function missingTarget(repo: string, target: string, gitCmd = defaultGit): string | null {
  return resolveCommit(repo, `refs/heads/${target}`, gitCmd) ? null : `target branch ${target} does not exist in ${repo}`;
}

/** The worktree's HEAD sha when it holds commits `target` lacks, else null. */
function worktreeAheadOf(repo: string, worktree: string, target: string, gitCmd = defaultGit): string | null {
  if (!worktree || worktree === '.') return null;
  const head = resolveCommit(worktree, 'HEAD', gitCmd);
  if (!head) return null;
  if (gitCmd(repo, ['fetch', worktree, head]).status !== 0) return null;
  return gitCmd(repo, ['merge-base', '--is-ancestor', head, target]).status === 0 ? null : head;
}

/** True when every commit FETCH_HEAD holds beyond `target` has a patch-id twin on it. */
function allPatchesOn(repo: string, target: string, gitCmd = defaultGit): boolean {
  const res = gitCmd(repo, ['cherry', target, 'FETCH_HEAD']);
  if (res.status !== 0) return false;
  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => l.startsWith('-'));
}

/** Checks the 3 gates for auto-merging:
 *  1. branch ff-merges onto current main (git fetch first)
 *  2. touches none of the human's uncommitted/dirty files in the main tree
 *  3. done message carries a verbatim test result line
 *  When all pass, performs `git merge --ff-only FETCH_HEAD` into current target (never pushed).
 */
export function evaluateAndExecuteFfMerge(opts: {
  repo: string;
  /** The integration branch to fast-forward. */
  target: string;
  branch: string;
  text: string;
  cardId?: string;
  worktree?: string;
  /** The Boss is closing the card, so work it already merged by hand is skipped too. */
  closing?: boolean;
  gitCmd?: (cwd: string, args: string[]) => { status: number; stdout: string; stderr: string };
}): HarnessFfMergeOutcome {
  const gitCmd = opts.gitCmd || defaultGit;
  const repo = opts.repo;
  const branch = opts.branch;
  const target = opts.target;
  const absent = missingTarget(repo, target, gitCmd);
  if (absent) return { ok: false, skipped: true, repo, branch, target, reason: absent, cardId: opts.cardId };
  const refuse = (reason: string): HarnessFfMergeOutcome => ({ ok: false, refused: true, repo, branch, target, reason, cardId: opts.cardId });
  if (branch === target) {
    const named = headNamedIn(repo, opts.text, gitCmd);
    if (named && gitCmd(repo, ['merge-base', '--is-ancestor', named, target]).status === 0) {
      return { ok: false, skipped: true, repo, branch, target, reason: `${named.slice(0, 8)} named in the report is already on ${target}`, cardId: opts.cardId, alreadyMerged: true };
    }
    return refuse(`${branch} is the target branch of ${repo}, so there is nothing to merge it into: name the worker branch`);
  }
  const checkout = checkoutOf(repo, target, gitCmd);
  if (checkout && !checkout.main) {
    return refuse(`${target} is checked out in worktree ${checkout.path}, so moving its ref would leave that tree stale: merge by hand`);
  }
  const worktree = opts.worktree || findWorktree(repo, branch, opts.text, gitCmd);

  // Gate 1: Fetch first
  const fetchRes = gitCmd(repo, ['fetch', worktree, branch]);
  if (fetchRes.status !== 0) {
    return {
      ok: false,
      repo,
      branch,
      target,
      gate: 1,
      reason: `git fetch failed: ${(fetchRes.stderr || fetchRes.stdout).trim()}`,
      cardId: opts.cardId
    };
  }

  // A re-sent or late report for work already on the target: nothing to merge or redo.
  if (gitCmd(repo, ['merge-base', '--is-ancestor', 'FETCH_HEAD', target]).status === 0) {
    const integrated = `${branch} is already integrated into ${target}`;
    const ahead = worktreeAheadOf(repo, worktree, target, gitCmd);
    if (ahead) {
      return {
        ok: false,
        refused: true,
        repo,
        branch,
        target,
        reason: `${integrated}, but worktree ${worktree} HEAD ${ahead.slice(0, 8)} is ahead of ${target}: the new work is on another branch, so nothing was merged`,
        cardId: opts.cardId
      };
    }
    return { ok: false, skipped: true, repo, branch, target, reason: integrated, cardId: opts.cardId, alreadyMerged: true };
  }
  if (opts.closing && allPatchesOn(repo, target, gitCmd)) {
    return { ok: false, skipped: true, repo, branch, target, reason: `every commit of ${branch} is already on ${target} by patch-id`, cardId: opts.cardId, alreadyMerged: true };
  }

  // Gate 3: verbatim test result line
  const testCheck = extractVerbatimTestLine(opts.text);
  if (!testCheck.ok) {
    return {
      ok: false,
      repo,
      branch,
      target,
      gate: 3,
      reason: testCheck.reason || 'done message is missing a verbatim test result line',
      cardId: opts.cardId
    };
  }

  // Gate 1: Check fast-forward (target is ancestor of FETCH_HEAD)
  const ffRes = gitCmd(repo, ['merge-base', '--is-ancestor', target, 'FETCH_HEAD']);
  if (ffRes.status !== 0) {
    return {
      ok: false,
      repo,
      branch,
      target,
      gate: 1,
      reason: `branch does not fast-forward onto ${target} (target has diverged or moved)`,
      cardId: opts.cardId
    };
  }

  // Gate 2: Check dirty paths in target tree
  const statusRes = gitCmd(repo, ['status', '--porcelain']);
  if (statusRes.status !== 0) {
    return {
      ok: false,
      repo,
      branch,
      target,
      gate: 2,
      reason: `git status failed: ${(statusRes.stderr || statusRes.stdout).trim()}`,
      cardId: opts.cardId
    };
  }

  const dirtyPaths = parseDirtyPaths(statusRes.stdout);
  if (dirtyPaths.size > 0) {
    const logRes = gitCmd(repo, ['log', `${target}..FETCH_HEAD`, '--name-only', '--format=']);
    if (logRes.status === 0) {
      const touched = logRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const conflicts: string[] = [];
      for (const file of touched) {
        if (dirtyPaths.has(file)) {
          conflicts.push(file);
        } else {
          for (const d of dirtyPaths) {
            if (d.endsWith('/') && file.startsWith(d)) {
              conflicts.push(file);
              break;
            }
          }
        }
      }
      if (conflicts.length > 0) {
        return {
          ok: false,
          repo,
          branch,
          target,
          gate: 2,
          reason: `incoming commits touch dirty files in main tree: ${conflicts.slice(0, 10).join(', ')}`,
          cardId: opts.cardId
        };
      }
    }
  }

  // All 3 gates passed: perform fast-forward merge into target (never push!)
  // the human's main tree keeps whatever it has checked out: only a target it is on moves through a merge.
  const before = resolveCommit(repo, `refs/heads/${target}`, gitCmd) as string;
  const mergeRes = checkout
    ? gitCmd(repo, ['merge', '--ff-only', 'FETCH_HEAD'])
    : gitCmd(repo, ['update-ref', `refs/heads/${target}`, 'FETCH_HEAD', before]);
  if (mergeRes.status !== 0) {
    return {
      ok: false,
      repo,
      branch,
      target,
      gate: 1,
      reason: `Fast-forward merge failed: ${(mergeRes.stderr || mergeRes.stdout).trim()}`,
      cardId: opts.cardId
    };
  }

  const head = resolveCommit(repo, `refs/heads/${target}`, gitCmd) as string;

  return {
    ok: true,
    repo,
    branch,
    head,
    target,
    testLine: testCheck.line || '',
    cardId: opts.cardId,
    ...(worktree !== '.' ? { worktree } : {})
  };
}

/** Tip of `branch` in `repo`, or in its worktree when that is a separate clone. */
function branchTip(repo: string, branch: string, text: string, gitCmd = defaultGit): string | null {
  const ref = `refs/heads/${branch}`;
  const inRepo = resolveCommit(repo, ref, gitCmd);
  if (inRepo) return inRepo;
  const wt = findWorktree(repo, branch, text, gitCmd);
  return wt !== '.' ? resolveCommit(wt, ref, gitCmd) : null;
}

function branchExists(repo: string, branch: string, text: string, gitCmd = defaultGit): boolean {
  return branchTip(repo, branch, text, gitCmd) !== null;
}

const workerKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The other roster worker whose name prefixes `branch` (`maple/...`), or null. */
function branchOwner(branch: string, sender: string, roster?: readonly RosterEntry[]): string | null {
  const slash = branch.indexOf('/');
  if (slash <= 0 || !roster) return null;
  const prefix = workerKey(branch.slice(0, slash));
  const keys = (a: RosterEntry): string[] => [a.name ? workerKey(a.name) : '', workerKey(a.id), workerKey(a.id.replace(/-[a-z0-9]+$/i, ''))].filter(Boolean);
  const self = roster.find((a) => a.id === sender);
  if (self ? keys(self).includes(prefix) : workerKey(sender.replace(/-[a-z0-9]+$/i, '')) === prefix) return null;
  const other = roster.find((a) => a.id !== sender && keys(a).includes(prefix));
  return other ? other.id : null;
}

/** A done report or card note that declares a review still pending ("taste gate requested", "awaiting the human"). */
export function pendingGateRe(env: Record<string, string | undefined> = process.env): RegExp {
  const h = humanWords(env);
  return new RegExp(`(?:\\w+\\s+)?taste\\s+(?:gate|review)\\s+(?:is\\s+)?(?:requested|pending|open|awaiting)|(?:gate|review)\\s+(?:is\\s+)?(?:requested|pending)\\b|awaiting\\s+(?:${h}|taste|\\w+\\s+(?:gate|review))\\b|${h}\\s+(?:review\\s+)?ask\\s+(?:after|pending|next)|pending\\s+(?:${h}|taste)\\b`, 'i');
}

/** Why a done must not auto-merge before a review, or null. */
export function reviewGateReason(card: Record<string, unknown>, text: string): string | null {
  if (hasOpenHumanQA(card)) return 'the card has an unanswered question for the human (humanQA)';
  if (isArtWorkKind(card.kind)) return `the card is an art kind (${card.kind}) and needs review before merge`;
  const notes = Array.isArray(card.notes) ? card.notes.join('\n') : typeof card.notes === 'string' ? card.notes : '';
  const gate = pendingGateRe();
  if (gate.test(text) || gate.test(notes)) return 'the done report or card notes declare a pending review gate';
  return null;
}

/** Handles a worker's done message for auto-ff-merge into a merge repo (projects.json).
 *  Returns null when the message is not a done naming a branch head in one.
 */
export function handleHarnessFfMerge(
  sender: string,
  msg: HiveMessageLike,
  tasks: readonly unknown[],
  deps?: HarnessFfMergeDeps,
  roster?: readonly RosterEntry[],
  closing = false
): HarnessFfMergeOutcome | null {
  if (msg.act !== 'done') return null;

  const mine = tasks.filter((t): t is Record<string, unknown> => isRaw(t) && typeof t.id === 'string' && t.assignee === sender);
  const text = [
    typeof msg.subject === 'string' ? msg.subject : '',
    typeof msg.body === 'string' ? msg.body : '',
    typeof msg.conversation === 'string' ? msg.conversation : ''
  ].join('\n');

  const named = mine.filter((t) => mentionsCardId(text, t.id as string));
  const doing = mine.filter((t) => t.status === 'doing');
  const blocked = mine.filter((t) => t.status === 'blocked');
  const card = named.length === 1 ? named[0] : named.length === 0 && doing.length === 1 ? doing[0] : named.length === 0 && blocked.length === 1 ? blocked[0] : null;
  // Only the assignee's handoff on its own card runs the gates; an unattributed report is no handoff.
  if (!card) return null;

  const gitCmd = deps?.git || defaultGit;
  const repos = deps?.repos ?? loadMergeRepos();

  let branch = extractBranchName(card, text);
  let spec = resolveRepo(card, text, repos) ?? (branch ? resolveRepo(card, text, repos, branch) : null);
  // A card with no project and no telling words: the repo that has the branch.
  if (!spec && branch && !(typeof card?.project === 'string' && card.project.trim())) {
    spec = repos.find((r) => existsSync(r.path) && gitCmd(r.path, ['rev-parse', '--verify', `refs/heads/${branch}`]).status === 0) ?? null;
  }
  if (!spec) return null; // No merge repo for this card
  const repo = spec.path;
  if (!branch) {
    branch = extractBranchName(card, text, repo, gitCmd);
  }
  // A branch read from prose must be a real ref, or the report is not a merge handoff
  // (a critique saying "the branch of the design" names no branch).
  let declared = typeof card?.branch === 'string' && isValidBranch(card.branch);
  // A card's declared branch can be an earlier round's; a real branch the done names is newer.
  const fromDone = declared ? branchNamedIn(text) : null;
  if (fromDone && fromDone !== branch && branchExists(repo, fromDone, text, gitCmd)) {
    branch = fromDone;
    declared = false;
  }
  if (branch && !declared && !branchExists(repo, branch, text, gitCmd)) {
    const known = knownBranchIn(repo, text, gitCmd);
    branch = known && branchExists(repo, known, text, gitCmd) ? known : null;
  }
  if (!branch) return null; // No branch named

  const cardId = typeof card?.id === 'string' ? card.id : undefined;
  const target = spec.branch;
  const skip = (reason: string): HarnessFfMergeOutcome => ({ ok: false, skipped: true, repo, branch: branch as string, target, reason, cardId });

  if (card?.merge === false) return skip(`card ${cardId} was closed as dropped (merge: false)`);
  if (card?.status === 'done') return skip(`card ${cardId} is already closed`);

  // The Boss closing a card is the merge decision itself; a worker's done must wait for the review.
  if (!closing && card) {
    const gate = reviewGateReason(card, text);
    if (gate) return { ...skip(`${gate}; merge via ask_human on_approve or a Boss merge`), reviewGate: true } as HarnessFfMergeOutcome;
  }

  // The card's own testsReady branch is the tests-first handoff the assignee implements on.
  const ready = isRaw(card?.testsReady) ? card.testsReady : null;
  const handedOff = ready?.branch === branch;
  const owner = branchOwner(branch, sender, roster);
  if (!declared && !handedOff && owner) return skip(`${branch} belongs to ${owner}, not to ${sender}`);

  // A tests-first handoff is red on purpose and waits for the Boss to accept the tests.
  if (ready && typeof ready.head === 'string') {
    const tip = branchTip(repo, branch, text, gitCmd);
    const testsHead = resolveCommit(repo, ready.head, gitCmd);
    if (tip && testsHead && tip === testsHead) {
      return skip(`tests-first handoff at testsReady head ${ready.head} awaits Boss review`);
    }
  }

  return evaluateAndExecuteFfMerge({
    repo,
    target,
    branch,
    text,
    cardId,
    closing,
    gitCmd
  });
}
