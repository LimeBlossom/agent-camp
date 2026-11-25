'use strict';

// 2026-11-22: Hazel left the main Beta tree on hazel/alpha-charger-export-broken, auto-merge
// took that checked-out branch as its target, logged "already integrated" and master never moved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const { handleHarnessFfMerge, evaluateAndExecuteFfMerge, resolveRepo } = loadTs('src/main/harnessFfMerge.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const run = (...args) =>
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
const git = (...args) => {
  const r = run(...args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const commit = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
  git('-C', dir, 'add', rel);
  git('-C', dir, 'commit', '-qm', rel);
};
const rev = (repo, ref) => git('-C', repo, 'rev-parse', ref);
const current = (repo) => git('-C', repo, 'branch', '--show-current');

const GREEN = 'Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31';
const BRANCH = 'hazel/alpha-charger-export-broken';

/** A Beta repo whose main tree a worker left checked out on their own branch, one commit past master. */
function gtOnWorkerBranch(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-checked-out-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'gt');
  git('init', '-q', '-b', 'master', repo);
  commit(repo, 'gt.txt', 'gt');
  git('-C', repo, 'switch', '-q', '-c', BRANCH);
  commit(repo, 'Assets/charger.txt', 'fixed');
  return { tmp, repo, tip: rev(repo, 'HEAD'), master: rev(repo, 'master') };
}

const card = {
  id: 'alpha-charger-export-broken',
  title: 'Alpha charger export broken',
  assignee: 'hazel-abc',
  status: 'blocked',
  project: 'Alpha',
  brief: 'b'
};
const done = (repo) => ({
  act: 'done',
  to: 'boss',
  subject: 'alpha-charger-export-broken done',
  body: `Branch ${BRANCH} (worktree ${repo}).\n${GREEN}`
});
const roster = [{ id: 'hazel-abc', name: 'Hazel' }];

test('each repo resolves its configured integration branch, never the checked-out one', (t) => {
  const { repo } = gtOnWorkerBranch(t);
  const repos = mergeRepos({ beta: repo, gamma: repo, camp: repo });
  assert.equal(resolveRepo({ project: 'BetaGame' }, '', repos).branch, 'master');
  assert.equal(resolveRepo({ project: 'GammaGame' }, '', repos).branch, 'main');
  assert.equal(resolveRepo({ project: 'Camp' }, '', repos).branch, 'integration');
});

test('a worker branch checked out in the main Beta tree merges into master without touching that tree', (t) => {
  const { repo, tip } = gtOnWorkerBranch(t);
  const out = handleHarnessFfMerge('hazel-abc', done(repo), [card], { repos: mergeRepos({ beta: repo, gamma: repo }) }, roster);
  assert.equal(out?.ok, true, JSON.stringify(out));
  assert.equal(out.target, 'master');
  assert.equal(rev(repo, 'master'), tip, 'master must advance to the worker tip');
  assert.equal(current(repo), BRANCH, "The human's main tree must stay on the branch it had checked out");
});

test('a Camp main tree on another branch advances integration without a checkout', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-camp-co-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'camp');
  const wt = path.join(tmp, 'wt');
  git('init', '-q', '-b', 'integration', repo);
  commit(repo, 'camp.txt', 'camp');
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'cedar/camp-fix', wt, 'integration');
  commit(wt, 'src/fix.txt', 'fix');
  git('-C', repo, 'switch', '-q', '-c', 'scratch');
  const text = `Branch cedar/camp-fix (worktree ${wt}).\n${GREEN}`;
  const out = evaluateAndExecuteFfMerge({ repo, target: 'integration', branch: 'cedar/camp-fix', text, worktree: wt });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(rev(repo, 'integration'), rev(wt, 'HEAD'));
  assert.equal(current(repo), 'scratch');
});

test('a target checked out in another worktree is refused, its ref left alone', (t) => {
  const { tmp, repo, master } = gtOnWorkerBranch(t);
  const other = path.join(tmp, 'master-wt');
  git('-C', repo, 'worktree', 'add', '-q', other, 'master');
  const out = evaluateAndExecuteFfMerge({ repo, target: 'master', branch: BRANCH, text: GREEN, worktree: repo });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(out.refused, true, JSON.stringify(out));
  assert.match(out.reason, /master-wt/);
  assert.equal(rev(repo, 'master'), master);
});

test('a branch that is its own target is refused, not skipped as already integrated', (t) => {
  const { repo, master } = gtOnWorkerBranch(t);
  const out = evaluateAndExecuteFfMerge({ repo, target: 'master', branch: 'master', text: GREEN, worktree: repo });
  assert.equal(out.refused, true, JSON.stringify(out));
  assert.match(out.reason, /is the target branch/);
  assert.equal(rev(repo, 'master'), master);
});

// master and main are reserved words to the branch reader; integration is not, so a done can name it.
test('through outbox: a branch that is its own target mails the Boss and logs auto-merge-refuse', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-self-target-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'camp');
  git('init', '-q', '-b', 'integration', repo);
  commit(repo, 'camp.txt', 'camp');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-checked-out-hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'hazel-abc', name: 'Hazel', provider: 'claude', cwd: home });
  hive.setFfMergeDeps({ repos: mergeRepos({ beta: repo, gamma: repo, camp: repo }) });
  hive.writeTasks([{ ...card, id: 'camp-x', project: 'Camp', branch: 'integration' }]);
  fs.writeFileSync(
    path.join(home, 'hive', 'agents', 'hazel-abc', 'outbox', 'done.json'),
    JSON.stringify({ act: 'done', to: 'boss', subject: 'camp-x done', body: `Branch integration (worktree ${repo}).\n${GREEN}` })
  );
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-merge-refuse' && e.branch === 'integration'), JSON.stringify(logs.filter((e) => /auto-merge/.test(e.kind))));
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-skip'));
  const boss = hive.inbox('god').filter((m) => /AUTO-MERGE REFUSED/.test(m.subject ?? ''));
  assert.equal(boss.length, 1, JSON.stringify(hive.inbox('god').map((m) => m.subject)));
  assert.match(boss[0].body, /is the target branch/);
});

function campOnTarget(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-named-head-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'camp');
  git('init', '-q', '-b', 'integration', repo);
  commit(repo, 'camp.txt', 'camp');
  commit(repo, 'work.txt', 'work');
  return { repo, onTarget: rev(repo, 'integration') };
}

test('a done naming the target branch with a head already on it is skipped as merged, not refused', (t) => {
  const { repo, onTarget } = campOnTarget(t);
  const text = `Branch integration @ ${onTarget.slice(0, 9)} (worktree ${repo}).\n${GREEN}`;
  const out = evaluateAndExecuteFfMerge({ repo, target: 'integration', branch: 'integration', text, worktree: repo });
  assert.equal(out.skipped, true, JSON.stringify(out));
  assert.ok(!out.refused);
  assert.match(out.reason, /already on integration/);
});

test('a done naming the target branch with a head NOT on it is still refused', (t) => {
  const { repo } = campOnTarget(t);
  git('-C', repo, 'switch', '-q', '-c', 'side');
  commit(repo, 'side.txt', 'side');
  const off = rev(repo, 'side');
  git('-C', repo, 'switch', '-q', 'integration');
  const text = `Branch integration @ ${off} (worktree ${repo}).\n${GREEN}`;
  const out = evaluateAndExecuteFfMerge({ repo, target: 'integration', branch: 'integration', text, worktree: repo });
  assert.equal(out.refused, true, JSON.stringify(out));
  assert.match(out.reason, /is the target branch/);
});

test('through outbox: a target-named done with its head already on it mails no refusal', async (t) => {
  const { repo, onTarget } = campOnTarget(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-named-head-hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'hazel-abc', name: 'Hazel', provider: 'claude', cwd: home });
  hive.setFfMergeDeps({ repos: mergeRepos({ beta: repo, gamma: repo, camp: repo }) });
  hive.writeTasks([{ ...card, id: 'camp-x', project: 'Camp', branch: 'integration' }]);
  fs.writeFileSync(
    path.join(home, 'hive', 'agents', 'hazel-abc', 'outbox', 'done.json'),
    JSON.stringify({ act: 'done', to: 'boss', subject: 'camp-x done', body: `Branch integration @ ${onTarget} (worktree ${repo}).\n${GREEN}` })
  );
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-merge-skip' && e.branch === 'integration'));
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-refuse'));
  assert.equal(hive.inbox('god').filter((m) => /AUTO-MERGE REFUSED/.test(m.subject ?? '')).length, 0);
});
