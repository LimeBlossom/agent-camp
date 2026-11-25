'use strict';

// The Boss closes a card whose branch it merged, or is about to merge, by hand. The
// close-time gate re-run must not mail the worker to rebuild a card that is already closed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { patchCard } = loadTs('src/main/campTools.ts');

const CARD = 'camp-close-after-hand-merge';
const BRANCH = `birch/${CARD}`;

function git(repo, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8' }
  ).trim();
}

async function floor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-close-hand-merge-'));
  t.after(() => rmTree(root));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'camp-repo');
  const wt = path.join(root, 'worker-wt');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });

  git(repo, 'init', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt, 'integration');
  fs.writeFileSync(path.join(wt, 'fix.txt'), 'fix\n');
  git(wt, 'add', 'fix.txt');
  git(wt, 'commit', '-qm', 'fix: the thing');
  const tip = git(wt, 'rev-parse', 'HEAD');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'birch', name: 'Birch', provider: 'claude', cwd: home });
  hive.setFfMergeDeps({ repos: mergeRepos({ camp: repo }) });
  hive.writeTasks([{
    id: CARD,
    title: 'Close after a hand merge',
    assignee: 'birch',
    status: 'blocked',
    project: 'Camp',
    dependsOn: [],
    createdAt: '2026-11-22T03:00:00.000Z',
    // No verbatim test line: the close body carries only brief, notes and result.
    brief: `Branch ${BRANCH} @ ${tip} (worktree ${wt}), base integration ${base}.`,
    notes: '11-22 birch: ready; awaiting boss merge'
  }]);

  const close = () => {
    const res = patchCard({
      hiveRoot: path.join(home, 'hive'),
      id: CARD,
      status: 'done',
      result: 'Merged by hand.',
      outboxDir: path.join(home, 'hive', 'agents', 'god', 'outbox')
    });
    assert.equal(res.ok, true, res.error);
    hive.routeOnce();
  };
  const mergeRows = () => hive.logTail(500).filter((r) => typeof r.kind === 'string' && r.kind.startsWith('auto-merge') && r.id === CARD);
  const rebuildMail = () => hive.inbox('birch').filter((m) => /Rebuild on top/.test(m.subject || ''));

  return { home, repo, wt, base, tip, hive, close, mergeRows, rebuildMail };
}

test('closing a card whose branch the Boss already fast-forwarded sends no rebuild mail', async (t) => {
  const f = await floor(t);
  git(f.repo, 'merge', '-q', '--ff-only', BRANCH);

  f.close();

  assert.deepEqual(f.rebuildMail(), []);
  const rows = f.mergeRows();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].kind, 'auto-merge-skip');
  assert.match(rows[0].reason, /already (integrated into|on) integration/);
});

test('closing a card whose commits the Boss cherry-picked onto the target sends no rebuild mail', async (t) => {
  const f = await floor(t);
  // Move the target first so the cherry-pick lands under a different hash.
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'other\n');
  git(f.repo, 'add', 'other.txt');
  git(f.repo, 'commit', '-qm', 'other work');
  git(f.repo, 'cherry-pick', f.tip);
  assert.notEqual(git(f.repo, 'rev-parse', 'integration'), f.tip);
  const target = git(f.repo, 'rev-parse', 'integration');

  f.close();

  assert.deepEqual(f.rebuildMail(), []);
  const rows = f.mergeRows();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].kind, 'auto-merge-skip');
  assert.match(rows[0].reason, /already on integration/);
  assert.equal(git(f.repo, 'rev-parse', 'integration'), target, 'target not moved');
});

test('a close-time decline goes to the Boss, never to the worker as a rebuild request', async (t) => {
  // The live case: the Boss closed both cards about 16 s before merging them by hand, so
  // at close time the branch was not on the target and gate 3 declined it.
  const f = await floor(t);

  f.close();

  assert.deepEqual(f.rebuildMail(), []);
  const rows = f.mergeRows();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].kind, 'auto-merge-decline');
  const toBoss = f.hive.inbox('god').filter((m) => m.from === 'harness' && /AUTO-MERGE AT CLOSE/.test(m.subject || ''));
  assert.equal(toBoss.length, 1, JSON.stringify(f.hive.inbox('god').map((m) => m.subject)));
  assert.match(toBoss[0].subject, new RegExp(CARD));
  assert.match(toBoss[0].body, new RegExp(BRANCH));
  assert.equal(git(f.repo, 'rev-parse', 'integration'), f.base);
});

test('a worker done that is declined still asks the worker to rebuild', async (t) => {
  const f = await floor(t);
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'other\n');
  git(f.repo, 'add', 'other.txt');
  git(f.repo, 'commit', '-qm', 'other work');
  const outbox = path.join(f.home, 'hive', 'agents', 'birch', 'outbox');
  fs.writeFileSync(path.join(outbox, 'done.json'), JSON.stringify({
    to: 'boss', act: 'done', subject: `${CARD} done`,
    body: `Branch ${BRANCH} (worktree ${f.wt})\n# tests 3\n# pass 3\n# fail 0`
  }));

  f.hive.routeOnce();

  assert.equal(f.rebuildMail().length, 1);
});
