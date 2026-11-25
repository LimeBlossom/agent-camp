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

const { HiveManager } = loadTs('src/main/hive.ts');
const { newlyDismissedAsks, dismissMailBody } = loadTs('src/main/dismissAsk.ts');

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function floor(t, card = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dismiss-'));
  t.after(() => rmTree(home));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const wt = path.join(home, 'wt-dismiss-card');
  git(repo, 'worktree', 'add', '-q', '-b', 'w1/dismiss-card-x', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'work');
  const hive = new HiveManager(() => home);
  hive.setFfMergeDeps({ repos: mergeRepos({ camp: repo }) });
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  const shots = path.join(home, 'shots-dismiss');
  fs.mkdirSync(shots);
  hive.writeTasks([{
    id: 'dismiss-card', title: 'Dismissable', assignee: 'w1', status: 'blocked', dependsOn: [], createdAt: '2026-11-22T00:00:00Z',
    description: `Put the stills in ${shots} please.`,
    humanQA: [{ q: 'Keep going?', askedAt: '2026-11-22T01:00:00Z' }], ...card,
  }]);
  const dismiss = () => {
    const c = hive.tasks().tasks.find((x) => x.id === 'dismiss-card');
    return hive.patchTask('dismiss-card', { humanQA: c.humanQA.map((e) => (e.a || e.dismissedAt ? e : { ...e, dismissedAt: '2026-11-22T02:00:00Z' })) });
  };
  return { hive, dismiss, repo, wt, shots };
}

test('a dismissal mails the Boss once, with the card and its loose ends', async (t) => {
  const { hive, dismiss, repo, wt, shots } = await floor(t);
  assert.ok(dismiss());
  const mail = hive.inbox('god-1');
  assert.equal(mail.length, 1);
  const body = mail[0].body;
  for (const part of ['dismiss-card', 'Dismissable', 'w1', 'Keep going?', 'w1/dismiss-card-x', 'unmerged', wt, shots, 'merge false', 'keep the card', 'reassign']) {
    assert.ok(body.includes(part), `mail names ${part}\n${body}`);
  }
  assert.ok(fs.existsSync(wt) && fs.existsSync(shots) && git(repo, 'branch', '--list', 'w1/dismiss-card-x'), 'nothing is deleted');
  assert.equal(hive.tasks().tasks[0].status, 'blocked', 'the harness does not close the card');
});

test('a merged branch is reported as merged', async (t) => {
  const { hive, dismiss, repo } = await floor(t);
  git(repo, 'merge', '-q', '--ff-only', 'w1/dismiss-card-x');
  dismiss();
  assert.match(hive.inbox('god-1')[0].body, /w1\/dismiss-card-x[^\n]*\bmerged\b/);
  assert.doesNotMatch(hive.inbox('god-1')[0].body, /unmerged/);
});

test('a second dismiss of the same question sends nothing', async (t) => {
  const { hive, dismiss } = await floor(t);
  dismiss();
  dismiss();
  assert.equal(hive.inbox('god-1').length, 1);
});

test('dismissing on a done card sends nothing', async (t) => {
  const { hive, dismiss } = await floor(t, { status: 'done' });
  dismiss();
  assert.equal(hive.inbox('god-1').length, 0);
});

test('superseded and moved-to-results retirements are not dismissals', () => {
  const before = { humanQA: [{ q: 'a', askedAt: '1' }, { q: 'b', askedAt: '2' }] };
  const after = { humanQA: [{ q: 'a', askedAt: '1', dismissedAt: 'n', supersededBy: '2' }, { q: 'b', askedAt: '2', dismissedAt: 'n', movedToResultsAt: 'n' }] };
  assert.deepEqual(newlyDismissedAsks(before, after), []);
  assert.deepEqual(newlyDismissedAsks(before, { humanQA: [before.humanQA[0], { ...before.humanQA[1], dismissedAt: 'n' }] }).map((e) => e.q), ['b']);
});

test('the mail text copes with a card that has no loose ends', () => {
  const body = dismissMailBody({ id: 'x', title: 'T', assignee: 'w' }, { q: 'Q?' }, { branches: [], worktrees: [], folders: [] });
  assert.match(body, /No branches, worktrees or folders/);
});
