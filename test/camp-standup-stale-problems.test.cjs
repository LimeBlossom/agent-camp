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

const {
  runOpsStandup,
  standupProblems,
  standupTaskFingerprint
} = loadTs('src/main/standupGate.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { AWAITING_MERGE } = loadTs('src/main/taskPatch.ts');

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8'
  });
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

function makeRepos(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-standup-ff-'));
  t.after(() => rmTree(tmp));
  const mainRepo = path.join(tmp, 'main-repo');
  const wt = path.join(tmp, 'worktree');

  git('init', '-q', '-b', 'master', mainRepo);
  commit(mainRepo, 'base.txt', 'base');
  git('-C', mainRepo, 'worktree', 'add', '-q', '-b', 'worker/feature-1', wt, 'master');
  commit(wt, 'src/feature.txt', 'feature work');

  return { tmp, mainRepo, wt };
}

// ─── ITEM 1: The standup mark saves a fingerprint of the problem list ─────────

test('Item 1: standup mark saves a fingerprint of the problem list on send and ack', () => {
  const problemsList = ['w1: breaker steering', 't1: awaiting boss merge'];
  let savedMark = null;
  const sent = runOpsStandup({
    mark: () => null,
    saveMark: (m) => { savedMark = m; },
    tasks: () => ({ tasks: [] }),
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => {},
    appendLog: () => {},
    now: () => 1_000_000,
    problems: () => problemsList
  });
  assert.equal(sent, true);
  assert.ok(savedMark, 'saveMark must be called');
  const fp = savedMark.problems ?? savedMark.problemsFp;
  assert.ok(typeof fp === 'string' && fp.length > 0, 'standup mark must save a string fingerprint of the problem list');
});

test('Item 1: problem list fingerprint changes when problems change and is order-independent', () => {
  let markA = null;
  let markB = null;
  let markC = null;
  const runWith = (problems, onSave) => runOpsStandup({
    mark: () => null,
    saveMark: onSave,
    tasks: () => ({ tasks: [] }),
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => {},
    appendLog: () => {},
    now: () => 1_000_000,
    problems: () => problems
  });
  runWith(['p1', 'p2'], (m) => { markA = m; });
  runWith(['p2', 'p1'], (m) => { markB = m; });
  runWith(['p1'], (m) => { markC = m; });

  const fpA = markA?.problems ?? markA?.problemsFp;
  const fpB = markB?.problems ?? markB?.problemsFp;
  const fpC = markC?.problems ?? markC?.problemsFp;

  assert.ok(typeof fpA === 'string' && fpA.length > 0, 'markA must have a problem fingerprint');
  assert.equal(fpA, fpB, 'problem list fingerprint should be order-independent');
  assert.notEqual(fpA, fpC, 'different problem lists must produce different fingerprints');
});

// ─── ITEM 2: runOpsStandup skips when problem list matches last mark ──────────

test('Item 2: runOpsStandup skips when problem list matches the last mark and nothing else changed', () => {
  const tasks = { tasks: [{ id: 't1', status: 'blocked', notes: 'awaiting boss merge' }] };
  const problems = ['t1: awaiting boss merge'];

  let mark = null;
  let sentCount = 0;
  const logs = [];
  const run = (curMark, curProblems) => runOpsStandup({
    mark: () => curMark,
    saveMark: (m) => { mark = m; },
    tasks: () => tasks,
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => { sentCount++; },
    appendLog: (e) => { logs.push(e); },
    now: () => 2_000_000,
    problems: () => curProblems
  });

  // First run: fires standup and saves mark
  const first = run(null, problems);
  assert.equal(first, true);
  assert.equal(sentCount, 1);
  assert.ok(mark, 'mark was saved on first standup');

  // Second run: 1 hour later, nothing changed, same problem list
  sentCount = 0;
  logs.length = 0;
  const ran = run(mark, problems);
  assert.equal(ran, false, 'runOpsStandup must skip when problem list matches last mark');
  assert.equal(sentCount, 0, 'Boss must not be woken when problem list is unchanged');
  assert.ok(logs.some((e) => e.kind === 'standup-skipped'), 'standup-skipped must be logged');
});

test('Item 2: runOpsStandup fires when an item is added to the problem list', () => {
  const tasks = { tasks: [{ id: 't1', status: 'blocked', notes: 'awaiting boss merge' }] };
  let mark = null;
  let sentCount = 0;
  const logs = [];
  const run = (curMark, curProblems) => runOpsStandup({
    mark: () => curMark,
    saveMark: (m) => { mark = m; },
    tasks: () => tasks,
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => { sentCount++; },
    appendLog: (e) => { logs.push(e); },
    now: () => 2_000_000,
    problems: () => curProblems
  });

  // Base state with 1 problem
  run(null, ['p1']);
  assert.equal(sentCount, 1);

  // Unchanged problem list skips
  sentCount = 0;
  logs.length = 0;
  const ranSame = run(mark, ['p1']);
  assert.equal(ranSame, false, 'runOpsStandup must skip when problem list is unchanged');

  // Item added: ['p1', 'p2'] -> fires
  sentCount = 0;
  logs.length = 0;
  const ranAdd = run(mark, ['p1', 'p2']);
  assert.equal(ranAdd, true, 'runOpsStandup must fire when an item is added to problems');
  assert.equal(sentCount, 1);
  assert.equal(logs.some((e) => e.kind === 'standup-skipped'), false);
});

test('Item 2: runOpsStandup fires when an item is removed from the problem list', () => {
  const tasks = { tasks: [{ id: 't1', status: 'blocked', notes: 'awaiting boss merge' }] };
  let mark = null;
  let sentCount = 0;
  const logs = [];
  const run = (curMark, curProblems) => runOpsStandup({
    mark: () => curMark,
    saveMark: (m) => { mark = m; },
    tasks: () => tasks,
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => { sentCount++; },
    appendLog: (e) => { logs.push(e); },
    now: () => 2_000_000,
    problems: () => curProblems
  });

  // Base state with 2 problems
  run(null, ['p1', 'p2']);
  assert.equal(sentCount, 1);

  // Unchanged problem list skips
  sentCount = 0;
  logs.length = 0;
  const ranSame = run(mark, ['p1', 'p2']);
  assert.equal(ranSame, false, 'runOpsStandup must skip when problem list is unchanged');

  // Item removed: ['p1'] -> fires
  sentCount = 0;
  logs.length = 0;
  const ranRemove = run(mark, ['p1']);
  assert.equal(ranRemove, true, 'runOpsStandup must fire when an item is removed from problems');
  assert.equal(sentCount, 1);
  assert.equal(logs.some((e) => e.kind === 'standup-skipped'), false);
});

test('Item 2: runOpsStandup fires when an item in the problem list is changed', () => {
  const tasks = { tasks: [{ id: 't1', status: 'blocked', notes: 'awaiting boss merge' }] };
  let mark = null;
  let sentCount = 0;
  const logs = [];
  const run = (curMark, curProblems) => runOpsStandup({
    mark: () => curMark,
    saveMark: (m) => { mark = m; },
    tasks: () => tasks,
    logTail: () => [],
    godId: 'god',
    systemSenders: new Set(),
    send: () => { sentCount++; },
    appendLog: (e) => { logs.push(e); },
    now: () => 2_000_000,
    problems: () => curProblems
  });

  // Base state
  run(null, ['w1: 1 unread, quiet 60 min']);
  assert.equal(sentCount, 1);

  // Unchanged skips
  sentCount = 0;
  logs.length = 0;
  const ranSame = run(mark, ['w1: 1 unread, quiet 60 min']);
  assert.equal(ranSame, false, 'runOpsStandup must skip when problem list is unchanged');

  // Item changed: quiet 120 min -> fires
  sentCount = 0;
  logs.length = 0;
  const ranChange = run(mark, ['w1: 1 unread, quiet 120 min']);
  assert.equal(ranChange, true, 'runOpsStandup must fire when an item in problems changes');
  assert.equal(sentCount, 1);
  assert.equal(logs.some((e) => e.kind === 'standup-skipped'), false);
});

// ─── ITEM 3: Auto-merge replaces 'awaiting boss merge' note with merged sha ───

test('Item 3: after successful auto-merge, card notes replaces awaiting boss merge with merged <sha> into <target>', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-merge-notes-'));
  t.after(() => rmTree(home));

  const { mainRepo, wt } = makeRepos(t);
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.setFfMergeDeps({
    repos: mergeRepos({ beta: mainRepo, gamma: mainRepo })
  });

  hive.writeTasks([
    {
      id: 'alpha-task-merge-notes',
      title: 'Fix Alpha spider',
      assignee: 'w1',
      status: 'doing',
      project: 'Alpha',
      brief: 'Alpha spider fixed'
    }
  ]);

  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(
    path.join(out, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'alpha-task-merge-notes done',
      body: 'Branch worker/feature-1 (worktree ' + wt + ')\nSpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
    })
  );

  hive.routeOnce();

  // 1. Main repo fast-forwarded
  const headAfter = git('-C', mainRepo, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter, headBefore);

  // 2. Card is blocked
  const card = hive.tasks().tasks.find((x) => x.id === 'alpha-task-merge-notes');
  assert.ok(card, 'card must exist');
  assert.equal(card.status, 'blocked');

  // 3. 'awaiting boss merge' note is replaced by 'merged <sha> into <target>'
  assert.equal(AWAITING_MERGE.test(card.notes ?? ''), false, `card notes should not contain 'awaiting boss merge', got: ${card.notes}`);
  const shortSha = headAfter.slice(0, 8);
  const expectedMergedRegex = new RegExp(`merged\\s+(?:${headAfter}|${shortSha})\\s+into\\s+master`, 'i');
  assert.match(String(card.notes ?? ''), expectedMergedRegex, `card notes must contain 'merged <sha> into <target>', got: ${card.notes}`);

  // 4. Card no longer counts in standupProblems merge backlog
  const fleet = { agents: [{ id: 'god', isGod: true }, { id: 'w1' }] };
  const problems = standupProblems(fleet, hive.tasks());
  assert.equal(problems.some((p) => p.includes('alpha-task-merge-notes')), false, 'merged card must not count in standupProblems');
});

test('Item 3: auto-merge replaces existing worker awaiting-boss-merge notes and preserves other lines', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-merge-preserve-'));
  t.after(() => rmTree(home));

  const { mainRepo, wt } = makeRepos(t);
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.setFfMergeDeps({
    repos: mergeRepos({ beta: mainRepo, gamma: mainRepo })
  });

  hive.writeTasks([
    {
      id: 'alpha-task-preserve',
      title: 'Fix spider preserve notes',
      assignee: 'w1',
      status: 'blocked',
      notes: '11-19 w1: tests passing 10/10\nawaiting boss merge',
      project: 'Alpha',
      brief: 'Alpha spider fixed'
    }
  ]);

  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(
    path.join(out, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'alpha-task-preserve done',
      body: 'Branch worker/feature-1 (worktree ' + wt + ')\nSpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
    })
  );

  hive.routeOnce();

  const headAfter = git('-C', mainRepo, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter, headBefore);

  const card = hive.tasks().tasks.find((x) => x.id === 'alpha-task-preserve');
  assert.ok(card);
  assert.equal(AWAITING_MERGE.test(card.notes ?? ''), false);
  assert.match(String(card.notes ?? ''), /tests passing 10\/10/);
  assert.match(String(card.notes ?? ''), new RegExp(`merged\\s+(?:${headAfter}|${headAfter.slice(0, 8)})\\s+into\\s+master`, 'i'));
});

// ─── ITEM 4: Blocked card whose latest humanQA is unanswered ──────────────────

test('Item 4: standupProblems excludes blocked cards awaiting merge if latest humanQA is unanswered', () => {
  const fleet = { agents: [{ id: 'god', isGod: true }, { id: 'w1', lastActiveSecAgo: 60 }] };
  const tasks = {
    tasks: [
      {
        id: 'card-unanswered',
        status: 'blocked',
        notes: 'worker finished; awaiting boss merge',
        assignee: 'w1',
        humanQA: [
          { q: 'Should this be merged into staging or master?', askedAt: '2026-11-19T20:00:00Z' }
        ]
      },
      {
        id: 'card-answered',
        status: 'blocked',
        notes: 'worker finished; awaiting boss merge',
        assignee: 'w1',
        humanQA: [
          { q: 'Approve merge?', askedAt: '2026-11-19T20:00:00Z', a: 'approved', answeredAt: '2026-11-19T20:30:00Z' }
        ]
      },
      {
        id: 'card-no-qa',
        status: 'blocked',
        notes: 'awaiting boss merge',
        assignee: 'w1'
      }
    ]
  };

  const problems = standupProblems(fleet, tasks);
  assert.ok(!problems.some((p) => p.includes('card-unanswered')), 'card with unanswered humanQA must NOT count as awaiting boss merge in standupProblems');
  assert.ok(problems.some((p) => p.includes('card-answered') && p.includes('awaiting boss merge')), 'card with answered humanQA MUST count as awaiting boss merge');
  assert.ok(problems.some((p) => p.includes('card-no-qa') && p.includes('awaiting boss merge')), 'card with no humanQA MUST count as awaiting boss merge');
});

test('Item 4: standupProblems follows the latest humanQA entry when multiple entries exist', () => {
  const fleet = { agents: [{ id: 'god', isGod: true }] };
  const tasks = {
    tasks: [
      {
        id: 'c-multi-unanswered',
        status: 'blocked',
        notes: 'awaiting boss merge',
        humanQA: [
          { q: 'First question?', a: 'first answer', answeredAt: '2026-11-19T19:00:00Z' },
          { q: 'Follow-up question?', askedAt: '2026-11-19T20:00:00Z' }
        ]
      },
      {
        id: 'c-multi-answered',
        status: 'blocked',
        notes: 'awaiting boss merge',
        humanQA: [
          { q: 'First question?', askedAt: '2026-11-19T18:00:00Z' },
          { q: 'Second question?', a: 'second answer', answeredAt: '2026-11-19T20:00:00Z' }
        ]
      }
    ]
  };

  const problems = standupProblems(fleet, tasks);
  assert.ok(!problems.some((p) => p.includes('c-multi-unanswered')), 'latest unanswered question must count as waiting on the human, not merge backlog');
  assert.ok(problems.some((p) => p.includes('c-multi-answered') && p.includes('awaiting boss merge')), 'latest answered question counts as awaiting boss merge');
});
