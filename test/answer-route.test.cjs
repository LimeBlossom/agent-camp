'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { answerNeedsBoss } = loadTs('src/main/answerRoute.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

test('a pick settles the question; a scope or model change also goes to the Boss', () => {
  for (const a of ['B', 'option 2', 'yes, the left one', 'go with the warmer palette']) assert.equal(answerNeedsBoss(a), false, a);
  for (const a of ['B, and also add a trail', 'drop the second map', 'put it on opus', 'do this instead', 'x'.repeat(401)]) assert.equal(answerNeedsBoss(a), true, a.slice(0, 30));
});

async function floor(t, card, extraTasks = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-answer-route-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.writeTasks([{ id: 'c', title: 'Card', assignee: 'w1', status: 'blocked', dependsOn: [], createdAt: '2026-11-06T00:00:00Z', humanQA: [{ q: 'A or B?', a: 'B', answeredAt: 'x' }], ...card }, ...extraTasks]);
  const status = () => hive.tasks().tasks.find((x) => x.id === 'c').status;
  return { hive, status };
}

test('a plain answer unblocks the card and mails only the assignee', async (t) => {
  const { hive, status } = await floor(t, {});
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: 'w1', boss: false });
  assert.equal(status(), 'todo');
  const mail = hive.inbox('w1');
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /A: B/);
  assert.equal(hive.inbox('god-1').length, 0, 'the Boss is not woken');
  assert.ok(hive.tasks().tasks.find((x) => x.id === 'c').sendBacks >= 1, 'send-back bookkeeping still runs');
});

test('an answer preserves dependency block when dependsOn is incomplete while still delivering to assignee', async (t) => {
  const dep = { id: 'dep-1', title: 'Prereq', status: 'todo', assignee: 'w1', dependsOn: [], createdAt: '2026-11-06T00:00:00Z' };
  const { hive, status } = await floor(t, { dependsOn: ['dep-1'] }, [dep]);
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: 'w1', boss: false });
  assert.equal(status(), 'blocked', 'incomplete dependsOn must keep card blocked');
  const mail = hive.inbox('w1');
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /A: B/);
  assert.equal(hive.inbox('god-1').length, 0, 'the Boss is not woken');
  assert.ok(hive.tasks().tasks.find((x) => x.id === 'c').sendBacks >= 1, 'send-back bookkeeping still runs');
});

test('a scope change mails the assignee and the Boss', async (t) => {
  const { hive, status } = await floor(t, {});
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B, and drop the second map'), { assignee: 'w1', boss: true });
  assert.equal(status(), 'todo');
  assert.equal(hive.inbox('w1').length, 1);
  assert.match(hive.inbox('god-1')[0].body, /scope or model change/);
});

test('an approval or a card with no live worker goes to the Boss untouched', async (t) => {
  const { hive, status } = await floor(t, {});
  assert.deepEqual(hive.routeHumanAnswer('c', 'Ship?', 'approved'), { assignee: null, boss: true });
  assert.equal(status(), 'blocked', 'the Boss merges; the card is not reopened');
  assert.equal(hive.inbox('w1').length, 0);
  const g = await floor(t, { assignee: 'god-1' });
  assert.deepEqual(g.hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: null, boss: true });
  assert.equal(g.status(), 'blocked');
});

test('a backlogged card is not reopened; the Boss gets it', async (t) => {
  const { hive, status } = await floor(t, { backloggedAt: '2026-11-01T00:00:00Z' });
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: null, boss: true });
  assert.equal(status(), 'blocked');
});
