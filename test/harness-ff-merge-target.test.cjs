'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const { handleHarnessFfMerge, resolveRepo } = loadTs('src/main/harnessFfMerge.ts');
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
const head = (repo) => git('-C', repo, 'rev-parse', 'HEAD');
const hasObject = (repo, sha) => run('-C', repo, 'cat-file', '-e', `${sha}^{commit}`).status === 0;

const GREEN = 'Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31';

/** A Beta-like repo on master plus a Camp-like repo on integration with a worker worktree. */
function makeFloor(t, { campBase = 'integration' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-target-'));
  t.after(() => rmTree(tmp));
  const gtRepo = path.join(tmp, 'gt');
  const campRepo = path.join(tmp, 'camp');
  const wt = path.join(tmp, 'camp-wt');
  git('init', '-q', '-b', 'master', gtRepo);
  commit(gtRepo, 'gt.txt', 'gt');
  git('init', '-q', '-b', campBase, campRepo);
  commit(campRepo, 'camp.txt', 'camp');
  git('-C', campRepo, 'worktree', 'add', '-q', '-b', 'cedar/camp-fix', wt, campBase);
  commit(wt, 'src/fix.txt', 'fix');
  return { tmp, gtRepo, campRepo, wt, tip: head(wt) };
}

const campCard = (over) => ({
  id: 'camp-fix',
  title: 'Camp: fix',
  assignee: 'cedar-abc',
  status: 'blocked',
  project: 'Camp',
  brief: 'b',
  ...over
});
// The 2026-11-13 report mentioned Beta words (a Beta lock, alpha- cards) beside a Camp branch.
const campDone = (wt, extra = '') => ({
  act: 'done',
  to: 'boss',
  subject: 'camp-fix done',
  body: `Branch cedar/camp-fix (worktree ${wt}). Not touching the Beta lock or alpha-gear cards.\n${GREEN}${extra}`
});

// ─── (1) the target comes from the repo or project, never a hard-coded master ──

test('a Camp card is a Camp handoff even when its text mentions Beta', () => {
  const repos = mergeRepos({ beta: '/r/beta', gamma: '/r/gamma', camp: '/r/camp' });
  assert.equal(resolveRepo({ project: 'Camp' }, 'Beta lock, alpha-gear-3c', repos).project, 'Camp');
  assert.equal(resolveRepo({ project: 'munder-difflin' }, '', repos).project, 'Camp');
});

test('a card of another named project never falls back to text heuristics', () => {
  const repos = mergeRepos({ beta: '/r/beta', gamma: '/r/gamma', camp: '/r/camp' });
  assert.equal(resolveRepo({ project: 'DeltaGame' }, 'Fixed enemy in Beta Alpha Game', repos), null);
});

test('a Camp handoff with no Camp repo configured is ignored and never touches the Beta repo', (t) => {
  const { gtRepo, wt, tip } = makeFloor(t);
  const before = head(gtRepo);
  const out = handleHarnessFfMerge('cedar-abc', campDone(wt), [campCard()], { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo }) });
  assert.equal(out, null);
  assert.equal(head(gtRepo), before);
  assert.equal(hasObject(gtRepo, tip), false, 'the Camp branch must not be fetched into the Beta repo');
});

test('a Camp handoff merges into integration of the Camp repo', (t) => {
  const { gtRepo, campRepo, wt, tip } = makeFloor(t);
  const out = handleHarnessFfMerge('cedar-abc', campDone(wt), [campCard()], {
    repos: mergeRepos({ beta: gtRepo, gamma: gtRepo, camp: campRepo })
  });
  assert.equal(out?.ok, true, JSON.stringify(out));
  assert.equal(out.target, 'integration');
  assert.equal(out.repo, campRepo);
  assert.equal(git('-C', campRepo, 'rev-parse', 'integration'), tip);
  assert.equal(hasObject(gtRepo, tip), false);
});

test('the Camp target stays integration while another branch is checked out in the Camp repo', (t) => {
  const { gtRepo, campRepo, wt } = makeFloor(t);
  git('-C', campRepo, 'switch', '-q', '-c', 'scratch');
  const out = handleHarnessFfMerge('cedar-abc', campDone(wt), [campCard()], {
    repos: mergeRepos({ beta: gtRepo, gamma: gtRepo, camp: campRepo })
  });
  assert.equal(out?.target, 'integration', JSON.stringify(out));
});

// ─── (2) a missing target ref is a logged skip, not a rebase request ──────────

test('a missing target ref is skipped, not declined', (t) => {
  const { gtRepo, campRepo, wt } = makeFloor(t, { campBase: 'main' });
  const before = head(campRepo);
  const out = handleHarnessFfMerge('cedar-abc', campDone(wt), [campCard()], {
    repos: mergeRepos({ beta: gtRepo, gamma: gtRepo, camp: campRepo })
  });
  assert.equal(out?.skipped, true, JSON.stringify(out));
  assert.match(out.reason, /integration/);
  assert.equal(head(campRepo), before);
});

async function hiveWith(t, deps, tasks, agents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-target-hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  for (const a of agents) await hive.ensureAgent({ ...a, provider: 'claude', cwd: home });
  hive.setFfMergeDeps(deps);
  hive.writeTasks(tasks);
  const post = (sender, msg) =>
    fs.writeFileSync(path.join(home, 'hive', 'agents', sender, 'outbox', 'done.json'), JSON.stringify(msg));
  return { hive, post };
}

test('through outbox: a missing target logs auto-merge-skip and mails no rebase request', async (t) => {
  const { gtRepo, campRepo, wt } = makeFloor(t, { campBase: 'main' });
  const { hive, post } = await hiveWith(t, { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo, camp: campRepo }) }, [campCard()], [
    { id: 'cedar-abc', name: 'Cedar' }
  ]);
  post('cedar-abc', campDone(wt));
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-merge-skip' && e.id === 'camp-fix'), 'skip must be logged');
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-decline'));
  assert.equal(hive.inbox('cedar-abc').length, 0);
});

test('through outbox: a Camp decline asks for a rebase onto integration, not master', async (t) => {
  const { gtRepo, campRepo, wt } = makeFloor(t);
  commit(campRepo, 'moved.txt', 'integration moved');
  const { hive, post } = await hiveWith(t, { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo, camp: campRepo }) }, [campCard()], [
    { id: 'cedar-abc', name: 'Cedar' }
  ]);
  post('cedar-abc', campDone(wt));
  hive.routeOnce();
  const mail = hive.inbox('cedar-abc');
  assert.equal(mail.length, 1);
  assert.match(`${mail[0].subject}\n${mail[0].body}`, /integration/);
  assert.doesNotMatch(`${mail[0].subject}\n${mail[0].body}`, /master/);
});

// ─── (3) only the card's own assignee handoff runs the merge gates ────────────

/** Beta repo where maple's real, unmerged branch exists alongside the critic's own. */
function makeGtWithForeignBranch(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-foreign-'));
  t.after(() => rmTree(tmp));
  const gtRepo = path.join(tmp, 'gt');
  const wt = path.join(tmp, 'pika-wt');
  git('init', '-q', '-b', 'master', gtRepo);
  commit(gtRepo, 'gt.txt', 'gt');
  git('-C', gtRepo, 'worktree', 'add', '-q', '-b', 'maple/alpha-gear-3c', wt, 'master');
  commit(wt, 'src/gear.txt', 'gear');
  return { gtRepo, wt };
}

const critiqueCard = { id: 'alpha-gear-3c-critic', title: 'Critique gear 3c', assignee: 'cedar-abc', status: 'doing', project: 'Alpha', brief: 'b' };
const critique = (wt) => ({
  act: 'done',
  to: 'boss',
  subject: 'alpha-gear-3c-critic done',
  body: `Reviewed branch maple/alpha-gear-3c (worktree ${wt}). Its suite: ${GREEN}`
});
const roster = [
  { id: 'cedar-abc', name: 'Cedar' },
  { id: 'maple-xyz', name: 'Maple' }
];

test("a critique naming another worker's real unmerged branch does not merge it", (t) => {
  const { gtRepo, wt } = makeGtWithForeignBranch(t);
  const before = head(gtRepo);
  const out = handleHarnessFfMerge('cedar-abc', critique(wt), [critiqueCard], { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo }) }, roster);
  assert.ok(out === null || out.skipped === true, JSON.stringify(out));
  assert.equal(head(gtRepo), before);
});

test('through outbox: a critique of another worker branch merges nothing and mails nothing', async (t) => {
  const { gtRepo, wt } = makeGtWithForeignBranch(t);
  const before = head(gtRepo);
  const { hive, post } = await hiveWith(t, { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo }) }, [critiqueCard], roster);
  post('cedar-abc', critique(wt));
  hive.routeOnce();
  assert.equal(head(gtRepo), before);
  assert.ok(!hive.logTail(100).some((e) => e.kind === 'auto-merge' || e.kind === 'auto-merge-decline'));
  assert.equal(hive.inbox('cedar-abc').length, 0);
});

test('a done report that resolves to no card of the sender runs no merge gates', (t) => {
  const { gtRepo, wt } = makeGtWithForeignBranch(t);
  const before = head(gtRepo);
  const two = [
    { ...critiqueCard, id: 'alpha-a', status: 'blocked' },
    { ...critiqueCard, id: 'alpha-b', status: 'blocked' }
  ];
  const msg = { act: 'done', to: 'boss', subject: 'Beta work done', body: `Branch maple/alpha-gear-3c (worktree ${wt})\n${GREEN}` };
  assert.equal(handleHarnessFfMerge('maple-xyz', msg, two.map((c) => ({ ...c, assignee: 'maple-xyz' })), { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo }) }), null);
  assert.equal(head(gtRepo), before);
});

test("the assignee's own branch still merges when the roster is known", (t) => {
  const { gtRepo, wt } = makeGtWithForeignBranch(t);
  const own = { ...critiqueCard, id: 'alpha-gear-3c', assignee: 'maple-xyz', status: 'blocked' };
  const msg = { act: 'done', to: 'boss', subject: 'alpha-gear-3c done', body: `Branch maple/alpha-gear-3c (worktree ${wt})\n${GREEN}` };
  const out = handleHarnessFfMerge('maple-xyz', msg, [own], { repos: mergeRepos({ beta: gtRepo, gamma: gtRepo }) }, roster);
  assert.equal(out?.ok, true, JSON.stringify(out));
});
