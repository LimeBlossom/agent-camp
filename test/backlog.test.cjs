'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { isBacklogged, backlogPatch, unbacklogPatch } = loadTs('src/shared/backlog.ts');
const { planTaskMessage, unparkPlan } = loadTs('src/main/taskPatch.ts');

const card = (id, status, extra = {}) => ({ id, title: `T ${id}`, status, assignee: 'hazel', dependsOn: [], ...extra });
const bossPatch = (tasks, body) =>
  planTaskMessage({ act: 'task-patch', body, sender: 'god', isBoss: true, tasks, now: '2026-10-21T20:00:00Z' });

test('a card is backlogged only while it carries backloggedAt and is not done', () => {
  assert.equal(isBacklogged(card('a', 'blocked', { backloggedAt: '2026-10-21T19:00:00Z' })), true);
  assert.equal(isBacklogged(card('b', 'blocked')), false);
  assert.equal(isBacklogged(card('c', 'done', { backloggedAt: '2026-10-21T19:00:00Z' })), false);
  assert.equal(isBacklogged(card('d', 'blocked', { backloggedAt: '' })), false);
});

test('shelving blocks the card and bringing it back only clears the mark', () => {
  assert.deepEqual(backlogPatch('2026-10-21T19:00:00Z'), { status: 'blocked', backloggedAt: '2026-10-21T19:00:00Z' });
  const back = unbacklogPatch();
  assert.ok('backloggedAt' in back && back.backloggedAt === undefined);
  assert.equal('status' in back, false);
});

test('the Boss can shelve a card, and null brings it back', () => {
  const tasks = [card('a', 'doing')];
  const shelve = bossPatch(tasks, { id: 'a', status: 'blocked', backloggedAt: '2026-10-21T19:00:00Z' });
  assert.equal(shelve.ok, true);
  assert.equal(shelve.patch.backloggedAt, '2026-10-21T19:00:00Z');
  const back = bossPatch([card('a', 'blocked', { backloggedAt: 'x' })], { id: 'a', backloggedAt: null });
  assert.equal(back.ok, true);
  assert.ok('backloggedAt' in back.patch && back.patch.backloggedAt === undefined);
  assert.equal(bossPatch(tasks, { id: 'a', backloggedAt: 5 }).ok, false);
});

test('a worker cannot shelve its own card', () => {
  const plan = planTaskMessage({ act: 'task-patch', body: { id: 'a', backloggedAt: 'x' }, sender: 'hazel', isBoss: false, tasks: [card('a', 'doing')], now: 'n' });
  assert.equal(plan.ok, false);
});

test('reopening the floor never puts a shelved parked card back to todo', () => {
  const plan = unparkPlan([
    card('shelved', 'blocked', { parkedFrom: 'doing', parkedAt: '2026-10-21T18:00:00Z', backloggedAt: '2026-10-21T19:00:00Z' }),
    card('parked', 'blocked', { parkedFrom: 'doing', parkedAt: '2026-10-21T18:00:00Z' })
  ]);
  const byId = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.equal(byId.shelved.restored, false);
  assert.equal('status' in byId.shelved.patch, false);
  assert.equal(byId.parked.restored, true);
});

test('shelving forces blocked so the assignee is not woken', () => {
  const plan = bossPatch([card('a', 'doing')], { id: 'a', backloggedAt: '2026-10-21T19:00:00Z' });
  assert.equal(plan.ok, true);
  assert.equal(plan.patch.status, 'blocked');
  const done = bossPatch([card('b', 'done')], { id: 'b', backloggedAt: '2026-10-21T19:00:00Z' });
  assert.equal(done.patch.status, undefined);
});

test('a shelved card refuses todo/doing until the mark is cleared', () => {
  const shelved = card('a', 'blocked', { backloggedAt: '2026-10-21T19:00:00Z' });
  assert.equal(bossPatch([shelved], { id: 'a', status: 'todo' }).ok, false);
  assert.equal(bossPatch([card('b', 'blocked')], { id: 'b', status: 'doing', backloggedAt: '2026-10-21T19:00:00Z' }).ok, false);
  const worker = planTaskMessage({ act: 'task-patch', body: { id: 'a', status: 'doing' }, sender: 'hazel', isBoss: false, tasks: [shelved], now: '2026-10-21T20:00:00Z' });
  assert.equal(worker.ok, false);
  const back = bossPatch([shelved], { id: 'a', status: 'todo', backloggedAt: null });
  assert.equal(back.ok, true);
  assert.equal(back.patch.status, 'todo');
  assert.equal(bossPatch([shelved], { id: 'a', status: 'done' }).ok, true);
});
