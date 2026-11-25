'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');
const { cleanupMergedWorktree } = loadTs('src/main/approvedMerge.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { mergeBranch } = loadTs('src/main/campTools.ts');
const { scanLeftovers, triageLeftovers, formatLeftovers } = loadTs('src/main/leftovers.ts');

const BRANCH = 'worker/feature-1';
const TARGET = 'master';
const QUESTION = 'Merge closeout fixture?';
const OLD = new Date(Date.now() - 12 * 86400000);
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function put(dir, rel, value = 'fixture bytes\n') {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), value);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-closeout-'));
  t.after(() => rmTree(root));
  const repo = path.join(root, 'main');
  const scratchRoot = path.join(root, 'scratch');
  const wt = path.join(scratchRoot, 'w1', 'worker');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', TARGET);
  put(repo, '.gitignore', 'Library/\nTemp/\nobj/\nbin/\nnode_modules/\n*.secret\nLogs/\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-qm', 'base');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  put(wt, 'feature.txt');
  git(wt, 'add', 'feature.txt');
  git(wt, 'commit', '-qm', 'feature');
  const head = git(wt, 'rev-parse', 'HEAD');
  const opts = { repo, worktree: wt, branch: BRANCH, target: TARGET, head, workerId: 'w1', scratchRoot };
  const merge = () => git(repo, 'merge', '--ff-only', BRANCH);
  return { root, repo, scratchRoot, wt, head, opts, merge };
}
function kept(f, r, why) {
  assert.equal(r.removed, false, 'closeout must refuse removal');
  assert.match(r.reason, why);
  assert.ok(fs.existsSync(f.wt), 'worktree survives');
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${BRANCH}`), f.head, 'branch kept');
}

// The direct helper controls prove refusal is caused by the extra resource, not dirt.
for (const rel of ['settings.secret', 'Logs/editor.log', 'nested/notes.secret', 'odd name\nsettings.secret']) {
  test(`ignored non-cache survives and is named in refusal: ${JSON.stringify(rel)}`, t => {
    const f = fixture(t); f.merge(); put(f.wt, rel, 'irreplaceable');
    assert.equal(git(f.wt, 'status', '--porcelain'), '');
    const r = cleanupMergedWorktree(f.opts);
    kept(f, r, /ignored|audit/i);
    assert.ok(r.reason.includes(rel) || r.reason.includes(JSON.stringify(rel).slice(1, -1)), 'report names the ignored file');
    assert.equal(fs.readFileSync(path.join(f.wt, rel), 'utf8'), 'irreplaceable');
  });
}
for (const cache of ['Library', 'Temp', 'obj', 'bin', 'node_modules']) {
  test(`regenerable ignored ${cache} permits plain removal and retains branch`, t => {
    const f = fixture(t); f.merge(); put(f.wt, `${cache}/generated`);
    const r = cleanupMergedWorktree(f.opts);
    assert.equal(r.removed, true, r.reason);
    assert.equal(fs.existsSync(f.wt), false);
    assert.equal(git(f.repo, 'rev-parse', `refs/heads/${BRANCH}`), f.head);
  });
}
test('a process cwd in a descendant prevents removal, even when git reports clean', async t => {
  const f = fixture(t); f.merge();
  const cwd = path.join(f.wt, 'empty'); fs.mkdirSync(cwd);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited; });
  kept(f, cleanupMergedWorktree(f.opts), /process|cwd|in use/i);
});
test('a symlink alias to the current process cwd prevents removal', t => {
  const f = fixture(t); f.merge();
  const previous = process.cwd();
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.wt, alias, 'dir');
  process.chdir(alias);
  try { kept(f, cleanupMergedWorktree(f.opts), /process|cwd|in use/i); }
  finally { process.chdir(previous); }
});
test('a locked tree is refused without forcing removal', t => {
  const f = fixture(t); f.merge(); git(f.repo, 'worktree', 'lock', f.wt);
  kept(f, cleanupMergedWorktree(f.opts), /lock/i);
});
test('ownership uses path boundaries, not another worker with the same prefix', t => {
  const f = fixture(t); f.merge();
  kept(f, cleanupMergedWorktree({ ...f.opts, workerId: 'w' }), /own|outside/i);
});

async function floor(t, f, { enabled = true, otherCwd } = {}) {
  const home = path.join(f.root, 'home'); fs.mkdirSync(home);
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  if (otherCwd) await hive.ensureAgent({ id: 'w2', name: 'Other', provider: 'claude', cwd: otherCwd });
  hive.setApprovedMergeDeps({ scratchRoot: f.scratchRoot, cleanup: () => enabled });
  hive.setFfMergeDeps({ repos: mergeRepos({ beta: f.repo, gamma: path.join(f.root, 'absent') }) });
  const action = { type: 'merge', repo: f.repo, worktree: f.wt, branch: BRANCH, target: TARGET, head: f.head, q: QUESTION };
  const card = { id: 'closeout-card', title: 'Feature', status: 'blocked', assignee: 'w1', project: 'Alpha', dependsOn: [], humanQA: [{ q: QUESTION }], approveAction: action };
  const approve = (extras = []) => {
    hive.writeTasks([{ ...card, humanQA: [{ q: QUESTION, a: 'good', answeredAt: new Date().toISOString() }] }, ...extras]);
    hive.routeHumanAnswer(card.id, QUESTION, 'good');
  };
  return { hive, home, card, approve };
}
function reported(hive, wt, reason) {
  const events = hive.logTail(100).filter(e => /cleanup|closeout/.test(e.kind) && JSON.stringify(e).includes(wt));
  assert.ok(events.some(e => reason.test(JSON.stringify(e))), 'structured closeout log contains path and reason');
  const mail = [...hive.inbox('w1'), ...hive.inbox('god')];
  assert.ok(mail.some(m => m.body.includes(wt) && reason.test(m.body)), 'inbox reports the path and reason');
}
test('approved merge uses agent cwd safety and reports its skip', async t => {
  const f = fixture(t);
  const h = await floor(t, f, { otherCwd: f.wt }); h.approve();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head, 'merge still succeeds');
  assert.ok(fs.existsSync(f.wt), 'registered agent cwd is retained');
  reported(h.hive, f.wt, /cwd|agent|in use/i);
});
for (const status of ['todo', 'doing', 'blocked']) {
  for (const field of ['brief', 'testsReady', 'approveAction']) {
    test(`approved closeout preserves worktree referenced by ${status} card ${field}`, async t => {
      const f = fixture(t); const h = await floor(t, f);
      const ref = field === 'brief' ? `Continue in ${f.wt}` : { worktree: f.wt, branch: BRANCH, head: f.head };
      h.approve([{ id: 'other-card', title: 'Continue', assignee: 'w2', status, [field]: ref }]);
      assert.ok(fs.existsSync(f.wt), 'open card reference retains the worktree');
      reported(h.hive, f.wt, /other-card/);
    });
  }
}
test('done card reference does not block approved cleanup; branch survives', async t => {
  const f = fixture(t); const h = await floor(t, f);
  h.approve([{ id: 'old-card', title: 'Past', assignee: 'w2', status: 'done', brief: f.wt }]);
  assert.equal(fs.existsSync(f.wt), false);
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${BRANCH}`), f.head);
  reported(h.hive, f.wt, /removed|clean/i);
});
test('disabled cleanup keeps the tree and reports the skip', async t => {
  const f = fixture(t); const h = await floor(t, f, { enabled: false }); h.approve();
  assert.ok(fs.existsSync(f.wt));
  reported(h.hive, f.wt, /disabled|off/i);
});
test('approved cleanup refusal reports ignored path without deleting it', async t => {
  const f = fixture(t); const h = await floor(t, f); put(f.wt, 'settings.secret'); h.approve();
  assert.ok(fs.existsSync(path.join(f.wt, 'settings.secret')));
  reported(h.hive, f.wt, /settings\.secret/);
});
test('ordinary merge invokes enabled shared closeout and returns the outcome', t => {
  const f = fixture(t);
  // Proposed dependency seam: same identity, flag and safety inputs as the approved path.
  const r = mergeBranch({ repo: f.repo, worktree: f.wt, branch: BRANCH, target: TARGET,
    closeout: { enabled: true, workerId: 'w1', scratchRoot: f.scratchRoot, tasks: [], liveAgentCwds: [] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(f.wt), false, 'ordinary merge closes the worker scratch tree');
  assert.equal(r.cleanup?.removed, true, 'caller receives cleanup outcome');
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${BRANCH}`), f.head);
});
test('auto-merge invokes closeout, preserves an open-card reference, logs and reports it', async t => {
  const f = fixture(t); const h = await floor(t, f);
  h.hive.writeTasks([{ id: 'closeout-card', title: 'Feature', assignee: 'w1', status: 'doing', project: 'Alpha', brief: f.wt }]);
  put(path.join(h.home, 'hive/agents/w1/outbox'), 'done.json', JSON.stringify({ to: 'boss', act: 'done', subject: 'closeout-card done', body: `Branch ${BRANCH} (worktree ${f.wt})\nPassed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31` }));
  h.hive.routeOnce();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head, 'auto merge actually ran');
  assert.ok(fs.existsSync(f.wt), 'blocked auto-merge card still references this tree');
  reported(h.hive, f.wt, /closeout-card/);
});

async function scan(f) {
  git(f.wt, 'update-index', '--refresh');
  const gitDir = git(f.wt, 'rev-parse', '--absolute-git-dir');
  fs.utimesSync(path.join(gitDir, 'index'), OLD, OLD);
  const now = Date.now() + 14 * 86400000;
  const d = {
    git: async (cwd, args) => { try { return execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } },
    sizeOf: async () => 100, now: () => now
  };
  const list = await scanLeftovers([f.root], [], {}, d);
  return { list, now };
}
test('standup marks ignored non-cache as needs audit and gives no removal command', async t => {
  const f = fixture(t); f.merge(); put(f.wt, 'settings.secret');
  const { list, now } = await scan(f);
  assert.ok(list.some(l => l.path === f.wt), 'unsafe merged tree remains visible');
  assert.ok(!triageLeftovers(list, now).safe.some(l => l.path === f.wt), 'ignored data is not safe to remove');
  const text = formatLeftovers(list, f.root, now);
  assert.match(text, /needs audit/i);
  assert.match(text, /settings\.secret/);
  assert.doesNotMatch(text, /worktree remove/);
});
test('standup does not infer audit completion from clean git status and age alone', () => {
  const now = Date.now();
  const item = { kind: 'worktree', path: '/scratch/w1/tree', of: '/repo', reason: 'merged', lastTouchedMs: now - 14 * 86400000, sizeBytes: 10 };
  assert.equal(triageLeftovers([item], now).safe.length, 0, 'missing ignored/cwd/card audit must fail closed');
  assert.match(formatLeftovers([item], '/home', now), /needs audit/i);
});


test('auto-merge closes an owned tree when no open card references it', async t => {
  const f = fixture(t); const h = await floor(t, f);
  h.hive.writeTasks([{ id: 'closeout-card', title: 'Feature', assignee: 'w1', status: 'doing', project: 'Alpha' }]);
  put(path.join(h.home, 'hive/agents/w1/outbox'), 'done.json', JSON.stringify({ to: 'boss', act: 'done', subject: 'closeout-card done', body: `Branch ${BRANCH}\nPassed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31` }));
  h.hive.routeOnce();
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(fs.existsSync(f.wt), false, 'auto merge closes the tree after the same safety audit');
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${BRANCH}`), f.head);
  reported(h.hive, f.wt, /removed|clean/i);
});
for (const scenario of ['ignored', 'ownership', 'disabled']) {
  test(`ordinary closeout reports ${scenario} skip without undoing merge`, t => {
    const f = fixture(t);
    if (scenario === 'ignored') put(f.wt, 'settings.secret');
    const r = mergeBranch({ repo: f.repo, worktree: f.wt, branch: BRANCH, target: TARGET,
      closeout: { enabled: scenario !== 'disabled', workerId: scenario === 'ownership' ? 'w2' : 'w1', scratchRoot: f.scratchRoot, tasks: [], liveAgentCwds: [] } });
    assert.equal(r.ok, true, r.error);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
    assert.ok(fs.existsSync(f.wt));
    assert.equal(r.cleanup?.removed, false, 'result explicitly reports retained tree');
    assert.match(r.cleanup.reason, scenario === 'ignored' ? /settings\.secret/ : scenario === 'ownership' ? /own|outside/i : /disabled|off/i);
  });
}
test('standup may mark an audited cache-only tree safe', async t => {
  const f = fixture(t); f.merge(); put(f.wt, 'Library/generated');
  const { list, now } = await scan(f);
  assert.ok(triageLeftovers(list, now).safe.some(l => l.path === f.wt), 'cache-only audit permits removal advice');
  assert.match(formatLeftovers(list, f.root, now), /worktree remove/);
});
