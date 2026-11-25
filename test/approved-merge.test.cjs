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

const { classifyApproveAnswer } = loadTs('src/main/approvedMerge.ts');
const { askHuman } = loadTs('src/main/campTools.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const TARGET = 'integration';
const BRANCH = 'w1/feature';
const Q = '**Merge the feature?**\n\nIt adds the feature.';
const TIP = '0123456789abcdef0123456789abcdef01234567';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir, rel, text) => {
  put(dir, rel, text);
  git('-C', dir, 'add', rel);
  git('-C', dir, 'commit', '-qm', rel);
};

/** the human's main tree on integration with a pushed upstream, and a worker worktree inside
 *  the worker's own scratch folder carrying one commit. */
function makeRepos(t, { worker = 'w1' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-approved-merge-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'main-repo');
  const remote = path.join(tmp, 'remote.git');
  const scratch = path.join(tmp, 'scratch');
  const wt = path.join(scratch, worker, 'MD-worker');
  git('init', '-q', '-b', TARGET, repo);
  commit(repo, 'base.txt', 'base\n');
  git('init', '-q', '--bare', remote);
  git('-C', repo, 'remote', 'add', 'origin', remote);
  git('-C', repo, 'push', '-q', '-u', 'origin', TARGET);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git('-C', repo, 'worktree', 'add', '-q', '-b', BRANCH, wt, TARGET);
  commit(wt, 'src/feature.txt', 'feature work\n');
  const remoteHead = () => git('--git-dir', remote, 'rev-parse', TARGET);
  return { tmp, repo, remote, scratch, wt, remoteHead, base: git('-C', repo, 'rev-parse', 'HEAD') };
}

async function floor(t, repos, { action = {}, card = {}, cleanup = false, rebaseTimeoutMs } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-approved-floor-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.setFfMergeDeps({ repos: mergeRepos({ beta: path.join(home, 'no-beta'), gamma: path.join(home, 'no-gamma') }) });
  hive.setApprovedMergeDeps({ scratchRoot: repos.scratch, cleanup: () => cleanup, ...(rebaseTimeoutMs ? { rebaseTimeoutMs } : {}) });
  const approveAction = action === null ? undefined
    : { type: 'merge', repo: repos.repo, worktree: repos.wt, branch: BRANCH, target: TARGET, head: git('-C', repos.wt, 'rev-parse', 'HEAD'), q: Q, ...action };
  hive.writeTasks([{
    id: 'c', title: 'Card', assignee: 'w1', status: 'blocked', project: 'Camp', dependsOn: [],
    createdAt: '2026-11-12T00:00:00Z', brief: 'feature built on w1/feature', notes: 'worker done\nawaiting boss merge',
    humanQA: [{ q: Q, askedAt: '2026-11-12T00:00:00Z' }],
    ...(approveAction ? { approveAction } : {}), ...card
  }]);
  const get = () => hive.tasks().tasks.find((x) => x.id === 'c');
  const answer = (a, q = Q) => {
    hive.writeTasks(hive.tasks().tasks.map((x) => x.id !== 'c' ? x : {
      ...x, humanQA: x.humanQA.map((e) => (e.q === q && !e.a ? { ...e, a, answeredAt: new Date().toISOString() } : e))
    }));
    return hive.routeHumanAnswer('c', q, a);
  };
  const workerDone = (body) => {
    fs.writeFileSync(path.join(home, 'hive', 'agents', 'w1', 'outbox', `done-${Date.now()}.json`),
      JSON.stringify({ to: 'boss', act: 'done', subject: 'c rebased', body }));
    hive.routeOnce();
  };
  const head = () => git('-C', repos.repo, 'rev-parse', 'HEAD');
  const bossMail = () => hive.inbox('god-1').filter((m) => m.from !== 'w1');
  return { hive, home, get, answer, workerDone, head, bossMail };
}

// ── The answer classifier ────────────────────────────────────────────────────

test('only a bare approve word approves; hedged or negative answers are ambiguous; the rest are change requests', () => {
  for (const a of ['good', 'Good!', '  good. ', 'approve', 'approved', 'lgtm', 'looks good', 'ship it', 'merge it', 'yes', '`good`']) {
    assert.equal(classifyApproveAnswer(a), 'approve', a);
  }
  for (const a of ['good but make it red', 'approved, also add a trail', 'merge after the fix', 'no', 'not yet', 'not good', 'wait', 'hold off', 'merge?', "don't merge", '']) {
    assert.equal(classifyApproveAnswer(a), 'ambiguous', a);
  }
  for (const a of ['make the tail longer', 'use the warmer palette', 'yes, the left one', 'ok make it red']) {
    assert.equal(classifyApproveAnswer(a), 'change', a);
  }
});

// ── ask_human carries the action ─────────────────────────────────────────────

function ask(onApprove, resolveHeadFn = () => TIP) {
  const written = [];
  const r = askHuman({
    hiveRoot: '/tmp/no-hive', agentId: 'god-1', cardId: 'c', kind: 'decision', questionMd: Q, onApprove, resolveHeadFn,
    outboxDir: '/tmp/no-hive/outbox', writeFileFn: (p, c) => written.push([p, c])
  });
  return { r, written };
}

test('ask_human on_approve puts a merge action on the patch and tells the human the fixed reply', () => {
  const action = { type: 'merge', repo: '/r/main', worktree: '/s/w1/wt', branch: BRANCH, target: TARGET };
  const { r, written } = ask(action);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.patchPayload.body.approveAction, { ...action, head: TIP }, 'the branch tip at ask time is pinned');
  assert.ok(r.formattedQuestion.includes(TIP.slice(0, 8)), 'the reply line names the sha the human approves');
  assert.equal(ask({ ...action, head: TIP.slice(0, 10) }).r.patchPayload.body.approveAction.head, TIP, 'a short pin is stored as the full tip');
  assert.equal(written.length, 1);
  assert.match(r.formattedQuestion, /\bgood\b/);
  assert.ok(r.formattedQuestion.includes(BRANCH) && r.formattedQuestion.includes(TARGET), 'the reply line names branch and target');
  assert.match(r.formattedQuestion, /no push|nothing is pushed/i);
  const plain = askHuman({ hiveRoot: '/tmp/no-hive', agentId: 'god-1', cardId: 'c', kind: 'decision', answers: 'yes_no', questionMd: Q, outboxDir: '/tmp/x', writeFileFn: () => {} });
  assert.equal(plain.ok, true);
  assert.equal(plain.patchPayload.body.approveAction, undefined, 'no action without on_approve');
});

test('ask_human refuses an action that pushes, is not a merge, or misses a field', () => {
  const ok = { type: 'merge', repo: '/r/main', worktree: '/s/w1/wt', branch: BRANCH, target: TARGET };
  for (const [bad, why] of [
    [{ ...ok, push: true }, /push/i],
    [{ ...ok, type: 'rebase' }, /merge/i],
    [{ ...ok, target: '' }, /target/i],
    [{ ...ok, repo: 'relative/repo' }, /absolute/i],
    [{ ...ok, head: 'not a sha' }, /head/i],
    [{ ...ok, head: 'fedcba9876' }, /tip/i]
  ]) {
    const { r, written } = ask(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, why);
    assert.equal(written.length, 0, 'nothing written on refusal');
  }
  const { r, written } = ask(ok, () => null);
  assert.equal(r.ok, false, 'no pin, no action');
  assert.match(r.error, /tip/i);
  assert.equal(written.length, 0);
});

// ── task-patch binds the action to its question ─────────────────────────────

test('the Boss patch binds approveAction to the question it came with; workers and orphan actions are refused', () => {
  const tasks = [{ id: 'c', title: 'Card', assignee: 'w1', status: 'doing', dependsOn: [] }];
  const action = { type: 'merge', repo: '/r/main', worktree: '/s/w1/wt', branch: BRANCH, target: TARGET, head: TIP };
  const now = '2026-11-12T19:00:00Z';
  const boss = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'c', status: 'blocked', humanQAAppend: { q: Q }, approveAction: action } });
  assert.equal(boss.ok, true, boss.reason);
  assert.deepEqual(boss.patch.approveAction, { ...action, q: Q, askedAt: now });
  const orphan = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'c', approveAction: action } });
  assert.equal(orphan.ok, false);
  assert.match(orphan.reason, /humanQAAppend/);
  const { head, ...unpinned } = action;
  const loose = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'c', humanQAAppend: { q: Q }, approveAction: unpinned } });
  assert.equal(loose.ok, false, 'an action without a head pin is refused');
  assert.match(loose.reason, /head/);
  const pushy = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'c', humanQAAppend: { q: Q }, approveAction: { ...action, push: true } } });
  assert.equal(pushy.ok, false);
  const worker = planTaskMessage({ act: 'task-patch', sender: 'w1', isBoss: false, tasks, now, body: { id: 'c', humanQAAppend: { q: Q }, approveAction: action } });
  assert.equal(worker.ok, false);
  const clear = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'c', approveAction: null } });
  assert.equal(clear.ok, true, clear.reason);
  assert.ok('approveAction' in clear.patch && clear.patch.approveAction === undefined, 'null clears the action');
});

// ── Approve: the harness merges ─────────────────────────────────────────────

test('end to end: ask_human with on_approve, the human answers good, the harness fast-forwards and closes the card without pushing', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: null, card: { status: 'doing', humanQA: [] } });
  const outboxDir = path.join(f.home, 'hive', 'agents', 'god-1', 'outbox');
  const r = askHuman({
    hiveRoot: path.join(f.home, 'hive'), agentId: 'god-1', cardId: 'c', kind: 'decision', questionMd: Q, outboxDir,
    onApprove: { type: 'merge', repo: repos.repo, worktree: repos.wt, branch: BRANCH, target: TARGET }
  });
  assert.equal(r.ok, true, r.error);
  f.hive.routeOnce();
  const asked = f.get();
  assert.equal(asked.status, 'blocked');
  assert.equal(asked.approveAction.q, r.formattedQuestion);
  const branchHead = git('-C', repos.wt, 'rev-parse', 'HEAD');
  assert.equal(asked.approveAction.head, branchHead, 'ask_human pinned the tip it asked about');

  assert.deepEqual(f.answer('good', r.formattedQuestion), { assignee: 'w1', boss: false });
  assert.equal(f.head(), branchHead, 'target fast-forwarded to the branch tip');
  assert.equal(repos.remoteHead(), repos.base, 'nothing pushed');
  const card = f.get();
  assert.equal(card.status, 'done');
  assert.ok(card.result.includes(branchHead.slice(0, 8)), 'result names the merged sha');
  assert.equal(card.approveAction, undefined, 'the action is spent');
  const mail = f.hive.inbox('w1');
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /merged/i);
  assert.ok(mail[0].body.includes(branchHead.slice(0, 8)));
  assert.equal(f.bossMail().length, 0, 'the Boss is not pulled in');
  assert.ok(fs.existsSync(repos.wt), 'cleanup is off by default: the worktree stays');
  assert.doesNotMatch(mail[0].body, /delete/i, 'no cleanup request while the flag is off');
  assert.ok(f.hive.logTail(50).some((e) => e.kind === 'approved-merge' && e.id === 'c'));
});

test('target moved: the harness asks the worker to rebase, then merges on the worker done', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos);
  commit(repos.repo, 'other.txt', 'someone else merged first\n');
  const moved = f.head();

  assert.deepEqual(f.answer('good'), { assignee: 'w1', boss: false });
  assert.equal(f.head(), moved, 'no merge while the target has moved');
  assert.equal(f.get().status, 'blocked');
  assert.ok(f.get().approveAction.pendingRebase, 'the approval is held for the retry');
  const req = f.hive.inbox('w1');
  assert.equal(req.length, 1);
  assert.equal(req[0].act, 'request');
  assert.match(req[0].body, /rebase/i);
  assert.ok(req[0].body.includes(BRANCH) && req[0].body.includes(TARGET));
  assert.equal(f.bossMail().length, 0);

  git('-C', repos.wt, 'rebase', '-q', TARGET);
  const rebased = git('-C', repos.wt, 'rev-parse', 'HEAD');
  f.workerDone(`c rebased: branch ${BRANCH} @ ${rebased} onto ${TARGET}. tests: 5/5 pass`);
  assert.equal(f.head(), rebased, 'retry fast-forwarded the rebased tip');
  assert.equal(repos.remoteHead(), repos.base, 'nothing pushed');
  assert.equal(f.get().status, 'done');
  assert.ok(f.hive.inbox('w1').some((m) => /merged/i.test(m.body) && m.body.includes(rebased.slice(0, 8))));
  assert.equal(f.bossMail().length, 0, 'only the worker done reached the Boss');
});

test('a rebase that changes what the human approved goes to the Boss instead of merging', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos);
  commit(repos.repo, 'other.txt', 'moved\n');
  f.answer('good');
  git('-C', repos.wt, 'rebase', '-q', TARGET);
  commit(repos.wt, 'src/extra.txt', 'not in the approved change\n');
  const before = f.head();
  f.workerDone(`c rebased: branch ${BRANCH}. tests: 5/5 pass`);
  assert.equal(f.head(), before, 'no merge');
  assert.equal(f.get().status, 'blocked');
  const boss = f.bossMail();
  assert.equal(boss.length, 1);
  assert.match(boss[0].body, /differ|changed/i);
});

test('a failed preflight goes to the Boss with the failing check; nothing merges and the worker is not mailed', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos);
  put(repos.repo, 'base.txt', 'The human is mid-edit\n');
  assert.deepEqual(f.answer('good'), { assignee: null, boss: true });
  assert.equal(f.head(), repos.base);
  assert.equal(f.get().status, 'blocked');
  assert.equal(f.hive.inbox('w1').length, 0);
  const boss = f.bossMail();
  assert.equal(boss.length, 1);
  assert.match(boss[0].body, /clean-tree/);
});

test('a pinned head that no longer matches the branch goes to the Boss', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: { head: repos.base } });
  assert.deepEqual(f.answer('good'), { assignee: null, boss: true });
  assert.equal(f.head(), repos.base);
  assert.match(f.bossMail()[0].body, /head|moved since/i);
});

test('a commit landing on the branch after ask_human pinned its tip goes to the Boss, not into the target', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: null, card: { status: 'doing', humanQA: [] } });
  const r = askHuman({
    hiveRoot: path.join(f.home, 'hive'), agentId: 'god-1', cardId: 'c', kind: 'decision', questionMd: Q,
    outboxDir: path.join(f.home, 'hive', 'agents', 'god-1', 'outbox'),
    onApprove: { type: 'merge', repo: repos.repo, worktree: repos.wt, branch: BRANCH, target: TARGET }
  });
  assert.equal(r.ok, true, r.error);
  f.hive.routeOnce();
  commit(repos.wt, 'src/unreviewed.txt', 'The human never saw this\n');
  assert.deepEqual(f.answer('good', r.formattedQuestion), { assignee: null, boss: true });
  assert.equal(f.head(), repos.base, 'nothing merged');
  assert.match(f.bossMail()[0].body, /moved since/);
});

test('a stored action without a head pin never merges', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: { head: undefined } });
  assert.deepEqual(f.answer('good'), { assignee: null, boss: true });
  assert.equal(f.head(), repos.base);
  assert.match(f.bossMail()[0].body, /head/);
});

// ── A rebase request the worker never answers ───────────────────────────────

test('no done after a rebase request: the Boss hears once the wait runs out and the held merge is dropped', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { rebaseTimeoutMs: 40 });
  commit(repos.repo, 'other.txt', 'moved\n');
  f.answer('good');
  assert.ok(f.get().approveAction.pendingRebase.requestedAt, 'the request time is recorded');
  assert.equal(f.bossMail().length, 0);
  await sleep(200);
  const boss = f.bossMail();
  assert.equal(boss.length, 1, 'one notice');
  assert.match(boss[0].body, /no done/i);
  assert.equal(f.get().status, 'blocked');
  assert.equal(f.get().approveAction, undefined, 'the Boss owns the merge now');
  const moved = f.head();
  git('-C', repos.wt, 'rebase', '-q', TARGET);
  f.workerDone(`c rebased: branch ${BRANCH}. tests: 5/5 pass`);
  assert.equal(f.head(), moved, 'a late done does not merge by itself');
});

test('a done before the wait runs out cancels the timeout', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { rebaseTimeoutMs: 60 });
  commit(repos.repo, 'other.txt', 'moved\n');
  f.answer('good');
  git('-C', repos.wt, 'rebase', '-q', TARGET);
  f.workerDone(`c rebased: branch ${BRANCH}. tests: 5/5 pass`);
  assert.equal(f.get().status, 'done');
  await sleep(200);
  assert.equal(f.bossMail().length, 0, 'no timeout notice after the merge');
});

test('a held rebase survives a restart: the timeout re-arms from the recorded request time', async (t) => {
  const repos = makeRepos(t);
  const long = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const pendingRebase = { approvedAt: long, requestedAt: long, answer: 'good', approvedHead: TIP, patchIds: ['x'], attempts: 1 };
  const f = await floor(t, repos, { action: { pendingRebase } });
  f.hive.resumeApprovedRebaseTimers();
  await sleep(100);
  assert.equal(f.bossMail().length, 1, 'an overdue request escalates on resume');
  assert.match(f.bossMail()[0].body, /no done/i);
  assert.equal(f.get().approveAction, undefined);
});

// ── Not an approve ──────────────────────────────────────────────────────────

test('an ambiguous or negative answer goes to the Boss with the card untouched', async (t) => {
  for (const a of ['good but make it red', 'not yet']) {
    const repos = makeRepos(t);
    const f = await floor(t, repos);
    assert.deepEqual(f.answer(a), { assignee: null, boss: true }, a);
    assert.equal(f.head(), repos.base);
    assert.equal(f.get().status, 'blocked');
    assert.equal(f.hive.inbox('w1').length, 0);
    assert.equal(f.bossMail().length, 1);
  }
});

test('a change request goes straight to the worker and reopens the card; the Boss is not mailed', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos);
  assert.deepEqual(f.answer('make the tail longer'), { assignee: 'w1', boss: false });
  assert.equal(f.head(), repos.base);
  assert.equal(f.get().status, 'todo');
  assert.equal(f.hive.inbox('w1').length, 1);
  assert.equal(f.bossMail().length, 0);
  assert.equal(f.get().approveAction, undefined, 'a send-back spends the action');
});

test('an action bound to an older question is ignored', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: { q: '**An older question?**' } });
  f.answer('good');
  assert.equal(f.head(), repos.base, 'no merge from a stale action');
});

// ── Fallback: answers on awaiting-merge cards without an action ─────────────

test('fallback: an approve on an awaiting-merge card without an action goes to the Boss and does not reopen it', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: null });
  assert.deepEqual(f.answer('good'), { assignee: null, boss: true });
  assert.equal(f.get().status, 'blocked');
  assert.equal(f.hive.inbox('w1').length, 0);
  assert.equal(f.bossMail().length, 1);
});

test('fallback: any other answer on an awaiting-merge card also notifies the Boss', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: null });
  const r = f.answer('make the tail longer');
  assert.equal(r.assignee, 'w1');
  assert.equal(r.boss, true);
  assert.equal(f.get().status, 'todo');
  assert.equal(f.hive.inbox('w1').length, 1);
  assert.match(f.bossMail()[0].body, /awaiting boss merge/i);
});

test('fallback: a card not awaiting merge keeps the old routing (worker only)', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { action: null, card: { notes: 'worker asked a question' } });
  assert.deepEqual(f.answer('make the tail longer'), { assignee: 'w1', boss: false });
  assert.equal(f.bossMail().length, 0);
});

// ── Post-merge cleanup, behind the flag ─────────────────────────────────────

test('cleanup on: a clean merged worktree in the worker scratch is removed and the worker is asked to clear its own scratch', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { cleanup: true });
  f.answer('good');
  assert.equal(f.get().status, 'done');
  assert.equal(fs.existsSync(repos.wt), false, 'worktree removed');
  assert.doesNotMatch(git('-C', repos.repo, 'worktree', 'list'), /MD-worker/);
  assert.ok(git('-C', repos.repo, 'rev-parse', '--verify', `refs/heads/${BRANCH}`), 'the branch ref is kept');
  const mail = f.hive.inbox('w1').at(-1);
  assert.match(mail.body, /removed/i);
  assert.match(mail.body, /delete your own/i);
  assert.match(mail.body, /size/i);
});

test('cleanup on: untracked files in the worktree stop the merge at preflight, so nothing is removed', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { cleanup: true });
  put(repos.wt, 'scratch-notes.txt', 'mine\n');
  assert.deepEqual(f.answer('good'), { assignee: null, boss: true });
  assert.equal(f.head(), repos.base);
  assert.ok(fs.existsSync(path.join(repos.wt, 'scratch-notes.txt')), 'nothing deleted');
  assert.match(f.bossMail()[0].body, /no-stray-files/);
});

test('cleanupMergedWorktree keeps a merged worktree that gained untracked files, changes or commits after the merge', (t) => {
  const { cleanupMergedWorktree } = loadTs('src/main/approvedMerge.ts');
  const repos = makeRepos(t);
  const head = git('-C', repos.wt, 'rev-parse', 'HEAD');
  git('-C', repos.repo, 'merge', '-q', '--ff-only', head);
  const o = { repo: repos.repo, worktree: repos.wt, branch: BRANCH, target: TARGET, head, workerId: 'w1', scratchRoot: repos.scratch };

  put(repos.wt, 'scratch-notes.txt', 'mine\n');
  let r = cleanupMergedWorktree(o);
  assert.equal(r.removed, false);
  assert.match(r.reason, /untracked/);
  fs.unlinkSync(path.join(repos.wt, 'scratch-notes.txt'));

  put(repos.wt, 'base.txt', 'edited\n');
  r = cleanupMergedWorktree(o);
  assert.equal(r.removed, false);
  assert.match(r.reason, /uncommitted/);
  git('-C', repos.wt, 'checkout', '-q', '--', 'base.txt');

  commit(repos.wt, 'src/later.txt', 'after the merge\n');
  r = cleanupMergedWorktree(o);
  assert.equal(r.removed, false);
  assert.match(r.reason, /tip moved/);
  assert.ok(fs.existsSync(repos.wt), 'every refusal leaves the worktree in place');
});

test('cleanup on: a branch that already landed in a target that moved on still gets its clean worktree removed', async (t) => {
  const repos = makeRepos(t);
  const f = await floor(t, repos, { cleanup: true });
  git('-C', repos.repo, 'merge', '-q', '--ff-only', BRANCH);
  commit(repos.repo, 'later.txt', 'target moved on\n');
  f.answer('good');
  assert.equal(f.get().status, 'done');
  assert.match(f.get().result, /already/);
  assert.equal(fs.existsSync(repos.wt), false, 'worktree removed');
});

test('every module reads the scratch root from the one MD_HIVE_SCRATCH_ROOT setting', () => {
  const dir = path.join(__dirname, '..', 'src', 'main');
  const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
    .filter((f) => /process\.env\.HIVE_SCRATCH_ROOT\b/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test("cleanup on: a worktree outside the worker's own scratch folder is kept", async (t) => {
  const repos = makeRepos(t, { worker: 'w2' });
  const f = await floor(t, repos, { cleanup: true });
  f.answer('good');
  assert.equal(f.get().status, 'done');
  assert.ok(fs.existsSync(repos.wt), 'another agent folder is never touched');
  assert.match(f.hive.inbox('w1').at(-1).body, /kept/i);
});
