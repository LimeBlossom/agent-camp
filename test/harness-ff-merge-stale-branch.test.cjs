'use strict';

// A card's brief still names the branch of an earlier, already-merged round while the
// worker's done reports a newer fix branch (hive-sandbox-2-live-canary, 2026-11-22).

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

const GREEN = '# fail 0\n2667/2667 pass, tsc clean.';
const OLD = 'w1/jail-netdir-real';
const NEW = 'w1/net-host-shell-punct';

/** Old branch merged into integration; the same worktree then moved to a new branch with an unmerged fix. */
function staleSetup(t, { newBranch = NEW } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-stale-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'camp');
  const wt = path.join(tmp, 'md-jail-netdir');
  git('init', '-q', '-b', 'integration', repo);
  commit(repo, 'base.txt', 'base');
  git('-C', repo, 'worktree', 'add', '-q', '-b', OLD, wt, 'integration');
  commit(wt, 'src/jail.ts', 'round 1');
  git('-C', repo, 'merge', '-q', '--ff-only', OLD);
  if (newBranch) git('-C', wt, 'switch', '-q', '-c', newBranch);
  else git('-C', wt, 'switch', '-q', '--detach');
  commit(wt, 'src/netAllowlist.ts', 'round 2 fix');
  return { repo, wt, fixHead: git('-C', wt, 'rev-parse', 'HEAD'), deps: { repos: mergeRepos({ camp: repo }) } };
}

const card = (wt) => ({
  id: 'hive-sandbox-2-live-canary',
  title: 'Live canary',
  assignee: 'w1',
  status: 'doing',
  project: 'Camp',
  brief: `Fix: branch ${OLD}, worktree ${wt}, tests b5574e5c, impl f7ce5b94.`
});

const doneMsg = (body) => ({ act: 'done', to: 'boss', subject: 'hive-sandbox-2-live-canary: 5/9 pass, host-parse bug fixed', body });

test('the branch named in the done message wins over an older branch in the card brief', (t) => {
  const { repo, wt, fixHead, deps } = staleSetup(t);
  const msg = doneMsg(`BUG 7/8 FIXED on ${NEW} (worktree ${wt}, base integration): fix ${fixHead.slice(0, 8)}.\n${GREEN}`);
  const out = handleHarnessFfMerge('w1', msg, [card(wt)], deps);
  assert.equal(out.ok, true, `expected a merge, got ${JSON.stringify(out)}`);
  assert.equal(out.branch, NEW);
  assert.equal(git('-C', repo, 'rev-parse', 'integration'), fixHead);
});

test('every candidate already integrated while the worktree HEAD is ahead is refused, not skipped', (t) => {
  const { repo, wt, deps } = staleSetup(t, { newBranch: null });
  const before = git('-C', repo, 'rev-parse', 'integration');
  const msg = doneMsg(`Fixed the host parse (worktree ${wt}).\n${GREEN}`);
  const out = handleHarnessFfMerge('w1', msg, [card(wt)], deps);
  assert.equal(out.ok, false);
  assert.notEqual(out.skipped, true, 'a worktree ahead of the target is not a silent skip');
  assert.equal(out.refused, true);
  assert.equal(out.branch, OLD);
  assert.match(out.reason, /already integrated/);
  assert.match(out.reason, /ahead/);
  assert.equal(git('-C', repo, 'rev-parse', 'integration'), before);
});

test('an integrated branch with the worktree HEAD also integrated stays a quiet skip', (t) => {
  const { repo, wt, deps } = staleSetup(t, { newBranch: null });
  git('-C', repo, 'merge', '-q', '--ff-only', git('-C', wt, 'rev-parse', 'HEAD'));
  const out = handleHarnessFfMerge('w1', doneMsg(`Re-sent report (worktree ${wt}).\n${GREEN}`), [card(wt)], deps);
  assert.equal(out.skipped, true);
  assert.notEqual(out.refused, true);
});

test('through outbox: a refused stale branch mails the Boss and logs auto-merge-refuse', async (t) => {
  const { wt, deps } = staleSetup(t, { newBranch: null });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ff-stale-hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.setFfMergeDeps(deps);
  hive.writeTasks([card(wt)]);
  fs.writeFileSync(path.join(home, 'hive', 'agents', 'w1', 'outbox', 'done.json'), JSON.stringify(doneMsg(`Fixed it (worktree ${wt}).\n${GREEN}`)));
  hive.routeOnce();
  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-merge-refuse' && e.branch === OLD), JSON.stringify(logs.filter((e) => /auto-merge/.test(e.kind))));
  assert.ok(!logs.some((e) => e.kind === 'auto-merge-skip'), 'not logged as a silent skip');
  const boss = hive.inbox('god').filter((m) => /AUTO-MERGE REFUSED/.test(m.subject ?? ''));
  assert.equal(boss.length, 1, 'one refusal mail to the Boss');
  assert.match(boss[0].body, /ahead/);
  assert.equal(hive.inbox('w1').filter((m) => /Rebuild/.test(m.subject ?? '')).length, 0, 'no rebuild mail to the worker');
});
