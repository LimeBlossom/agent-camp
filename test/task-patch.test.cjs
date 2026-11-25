'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { planTaskMessage, unparkPlan } = loadTs('src/main/taskPatch.ts');

const card = (id, status, extra = {}) => ({ id, title: `T ${id}`, status, assignee: 'hazel', dependsOn: [], ...extra });
const patch = (tasks, body, closingTime, now = '2026-10-04T14:12:50Z') =>
  planTaskMessage({ act: 'task-patch', body, sender: 'god', isBoss: true, tasks, now, closingTime });

test('closing time parking a todo or doing card as blocked records where it came from', () => {
  const todo = patch([card('a', 'todo')], { id: 'a', status: 'blocked' }, true);
  assert.equal(todo.patch.parkedFrom, 'todo');
  assert.equal(todo.patch.parkedAt, '2026-10-04T14:12:50Z');
  assert.equal(patch([card('b', 'doing')], { id: 'b', status: 'blocked' }, true).patch.parkedFrom, 'doing');
  assert.equal(patch([card('c', 'blocked')], { id: 'c', status: 'blocked' }, true).patch.parkedFrom, undefined, 'already blocked: not parked');
  assert.equal(patch([card('d', 'todo')], { id: 'd', status: 'blocked' }, false).patch.parkedFrom, undefined, 'outside closing time: a real block');
});

test('a status change after closing time clears the parked marker', () => {
  const p = patch([card('a', 'blocked', { parkedFrom: 'todo', parkedAt: 'x' })], { id: 'a', status: 'done' }, false);
  assert.ok('parkedFrom' in p.patch && p.patch.parkedFrom === undefined);
});

test('reopening puts parked cards back to todo unless a question was asked while parked', () => {
  const plan = unparkPlan([
    card('parked', 'blocked', { parkedFrom: 'doing', parkedAt: '2026-10-04T14:00:00Z', humanQA: [{ q: 'old', askedAt: '2026-10-03T10:00:00Z' }] }),
    card('asked', 'blocked', { parkedFrom: 'todo', parkedAt: '2026-10-04T14:00:00Z', humanQA: [{ q: 'new', askedAt: '2026-10-04T14:00:00Z' }] }),
    card('finished', 'done', { parkedFrom: 'todo', parkedAt: '2026-10-04T14:00:00Z' }),
    card('normal', 'blocked')
  ]);
  assert.deepEqual(plan.map((p) => [p.id, p.restored, p.patch.status]), [
    ['parked', true, 'todo'],
    ['asked', false, undefined],
    ['finished', false, undefined]
  ]);
  for (const p of plan) assert.ok('parkedFrom' in p.patch && p.patch.parkedFrom === undefined, 'every marker is cleared');
});

test('only the Boss sets a card to done; a worker gets the reason back', () => {
  const tasks = [card('a', 'doing')];
  const worker = planTaskMessage({ act: 'task-patch', body: { id: 'a', status: 'done', result: 'sha 1' }, sender: 'hazel', isBoss: false, tasks, now: 'x' });
  assert.equal(worker.ok, false);
  assert.match(worker.reason, /only the Boss sets a card to done/);
  for (const status of ['todo', 'doing', 'blocked']) {
    assert.equal(planTaskMessage({ act: 'task-patch', body: { id: 'a', status }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).ok, true, status);
  }
  const boss = patch(tasks, { id: 'a', status: 'done' });
  assert.equal(boss.ok, true);
  assert.equal(boss.patch.status, 'done');
});

test('a task-create with status done lands only from the Boss', () => {
  const body = { id: 'n', title: 'N', status: 'done' };
  assert.equal(planTaskMessage({ act: 'task-create', body, sender: 'hazel', isBoss: false, tasks: [], now: 'x' }).ok, false);
  const boss = planTaskMessage({ act: 'task-create', body, sender: 'god', isBoss: true, tasks: [], now: 'x' });
  assert.equal(boss.ok, true);
  assert.equal(boss.card.status, 'done');
});

test('task-create and task-patch accept an optional short nickname (max ~20 chars, 1-3 words)', () => {
  const tasks = [card('a', 'doing')];
  // Worker may patch short nickname on own card
  const wp = planTaskMessage({ act: 'task-patch', body: { id: 'a', nickname: 'Short Nickname' }, sender: 'hazel', isBoss: false, tasks, now: 'x' });
  assert.equal(wp.ok, true);
  assert.equal(wp.patch.nickname, 'Short Nickname');

  // Boss may create card with nickname
  const cp = planTaskMessage({ act: 'task-create', body: { title: 'Long task card title here', nickname: 'Task Nick' }, sender: 'god', isBoss: true, tasks: [], now: 'x' });
  assert.equal(cp.ok, true);
  assert.equal(cp.card.nickname, 'Task Nick');

  // Clearing nickname with null
  const clr = planTaskMessage({ act: 'task-patch', body: { id: 'a', nickname: null }, sender: 'hazel', isBoss: false, tasks, now: 'x' });
  assert.equal(clr.ok, true);
  assert.ok('nickname' in clr.patch && clr.patch.nickname === undefined);

  // Rejections: non-string, > 20 chars, > 3 words
  assert.match(
    planTaskMessage({ act: 'task-patch', body: { id: 'a', nickname: 123 }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).reason,
    /nickname must be text/
  );
  assert.match(
    planTaskMessage({ act: 'task-patch', body: { id: 'a', nickname: 'This nickname is far too long to fit' }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).reason,
    /nickname must be at most 20 characters/
  );
  assert.match(
    planTaskMessage({ act: 'task-patch', body: { id: 'a', nickname: 'one two three four' }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).reason,
    /nickname must be at most 3 words/
  );
});

test('card brief: worker may patch brief and briefAppend; Boss may create with brief', () => {
  const tasks = [card('a', 'doing')];
  // Worker patches initial brief
  const p1 = planTaskMessage({ act: 'task-patch', body: { id: 'a', brief: 'Done part 1' }, sender: 'hazel', isBoss: false, tasks, now: 'x' });
  assert.equal(p1.ok, true);
  assert.equal(p1.patch.brief, 'Done part 1');

  // Worker appends to existing brief
  const withBrief = [card('b', 'doing', { brief: 'Done part 1' })];
  const p2 = planTaskMessage({ act: 'task-patch', body: { id: 'b', briefAppend: 'Done part 2' }, sender: 'hazel', isBoss: false, tasks: withBrief, now: 'x' });
  assert.equal(p2.ok, true);
  assert.equal(p2.patch.brief, 'Done part 1\nDone part 2');

  // Boss creates with brief
  const cb = planTaskMessage({ act: 'task-create', body: { title: 'Card', brief: 'Initial brief' }, sender: 'god', isBoss: true, tasks: [], now: 'x' });
  assert.equal(cb.ok, true);
  assert.equal(cb.card.brief, 'Initial brief');

  // Status changes never clear brief
  const p3 = planTaskMessage({ act: 'task-patch', body: { id: 'b', status: 'blocked' }, sender: 'hazel', isBoss: false, tasks: withBrief, now: 'x' });
  assert.equal(p3.ok, true);
  assert.equal('brief' in p3.patch, false, 'status change does not overwrite brief');

  // Rejections: non-string brief, empty briefAppend
  assert.match(
    planTaskMessage({ act: 'task-patch', body: { id: 'a', brief: 123 }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).reason,
    /brief must be text/
  );
  assert.match(
    planTaskMessage({ act: 'task-patch', body: { id: 'a', briefAppend: '   ' }, sender: 'hazel', isBoss: false, tasks, now: 'x' }).reason,
    /briefAppend must be non-empty text/
  );
});

test('moving to awaiting-boss-merge requires a brief; Boss closing card keeps it', () => {
  const noBrief = [card('a', 'doing')];

  // Worker moving to awaiting boss merge without brief is refused
  const r1 = planTaskMessage({
    act: 'task-patch',
    body: { id: 'a', status: 'blocked', notesAppend: 'awaiting boss merge' },
    sender: 'hazel',
    isBoss: false,
    tasks: noBrief,
    now: 'x'
  });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /write the card's "brief" before moving it to awaiting boss merge/);

  // Worker moving to awaiting boss merge with brief in the same patch is accepted
  const ok1 = planTaskMessage({
    act: 'task-patch',
    body: { id: 'a', status: 'blocked', notesAppend: 'awaiting boss merge', brief: 'What was done: tested ok' },
    sender: 'hazel',
    isBoss: false,
    tasks: noBrief,
    now: 'x'
  });
  assert.equal(ok1.ok, true);
  assert.equal(ok1.patch.status, 'blocked');
  assert.equal(ok1.patch.brief, 'What was done: tested ok');

  // Worker moving to awaiting boss merge with existing brief on card is accepted
  const hasBrief = [card('a', 'doing', { brief: 'Already recorded' })];
  const ok2 = planTaskMessage({
    act: 'task-patch',
    body: { id: 'a', status: 'blocked', notesAppend: 'awaiting boss merge' },
    sender: 'hazel',
    isBoss: false,
    tasks: hasBrief,
    now: 'x'
  });
  assert.equal(ok2.ok, true);

  // Worker blocking for other reasons without brief is accepted
  const okBlocked = planTaskMessage({
    act: 'task-patch',
    body: { id: 'a', status: 'blocked', notesAppend: 'BLOCKED: waiting on device' },
    sender: 'hazel',
    isBoss: false,
    tasks: noBrief,
    now: 'x'
  });
  assert.equal(okBlocked.ok, true);

  // Boss closing a card without a brief is accepted
  const bossClose = planTaskMessage({
    act: 'task-patch',
    body: { id: 'a', status: 'done', result: 'merged' },
    sender: 'god',
    isBoss: true,
    tasks: hasBrief,
    now: 'x'
  });
  assert.equal(bossClose.ok, true);
  assert.equal(bossClose.patch.status, 'done');
  assert.equal('brief' in bossClose.patch, false, 'existing brief is kept on card');
});
