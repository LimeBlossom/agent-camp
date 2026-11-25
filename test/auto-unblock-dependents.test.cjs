'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const {
  isAutoUnblockEligible,
  planAutoUnblock,
  hasOpenHumanQA,
  isHeldByOtherReason,
  AWAITING_MERGE_RE,
  humanAskRe
} = loadTs('src/main/autoUnblockDependents.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const card = (id, status, extra = {}) => ({
  id,
  status,
  title: `Task ${id}`,
  assignee: 'w1',
  dependsOn: [],
  createdAt: '2026-11-11T00:00:00Z',
  ...extra
});

test('single dep: blocked card is eligible and unblocks when its only dep is done', () => {
  const dep = card('dep-1', 'done');
  const target = card('target-1', 'blocked', { dependsOn: ['dep-1'] });
  const tasks = [dep, target];

  assert.equal(isAutoUnblockEligible(target, tasks), true);

  const plan = planAutoUnblock(tasks);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], {
    id: 'target-1',
    assignee: 'w1',
    dependsOn: ['dep-1'],
    patch: { status: 'todo' }
  });
});

test('multiple deps partly done: blocked card stays blocked until ALL deps are done', () => {
  const dep1 = card('dep-1', 'done');
  const dep2 = card('dep-2', 'doing');
  const target = card('target-multi', 'blocked', { dependsOn: ['dep-1', 'dep-2'] });
  const tasks = [dep1, dep2, target];

  assert.equal(isAutoUnblockEligible(target, tasks), false, 'cannot unblock when dep-2 is still doing');
  assert.equal(planAutoUnblock(tasks).length, 0);

  // Once dep-2 completes and reaches 'done'
  dep2.status = 'done';
  assert.equal(isAutoUnblockEligible(target, tasks), true, 'eligible now that all deps are done');
  const plan = planAutoUnblock(tasks);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'target-multi');
  assert.deepEqual(plan[0].patch, { status: 'todo' });
});

test('humanQA-held card: blocked card with open humanQA stays blocked even when deps are done', () => {
  const dep = card('dep-1', 'done');
  const target = card('target-qa', 'blocked', {
    dependsOn: ['dep-1'],
    humanQA: [{ q: 'Should this be Option A or Option B?', askedAt: '2026-11-11T01:00:00Z' }]
  });
  const tasks = [dep, target];

  assert.equal(hasOpenHumanQA(target), true);
  assert.equal(isHeldByOtherReason(target), true);
  assert.equal(isAutoUnblockEligible(target, tasks), false);
  assert.equal(planAutoUnblock(tasks).length, 0);

  // If humanQA was answered, it is no longer an open question
  target.humanQA = [
    {
      q: 'Should this be Option A or Option B?',
      a: 'Option A approved',
      askedAt: '2026-11-11T01:00:00Z',
      answeredAt: '2026-11-11T02:00:00Z'
    }
  ];
  assert.equal(hasOpenHumanQA(target), false);
  assert.equal(isHeldByOtherReason(target), false);
  assert.equal(isAutoUnblockEligible(target, tasks), true);

  // If humanQA was dismissed, it is no longer an open question
  target.humanQA = [
    {
      q: 'Should this be Option A or Option B?',
      askedAt: '2026-11-11T01:00:00Z',
      dismissedAt: '2026-11-11T02:00:00Z'
    }
  ];
  assert.equal(hasOpenHumanQA(target), false);
  assert.equal(isAutoUnblockEligible(target, tasks), true);
});

test('no deps: blocked card without dependencies stays blocked', () => {
  const targetEmpty = card('target-empty', 'blocked', { dependsOn: [] });
  const targetNone = card('target-none', 'blocked');
  delete targetNone.dependsOn;

  assert.equal(isAutoUnblockEligible(targetEmpty, [targetEmpty]), false);
  assert.equal(isAutoUnblockEligible(targetNone, [targetNone]), false);
  assert.equal(planAutoUnblock([targetEmpty, targetNone]).length, 0);
});

test('already todo: card that is already todo or doing is untouched', () => {
  const dep = card('dep-1', 'done');
  const targetTodo = card('target-todo', 'todo', { dependsOn: ['dep-1'] });
  const targetDoing = card('target-doing', 'doing', { dependsOn: ['dep-1'] });
  const tasks = [dep, targetTodo, targetDoing];

  assert.equal(isAutoUnblockEligible(targetTodo, tasks), false);
  assert.equal(isAutoUnblockEligible(targetDoing, tasks), false);
  assert.equal(planAutoUnblock(tasks).length, 0);
});

test('held by notes awaiting boss merge: stays blocked', () => {
  const dep = card('dep-1', 'done');
  const target = card('target-merge', 'blocked', {
    dependsOn: ['dep-1'],
    notes: 'awaiting boss merge: branch w1/feature 123456'
  });
  const tasks = [dep, target];

  assert.equal(AWAITING_MERGE_RE.test(target.notes), true);
  assert.equal(isHeldByOtherReason(target), true);
  assert.equal(isAutoUnblockEligible(target, tasks), false);
  assert.equal(planAutoUnblock(tasks).length, 0);
});

test('held by notes the human ask: stays blocked', () => {
  const dep = card('dep-1', 'done');
  const variations = [
    'awaiting the human ask via god; do not merge.',
    'waiting on the human: direction, art, name',
    'Blocked on the human: weak props (rack, battery, saw)',
    'Blocked until the human says resume, so it stops waking an agent.',
    'PAUSED by the human (budget to Alpha).',
    'Parked with alpha-devlog-reels (The human). Resume only when the human says so.',
    'The human ASK ME: 8 clips in god/shots/'
  ];

  for (const note of variations) {
    const target = card('target-human', 'blocked', {
      dependsOn: ['dep-1'],
      notes: note
    });
    assert.equal(humanAskRe().test(note), true, `note should match the human ask regex: ${note}`);
    assert.equal(isHeldByOtherReason(target), true);
    assert.equal(isAutoUnblockEligible(target, [dep, target]), false);
  }
});

test('backlogged card: stays blocked even when deps finish', () => {
  const dep = card('dep-1', 'done');
  const target = card('target-backlog', 'blocked', {
    dependsOn: ['dep-1'],
    backloggedAt: '2026-11-01T00:00:00Z'
  });
  const tasks = [dep, target];

  assert.equal(isHeldByOtherReason(target), true);
  assert.equal(isAutoUnblockEligible(target, tasks), false);
  assert.equal(planAutoUnblock(tasks).length, 0);
});

test('startup run: cards already eligible at startup are unblocked to todo and logged', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-unblock-startup-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.writeTasks([
    card('dep-a', 'done', { assignee: 'w1' }),
    card('target-startup', 'blocked', { assignee: 'w1', dependsOn: ['dep-a'] }),
    card('target-held', 'blocked', { assignee: 'w1', dependsOn: ['dep-a'], notes: 'awaiting boss merge' })
  ]);

  const unblocked = hive.autoUnblockDependents();
  assert.deepEqual(unblocked, ['target-startup']);

  const current = hive.tasks().tasks;
  const targetStartup = current.find((x) => x.id === 'target-startup');
  const targetHeld = current.find((x) => x.id === 'target-held');

  assert.equal(targetStartup.status, 'todo');
  assert.equal(targetHeld.status, 'blocked');

  // Verify event in log.jsonl
  const logs = hive.logTail(100);
  const unblockEvent = logs.find((e) => e.kind === 'auto-unblock' && e.id === 'target-startup');
  assert.ok(unblockEvent, 'log.jsonl must contain an auto-unblock event');
  assert.equal(unblockEvent.assignee, 'w1');
  assert.deepEqual(unblockEvent.dependsOn, ['dep-a']);
});

test('patchTask to done: setting a card to done unblocks dependent cards immediately and logs', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-unblock-patch-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.writeTasks([
    card('dep-live', 'doing', { assignee: 'w1' }),
    card('waiting-live', 'blocked', { assignee: 'w1', dependsOn: ['dep-live'] })
  ]);

  // Patch dep-live to done
  const patched = hive.patchTask('dep-live', { status: 'done' });
  assert.equal(patched, true);

  const current = hive.tasks().tasks;
  assert.equal(current.find((x) => x.id === 'dep-live').status, 'done');
  assert.equal(current.find((x) => x.id === 'waiting-live').status, 'todo');

  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-unblock' && e.id === 'waiting-live'));
});

test('through outbox: Boss task-patch marking a card done auto-unblocks dependent card in routeOnce', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-unblock-outbox-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.writeTasks([
    card('dep-boss', 'doing', { assignee: 'w1' }),
    card('downstream', 'blocked', { assignee: 'w1', dependsOn: ['dep-boss'] })
  ]);

  const bossOut = path.join(home, 'hive', 'agents', 'god-1', 'outbox');
  fs.writeFileSync(
    path.join(bossOut, 'done-patch.json'),
    JSON.stringify({
      to: 'harness',
      act: 'task-patch',
      body: { id: 'dep-boss', status: 'done' }
    })
  );

  hive.routeOnce();

  const current = hive.tasks().tasks;
  assert.equal(current.find((x) => x.id === 'dep-boss').status, 'done');
  assert.equal(current.find((x) => x.id === 'downstream').status, 'todo');

  const logs = hive.logTail(100);
  assert.ok(logs.some((e) => e.kind === 'auto-unblock' && e.id === 'downstream'));
});
