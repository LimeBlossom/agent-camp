'use strict';

/**
 * A human answer must not interrupt an agent that is busy on another card. The harness holds it
 * (card stays blocked, heldAnswer set, Boss mailed) until the assignee is free, then delivers it
 * to a fresh session. Contract for the implementer:
 *   - card.heldAnswer = { for: <assignee>, since: <iso>, ... }
 *   - hive.setFreshStartHook(cb(agentId, cardId)): called when a card is delivered to an agent whose
 *     session is live but idle, so main can end it through the checkpoint/handoff path and start a
 *     fresh one. A dormant agent needs no hook call: the existing wake path starts it fresh.
 *   - release triggers: the assignee's doing card leaves doing (task-patch via outbox), or
 *     setDormancy marks it dormant. Log kind 'human-answer-released'.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const BASE = { dependsOn: [], createdAt: '2026-11-06T00:00:00Z' };

async function floor(t, { live = ['w1'], cards = {}, extra = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-answer-hold-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  const state = { live };
  hive.setLiveAgentSource(() => state.live);
  const fresh = [];
  if (typeof hive.setFreshStartHook === 'function') hive.setFreshStartHook((agentId, cardId) => { fresh.push([agentId, cardId]); });
  hive.writeTasks([
    { id: 'c', title: 'Card', assignee: 'w1', status: 'blocked', ...BASE, humanQA: [{ q: 'A or B?', a: 'B', answeredAt: 'x' }], ...cards },
    { id: 'other', title: 'Other', assignee: 'w1', status: 'doing', ...BASE },
    ...extra
  ]);
  const card = (id) => hive.tasks().tasks.find((x) => x.id === id);
  const send = (agent, msg) => {
    fs.writeFileSync(path.join(home, 'hive', 'agents', agent, 'outbox', `${Math.random().toString(36).slice(2)}.json`), JSON.stringify(msg), 'utf8');
    return hive.routeOnce();
  };
  const logs = (kind) => hive.logTail(500).filter((e) => e.kind === kind);
  return { hive, state, fresh, card, send, logs };
}

const patchOther = (send, status) => send('w1', { to: 'harness', act: 'task-patch', body: { id: 'other', status, notesAppend: 'x' } });

test('0: HiveManager exposes setFreshStartHook', async (t) => {
  const { hive } = await floor(t);
  assert.equal(typeof hive.setFreshStartHook, 'function');
});

test('1: answer for a busy assignee is held, not delivered; the Boss gets it with the note', async (t) => {
  const { hive, card, fresh } = await floor(t);
  const r = hive.routeHumanAnswer('c', 'A or B?', 'B');
  assert.equal(r.boss, true);
  assert.equal(r.assignee, null);
  assert.equal(card('c').status, 'blocked', 'card is not set todo');
  assert.equal(card('c').heldAnswer.for, 'w1');
  assert.ok(card('c').heldAnswer.since);
  assert.match(String(card('c').notes), /answer held: w1 busy on other/);
  assert.equal(hive.inbox('w1').length, 0, 'the busy agent is not mailed');
  assert.equal(fresh.length, 0);
  const boss = hive.inbox('god-1');
  assert.equal(boss.length, 1);
  assert.match(boss[0].body, /B/);
  assert.match(boss[0].body, /held/i);
});

test('1b: live with only a todo card, or a doing card of another agent, is not busy', async (t) => {
  const f = await floor(t, { extra: [] });
  f.hive.writeTasks([
    { id: 'c', title: 'Card', assignee: 'w1', status: 'blocked', ...BASE, humanQA: [{ q: 'A or B?', a: 'B', answeredAt: 'x' }] },
    { id: 'other', title: 'Other', assignee: 'w1', status: 'todo', ...BASE },
    { id: 'theirs', title: 'Theirs', assignee: 'god-1', status: 'doing', ...BASE }
  ]);
  assert.deepEqual(f.hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: 'w1', boss: false });
  assert.equal(f.card('c').heldAnswer, undefined);
});

test('2: a dormant assignee gets the card todo and the mail; no session-end hook is needed', async (t) => {
  const { hive, card, fresh, logs } = await floor(t, { live: [] });
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: 'w1', boss: false });
  assert.equal(card('c').status, 'todo');
  assert.equal(card('c').heldAnswer, undefined);
  assert.equal(hive.inbox('w1').length, 1);
  assert.deepEqual(fresh, []);
  assert.equal(logs('human-answer-routed').length, 1);
});

test('2b: a live idle assignee is handed to the fresh-start hook once, with the card todo', async (t) => {
  const { hive, card, fresh } = await floor(t, { cards: {}, extra: [] });
  hive.writeTasks([{ id: 'c', title: 'Card', assignee: 'w1', status: 'blocked', ...BASE, humanQA: [{ q: 'A or B?', a: 'B', answeredAt: 'x' }] }]);
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: 'w1', boss: false });
  assert.equal(card('c').status, 'todo');
  assert.deepEqual(fresh, [['w1', 'c']]);
  assert.equal(hive.inbox('w1').length, 1);
});

test('3: finishing the doing card (blocked) releases the held answer to a fresh session', async (t) => {
  const { hive, send, card, fresh, logs } = await floor(t);
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  patchOther(send, 'blocked');
  assert.equal(card('c').status, 'todo');
  assert.equal(card('c').heldAnswer, undefined);
  assert.deepEqual(fresh, [['w1', 'c']]);
  const mail = hive.inbox('w1');
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /A: B/);
  const rel = logs('human-answer-released');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].id, 'c');
});

test('3b: the agent going dormant releases the held answer with no hook call', async (t) => {
  const { hive, state, card, fresh, logs } = await floor(t);
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  state.live = [];
  hive.setDormancy({ dormant: ['w1'], archived: [] });
  assert.equal(card('c').status, 'todo');
  assert.equal(card('c').heldAnswer, undefined);
  assert.deepEqual(fresh, []);
  assert.equal(hive.inbox('w1').length, 1);
  assert.equal(logs('human-answer-released').length, 1);
});

test('3c: a patch that leaves the card in doing releases nothing', async (t) => {
  const { hive, send, card, logs } = await floor(t);
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  send('w1', { to: 'harness', act: 'task-patch', body: { id: 'other', notesAppend: 'still going' } });
  assert.equal(card('c').status, 'blocked');
  assert.ok(card('c').heldAnswer);
  assert.equal(logs('human-answer-released').length, 0);
});

test('3d: with two held answers the oldest is released first, one per free event', async (t) => {
  const second = { id: 'c2', title: 'Card2', assignee: 'w1', status: 'blocked', ...BASE, humanQA: [{ q: 'A or B?', a: 'B', answeredAt: 'x' }] };
  const { hive, send, card, fresh } = await floor(t, { extra: [second] });
  hive.routeHumanAnswer('c2', 'A or B?', 'B');
  await new Promise((r) => setTimeout(r, 5));
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  // Only the Boss sets a card done; a worker's own done patch is refused by the planner.
  send('god-1', { to: 'harness', act: 'task-patch', body: { id: 'other', status: 'done' } });
  assert.equal(card('c2').status, 'todo', 'oldest hold goes first');
  assert.equal(card('c').status, 'blocked', 'the agent now has work, so the next hold waits');
  assert.ok(card('c').heldAnswer);
  assert.deepEqual(fresh, [['w1', 'c2']]);
});

test('4: an approval for a busy assignee still goes to the Boss untouched, not held', async (t) => {
  const { hive, card } = await floor(t);
  assert.deepEqual(hive.routeHumanAnswer('c', 'Ship?', 'approved'), { assignee: null, boss: true });
  assert.equal(card('c').status, 'blocked');
  assert.equal(card('c').heldAnswer, undefined);
});

test('4b: a card assigned to the Boss is routed to the Boss as before, never held', async (t) => {
  const { hive, card } = await floor(t, { cards: { assignee: 'god-1' } });
  assert.deepEqual(hive.routeHumanAnswer('c', 'A or B?', 'B'), { assignee: null, boss: true });
  assert.equal(card('c').heldAnswer, undefined);
});

test('5: the Boss releases a held answer early with task-patch status todo; the hold clears', async (t) => {
  const { hive, send, card } = await floor(t);
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  assert.ok(card('c').heldAnswer);
  send('god-1', { to: 'harness', act: 'task-patch', body: { id: 'c', status: 'todo', notesAppend: 'released early' } });
  assert.equal(card('c').status, 'todo');
  assert.equal(card('c').heldAnswer, undefined);
});

test('5b: a worker cannot clear a hold on its own card', async (t) => {
  const { hive, send, card } = await floor(t);
  hive.routeHumanAnswer('c', 'A or B?', 'B');
  send('w1', { to: 'harness', act: 'task-patch', body: { id: 'c', status: 'todo' } });
  assert.ok(card('c').heldAnswer, 'hold survives a worker status edit');
  assert.equal(card('c').status, 'blocked');
});
