import { spawnSync } from 'node:child_process';

export interface PreflightOptions {
  repo: string;
  worktree: string;
  branch: string;
  target: string;
  /** Shell command run in the worktree; exit 0 passes. */
  testCommand?: string;
  /** Accept a merge with no test run (the check reports skip instead of fail). */
  skipTests?: boolean;
  testTimeoutSec?: number;
}

export interface PreflightCheck {
  name: 'clean-tree' | 'fast-forward' | 'tests' | 'no-stray-files';
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  verdict: 'pass' | 'fail';
  checks: PreflightCheck[];
  error?: string;
}

export const DEFAULT_TEST_TIMEOUT_SEC = 900;
const OUTPUT_TAIL_CHARS = 1500;

/** Added files that are scratch output rather than source: editor and merge leftovers,
 *  logs, temp files, build and dependency folders, commit-message scratch. */
export const STRAY_PATH = /(?:^|\/)(?:node_modules|dist|out|tmp|\.tmp|coverage)\/|\.(?:orig|rej|bak|swp|tmp|log)$|(?:^|\/)(?:\.DS_Store|Thumbs\.db|COMMIT_MSG\w*|MSG|core(?:\.\d+)?)$/;

export function strayPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => STRAY_PATH.test(p));
}

const git = (cwd: string, args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const lines = (s: string): string[] => s.split('\n').map((l) => l.trimEnd()).filter(Boolean);

/** Read-only checks before a `merge`: both trees clean, the target fast-forwards to the
 *  branch, the tests pass in the worktree, and the branch adds no stray files. Only
 *  `git fetch` writes (FETCH_HEAD), as `merge` itself does. */
export function mergePreflight(o: PreflightOptions): PreflightResult {
  if (!o.repo || !o.worktree || !o.branch || !o.target) {
    return { ok: false, verdict: 'fail', checks: [], error: 'repo, worktree, branch, and target are all required.' };
  }
  const checks: PreflightCheck[] = [];

  const repoDirty = git(o.repo, ['status', '--porcelain', '--untracked-files=no']);
  const wtStatus = git(o.worktree, ['status', '--porcelain']);
  if (repoDirty.status !== 0 || wtStatus.status !== 0) {
    checks.push({ name: 'clean-tree', status: 'fail', detail: `git status failed: ${(repoDirty.stderr || wtStatus.stderr).trim()}` });
  } else {
    const repoLines = lines(repoDirty.stdout);
    const wtTracked = lines(wtStatus.stdout).filter((l) => !l.startsWith('??'));
    const problems = [
      ...repoLines.map((l) => `target repo: ${l.trim()}`),
      ...wtTracked.map((l) => `worktree: ${l.trim()}`)
    ];
    checks.push(problems.length
      ? { name: 'clean-tree', status: 'fail', detail: problems.slice(0, 20).join('; ') }
      : { name: 'clean-tree', status: 'pass', detail: 'no tracked changes in the target repo or the worktree' });
  }

  const fetch = git(o.repo, ['fetch', o.worktree, o.branch]);
  let added: string[] = [];
  if (fetch.status !== 0) {
    checks.push({ name: 'fast-forward', status: 'fail', detail: `git fetch failed: ${(fetch.stderr || fetch.stdout).trim()}` });
  } else {
    const ff = git(o.repo, ['merge-base', '--is-ancestor', o.target, 'FETCH_HEAD']);
    const ahead = git(o.repo, ['rev-list', '--count', `${o.target}..FETCH_HEAD`]).stdout.trim();
    checks.push(ff.status === 0
      ? { name: 'fast-forward', status: 'pass', detail: `${o.target} fast-forwards by ${ahead} commit(s)` }
      : { name: 'fast-forward', status: 'fail', detail: `${o.target} has moved past the branch base; rebase ${o.branch} onto ${o.target} (merge would cherry-pick ${ahead} commit(s))` });
    added = lines(git(o.repo, ['diff', '--name-only', '--diff-filter=A', `${o.target}...FETCH_HEAD`]).stdout);
  }

  if (o.testCommand) {
    const run = spawnSync('sh', ['-c', o.testCommand], { cwd: o.worktree, encoding: 'utf8', timeout: (o.testTimeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC) * 1000, maxBuffer: 64 * 1024 * 1024 });
    const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().slice(-OUTPUT_TAIL_CHARS);
    if (run.error) checks.push({ name: 'tests', status: 'fail', detail: `${o.testCommand}: ${run.error.message}\n${tail}` });
    else checks.push({ name: 'tests', status: run.status === 0 ? 'pass' : 'fail', detail: `${o.testCommand} exited ${run.status}\n${tail}` });
  } else {
    checks.push({ name: 'tests', status: o.skipTests ? 'skip' : 'fail', detail: o.skipTests ? 'skipped by request' : 'no testCommand given (pass skipTests to accept that)' });
  }

  const untracked = wtStatus.status === 0 ? lines(wtStatus.stdout).filter((l) => l.startsWith('??')).map((l) => l.slice(3)) : [];
  const strayAdded = strayPaths(added);
  const stray = [...strayAdded.map((p) => `added: ${p}`), ...untracked.map((p) => `untracked in worktree: ${p}`)];
  checks.push(stray.length
    ? { name: 'no-stray-files', status: 'fail', detail: stray.slice(0, 20).join('; ') }
    : { name: 'no-stray-files', status: 'pass', detail: `${added.length} added file(s), none stray; worktree has no untracked files` });

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, verdict: ok ? 'pass' : 'fail', checks };
}
