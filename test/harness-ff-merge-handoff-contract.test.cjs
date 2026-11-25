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

const { handleHarnessFfMerge } = loadTs('src/main/harnessFfMerge.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

const commit = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
  git('-C', dir, 'add', rel);
  git('-C', dir, 'commit', '-qm', rel);
};

function makeRepos(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-contract-'));
  t.after(() => rmTree(tmp));
  const mainRepo = path.join(tmp, 'main-repo');
  const wt = path.join(tmp, 'worktree');
  git('init', '-q', '-b', 'master', mainRepo);
  commit(mainRepo, 'base.txt', 'base');
  git('-C', mainRepo, 'worktree', 'add', '-q', '-b', 'worker/feature-1', wt, 'master');
  commit(wt, 'tests/red.txt', 'failing tests');
  return { mainRepo, wt, deps: { repos: mergeRepos({ beta: mainRepo, gamma: mainRepo }) } };
}

const GREEN = 'Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31';
// Real shape of Hazel's 647b1063 report: labelled red-first baseline, then the final green run.
const RED_FIRST_THEN_GREEN = `Red-first baseline (before fix): Failed!  - Failed:     4, Passed:     1, Skipped:     0, Total:     5\nFinal: ${GREEN}`;

const card = (over) => ({ id: 'alpha-task-1', title: 'T', assignee: 'w1', status: 'blocked', project: 'Alpha', brief: 'b', ...over });
const done = (body, subject = 'alpha-task-1 done') => ({ act: 'done', to: 'boss', subject, body });
const head = (repo) => git('-C', repo, 'rev-parse', 'HEAD');

// ─── (a) a report with no real branch is not a merge handoff ────────────────

test('a read-only critique whose prose says "branch" is not a merge handoff', (t) => {
  const { mainRepo, deps } = makeRepos(t);
  const msg = done(
    'alpha-task-1 done: design critique only, no code. The branch of the design that worries me is the shop loop; ' +
      'it relies on gear/3c balance. Verdict: rework the ladder. No tests (read-only review).'
  );
  assert.equal(handleHarnessFfMerge('w1', msg, [card()], deps), null);
  assert.equal(head(mainRepo), git('-C', mainRepo, 'rev-parse', 'master'));
});

// ─── (b) a tests-first handoff is never auto-merged ─────────────────────────

test('a tests-first handoff at its testsReady head is skipped, not merged, and claims no pass', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const before = head(mainRepo);
  const testsHead = head(wt);
  const c = card({ testsReady: { branch: 'worker/feature-1', worktree: wt, head: testsHead, then: 'handoff' } });
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1 tests ready\nFailed!  - Failed:     4, Passed:     1`), [c], deps);
  assert.ok(out, 'outcome expected');
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /tests-first/i);
  assert.equal(out.testLine, undefined);
  assert.equal(head(mainRepo), before, 'red tests must not land on master');
});

test('a tests-first handoff with a green-looking report is still not merged before Boss review', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const before = head(mainRepo);
  const c = card({ testsReady: { branch: 'worker/feature-1', worktree: wt, head: head(wt).slice(0, 8), then: 'handoff' } });
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1\n${RED_FIRST_THEN_GREEN}`), [c], deps);
  assert.equal(out.skipped, true);
  assert.equal(head(mainRepo), before);
});

test('implementation commits on top of a tests-first head still merge when the final result is green', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const testsHead = head(wt);
  commit(wt, 'src/fix.txt', 'implementation');
  const c = card({ testsReady: { branch: 'worker/feature-1', worktree: wt, head: testsHead, then: 'implement' } });
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1\n${RED_FIRST_THEN_GREEN}`), [c], deps);
  assert.equal(out.ok, true);
  assert.equal(head(mainRepo), head(wt));
});

// ─── (c) already-integrated branches and closed cards are idempotent ────────

test('a branch already integrated into master is skipped without claiming its tests passed', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  git('-C', mainRepo, 'merge', '-q', '--ff-only', 'worker/feature-1');
  const before = head(mainRepo);
  // Only a red baseline is quoted: integration is reported, not a pass.
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1 (worktree ${wt})\nFailed!  - Failed:     4, Passed:     1`), [card()], deps);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /already integrated/i);
  assert.equal(out.testLine, undefined);
  assert.equal(head(mainRepo), before);
});

test('a done report for a card the Boss already closed is skipped, even when the branch is not integrated', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const before = head(mainRepo);
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1 (worktree ${wt})\n${GREEN}`), [card({ status: 'done' })], deps);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /closed|done/i);
  assert.equal(head(mainRepo), before);
});

test('a genuine final failure on an open, unintegrated branch is still declined (gate 3)', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const before = head(mainRepo);
  const out = handleHarnessFfMerge('w1', done(`Branch worker/feature-1 (worktree ${wt})\n${GREEN}\nFinal: Failed!  - Failed:     2, Passed:     29`), [card()], deps);
  assert.equal(out.ok, false);
  assert.notEqual(out.skipped, true);
  assert.equal(out.gate, 3);
  assert.equal(head(mainRepo), before);
});

// ─── through the outbox: no retry mail for skips or duplicates ──────────────

async function hiveWith(t, deps, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-contract-hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.setFfMergeDeps(deps);
  hive.writeTasks(tasks);
  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  const post = (name, msg) => fs.writeFileSync(path.join(out, name), JSON.stringify(msg));
  return { hive, post };
}

test('through outbox: a duplicate done delivery merges once and sends no retry mail', async (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const { hive, post } = await hiveWith(t, deps, [card({ status: 'doing' })]);
  const msg = done(`Branch worker/feature-1 (worktree ${wt})\n${RED_FIRST_THEN_GREEN}`);
  post('done1.json', msg);
  hive.routeOnce();
  assert.equal(head(mainRepo), head(wt));
  post('done2.json', msg);
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.equal(logs.filter((e) => e.kind === 'auto-merge').length, 1);
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-decline'), 'duplicate must not be a decline');
  assert.ok(logs.some((e) => e.kind === 'auto-merge-skip'), 'duplicate is logged as a skip');
  assert.equal(hive.inbox('w1').length, 0, 'no rebuild/retry mail');
});

test('through outbox: a done report on a closed card sends no retry mail', async (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  commit(mainRepo, 'moved.txt', 'master moved on');
  const { hive, post } = await hiveWith(t, deps, [card({ status: 'done' })]);
  post('late.json', done(`Branch worker/feature-1 (worktree ${wt})\nFailed!  - Failed:     4, Passed:     1`));
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-decline'));
  assert.equal(hive.inbox('w1').length, 0);
});

test('through outbox: a read-only critique report sends no retry mail', async (t) => {
  const { deps } = makeRepos(t);
  const { hive, post } = await hiveWith(t, deps, [card({ status: 'doing', id: 'alpha-gear-3c-critic' })]);
  post('critique.json', done('alpha-gear-3c-critic done. Read-only critique on branch of the economy design: rework ladder. No code, no tests.', 'alpha-gear-3c-critic done'));
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-decline'));
  assert.equal(hive.inbox('w1').length, 0);
});

// ─── late worker status patches cannot reopen a Boss-closed card ────────────

test('a worker cannot move a Boss-closed card back to blocked or doing', () => {
  const tasks = [card({ status: 'done' })];
  for (const status of ['blocked', 'doing', 'todo']) {
    const plan = planTaskMessage({ act: 'task-patch', body: { id: 'alpha-task-1', status, notesAppend: 'awaiting boss merge' }, sender: 'w1', isBoss: false, tasks, now: 'n' });
    assert.equal(plan.ok, false, `worker ${status} on a done card must be refused`);
    assert.match(plan.reason, /closed|done/i);
  }
  const note = planTaskMessage({ act: 'task-patch', body: { id: 'alpha-task-1', notesAppend: 'fyi' }, sender: 'w1', isBoss: false, tasks, now: 'n' });
  assert.equal(note.ok, true, 'a note on a closed card is still allowed');
  const boss = planTaskMessage({ act: 'task-patch', body: { id: 'alpha-task-1', status: 'todo' }, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.equal(boss.ok, true, 'the Boss can still reopen');
});

// ─── (d) a pending review holds the auto-merge ──────────────────────────────

test('review gates: open humanQA, art kind and a declared gate hold the merge; a plain code card still merges', (t) => {
  const cases = [
    ['unanswered humanQA', { humanQA: [{ q: 'wording?' }] }, 'Branch worker/feature-1\n' + GREEN, /unanswered/],
    ['answered humanQA merges', { humanQA: [{ q: 'x', a: 'ok' }] }, 'Branch worker/feature-1\n' + GREEN, null],
    ['art kind splat', { kind: 'splat' }, 'Branch worker/feature-1\n' + GREEN, /art kind/],
    ['art kind visual-judgment', { kind: 'visual-judgment' }, 'Branch worker/feature-1\n' + GREEN, /art kind/],
    ['declared Willow gate', {}, 'Branch worker/feature-1\n' + GREEN + '\nWillow taste gate requested; the human review ask after that', /pending review gate/],
    ['awaiting the human in notes', { notes: ['awaiting the human wording'] }, 'Branch worker/feature-1\n' + GREEN, /pending review gate/],
    ['plain code card', { kind: 'code' }, 'Branch worker/feature-1\n' + GREEN, null]
  ];
  for (const [name, over, body, held] of cases) {
    const { mainRepo, wt, deps } = makeRepos(t);
    const before = head(mainRepo);
    const out = handleHarnessFfMerge('w1', done(body), [card(over)], deps);
    if (held) {
      assert.equal(out.skipped, true, name);
      assert.equal(out.reviewGate, true, name);
      assert.match(out.reason, held, name);
      assert.equal(head(mainRepo), before, name);
    } else {
      assert.equal(out.ok, true, name);
      assert.equal(head(mainRepo), head(wt), name);
    }
  }
});

test('review gates do not hold a Boss close', (t) => {
  const { mainRepo, wt, deps } = makeRepos(t);
  const out = handleHarnessFfMerge('w1', done('Branch worker/feature-1\n' + GREEN), [card({ kind: 'splat' })], deps, undefined, true);
  assert.equal(out.ok, true);
  assert.equal(head(mainRepo), head(wt));
});
