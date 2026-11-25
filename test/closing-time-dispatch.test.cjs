'use strict';

/**
 * Closing time on 2026-10-02: the Boss, mid-turn when the human pressed it,
 * created and assigned a card at 16:04:25, broadcast closing time at 16:04:33,
 * Hazel ACKed at 16:04:49, and at 16:04:52 the inbox wake typed "You have new
 * hive inbox message(s)" into Hazel, which started reading the new card.
 * An ACKed worker is no longer woken, an un-ACKed one is woken only for the
 * brief, and no card edit can start a worker while closing time runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
const { WorkerWakeWatchdog, WORKER_WAKE_IDLE_MS } = loadTs('src/main/workerWake.ts');
const { inboxNudgeText, isInboxNudge, isClosingNudge, nudgeForWakeMode } = loadTs('src/shared/hiveNudge.ts');
const { todoNudgeText } = loadTs('src/main/todoNudge.ts');
const { limitResumeText } = loadTs('src/shared/limitHold.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function controller(t) {
  const sent = [];
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: { isGod: true }, hazel: {}, bulba: {} } }),
    send: (message) => sent.push(message)
  };
  const ct = new ClosingTimeController(hive, () => ['god', 'hazel', 'bulba'], () => null, () => {});
  t.after(() => ct.cancel());
  return { ct, sent };
}

const ack = (from) => ({ from, subject: 'CLOSING-TIME-ACK' });

test('wake mode: normal outside closing time, closing until a worker ACKs, skip after', (t) => {
  const { ct } = controller(t);
  assert.equal(ct.wakeMode('hazel'), 'normal');
  ct.start();
  assert.equal(ct.wakeMode('god'), 'closing', 'the Boss collects ACKs, so it is still woken');
  assert.equal(ct.wakeMode('hazel'), 'closing');
  ct.onRouted(ack('hazel'), ['god']);
  assert.equal(ct.isAcked('hazel'), true);
  assert.equal(ct.wakeMode('hazel'), 'skip');
  assert.equal(ct.wakeMode('bulba'), 'closing', 'a worker that has not ACKed must still read the brief');
});

test('wake mode returns to normal after cancel', (t) => {
  const { ct } = controller(t);
  ct.start();
  ct.onRouted(ack('hazel'), ['god']);
  ct.cancel();
  assert.equal(ct.isAcked('hazel'), false);
  assert.equal(ct.wakeMode('hazel'), 'normal');
  assert.equal(ct.wakeMode('god'), 'normal');
});

test('the closing brief tells the Boss not to create or assign cards', (t) => {
  const { ct, sent } = controller(t);
  ct.start();
  assert.match(sent[0].body, /Do not create or assign cards/);
});

function fact(overrides = {}) {
  return {
    agentId: 'hazel', ptyId: 'pty-g', lastOutputAt: 100_000, inboxIds: ['air-trick'],
    autoDeliveryPaused: false, paused: false, halted: false, ...overrides
  };
}
const NOW = 100_000 + WORKER_WAKE_IDLE_MS + 1;

test('watchdog: an ACKed worker is not woken, and its mail is announced after closing time', () => {
  const w = new WorkerWakeWatchdog();
  assert.deepEqual(w.decide([fact({ wakeMode: 'skip' })], NOW), []);
  assert.deepEqual(w.decide([fact({ wakeMode: 'normal' })], NOW + 1), ['hazel'],
    'the skipped beat recorded nothing, so the same mail wakes it once closing time ends');
});

test('watchdog: an un-ACKed worker is woken during closing time, and re-announced as normal work after', () => {
  const w = new WorkerWakeWatchdog();
  assert.deepEqual(w.decide([fact({ wakeMode: 'closing' })], NOW), ['hazel']);
  assert.deepEqual(w.decide([fact({ wakeMode: 'closing' })], NOW + 70_000), [], 'same ids, no repeat');
  assert.deepEqual(w.decide([fact({ wakeMode: 'normal' })], NOW + 140_000), ['hazel'],
    'it was told to leave that mail, so it hears about it again once closing time ends');
  assert.deepEqual(w.decide([fact({ wakeMode: 'normal' })], NOW + 210_000), [], 'and only once');
});

test('closing nudge text: still an inbox nudge, says handle only the brief', () => {
  const worker = inboxNudgeText(['m1'], 'worker', true);
  const boss = inboxNudgeText(['m1'], 'boss', true);
  for (const text of [worker, boss]) {
    assert.equal(isInboxNudge(text), true, 'the queue keeps one pending nudge by this predicate');
    assert.equal(isClosingNudge(text), true);
    assert.match(text, /WRAP UP is in progress/);
    assert.match(text, /m1/);
  }
  assert.match(worker, /handle ONLY that/);
  assert.match(worker, /Do not start, resume or accept any other work or card/);
  assert.match(boss, /Do not create or assign cards/);
  assert.equal(isClosingNudge(inboxNudgeText(['m1'])), false);
});

test('delivery time: a queued nudge follows the wake mode of the moment it is typed', () => {
  const normal = inboxNudgeText(['old']);
  assert.equal(nudgeForWakeMode(normal, 'skip', ['old'], 'worker'), null, 'ACKed: dropped');
  assert.equal(nudgeForWakeMode(normal, 'normal', ['old'], 'worker'), normal);
  const rewritten = nudgeForWakeMode(normal, 'closing', ['brief', 'old'], 'worker');
  assert.equal(isClosingNudge(rewritten), true, 'queued before closing time: rewritten');
  assert.match(rewritten, /brief, old/);
  const closing = inboxNudgeText(['brief'], 'boss', true);
  assert.equal(nudgeForWakeMode(closing, 'closing', ['x'], 'boss'), closing);
  assert.equal(isClosingNudge(nudgeForWakeMode(closing, 'normal', [], 'boss')), false, 'after cancel: ordinary text');
  assert.equal(nudgeForWakeMode('hello', 'skip', [], 'worker'), 'hello', 'other messages pass through');
});

test('delivery time: next-card and limit-resume prompts are dropped during closing time', () => {
  const next = todoNudgeText([{ id: 'jam-sphere-air-trick', status: 'todo', title: 'Air trick' }], '/tmp/outbox');
  const resume = limitResumeText('agy');
  for (const text of [next, resume]) {
    assert.equal(nudgeForWakeMode(text, 'closing', [], 'worker'), null);
    assert.equal(nudgeForWakeMode(text, 'skip', [], 'worker'), null);
    assert.equal(nudgeForWakeMode(text, 'normal', [], 'worker'), text);
  }
});

const cards = [
  { id: 'parked', title: 'P', assignee: 'hazel', status: 'doing' },
  { id: 'open', title: 'O', assignee: 'bulba', status: 'blocked' }
];
const plan = (act, body, isBoss = true, sender = 'god', closingTime = true) =>
  planTaskMessage({ act, body, sender, isBoss, tasks: cards, now: '2026-10-02T21:04:25.000Z', closingTime });

test('dispatch: closing time refuses assigning creates, reassignment and moves to todo/doing', () => {
  for (const p of [
    plan('task-create', { id: 'jam-sphere-air-trick', title: 'Air trick', assignee: 'hazel' }),
    plan('task-patch', { id: 'open', assignee: 'hazel' }),
    plan('task-patch', { id: 'open', status: 'todo' }),
    plan('task-patch', { id: 'open', status: 'doing' }),
    plan('task-patch', { id: 'parked', status: 'todo' }, false, 'hazel')
  ]) {
    assert.equal(p.ok, false);
    assert.match(p.reason, /wrap-up is in progress/);
  }
});

test('dispatch: parking edits still apply during closing time', () => {
  for (const p of [
    plan('task-patch', { id: 'parked', notesAppend: 'parked at step 3', result: 'half done' }, false, 'hazel'),
    plan('task-patch', { id: 'parked', status: 'blocked' }, false, 'hazel'),
    plan('task-patch', { id: 'parked', status: 'done' }),
    plan('task-patch', { id: 'parked', status: 'doing', notesAppend: 'still on it' }, false, 'hazel'),
    plan('task-patch', { id: 'open', assignee: 'bulba', notesAppend: 'unchanged owner' }),
    plan('task-create', { id: 'later', title: 'For after closing' })
  ]) assert.equal(p.ok, true, JSON.stringify(p));
});

test('dispatch: the same edits apply outside closing time', () => {
  assert.equal(plan('task-create', { id: 'n', title: 'N', assignee: 'hazel' }, true, 'god', false).ok, true);
  assert.equal(plan('task-patch', { id: 'open', status: 'todo' }, true, 'god', false).ok, true);
});

test('router: a refused create is mailed back to the sender and logged; a parking patch lands', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-closing-dispatch-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'hazel', name: 'Hazel', provider: 'claude', cwd: home });
  hive.writeTasks([{ id: 'parked', title: 'P', assignee: 'hazel', status: 'doing', dependsOn: [], createdAt: '2026-10-02T21:00:00.000Z' }]);
  let closing = true;
  hive.setClosingTimeSource(() => closing);
  const root = path.join(home, 'hive');
  const send = (agent, msg) => {
    fs.writeFileSync(path.join(root, 'agents', agent, 'outbox', `${Math.random().toString(36).slice(2)}.json`), JSON.stringify(msg), 'utf8');
    return hive.routeOnce();
  };
  const card = (id) => hive.tasks().tasks.find((c) => c.id === id);

  send('god-1', { to: 'harness', act: 'task-create', body: { id: 'jam-sphere-air-trick', title: 'Air trick', assignee: 'hazel' } });
  assert.equal(card('jam-sphere-air-trick'), undefined);
  const [mail] = hive.inbox('god-1');
  assert.match(mail.subject, /task-create refused for jam-sphere-air-trick: wrap-up is in progress/);
  const entry = hive.logTail(500).find((e) => e.kind === 'task-patch' && e.id === 'jam-sphere-air-trick');
  assert.equal(entry.ok, false);
  assert.equal(entry.closingTime, true);

  send('hazel', { to: 'harness', act: 'task-patch', body: { id: 'parked', status: 'blocked', notesAppend: 'parked for closing time' } });
  assert.equal(card('parked').status, 'blocked');

  closing = false;
  send('god-1', { to: 'harness', act: 'task-create', body: { id: 'jam-sphere-air-trick', title: 'Air trick', assignee: 'hazel' } });
  assert.equal(card('jam-sphere-air-trick').assignee, 'hazel', 'dispatch resumes after closing time');
});

test('WRAP-UP-ACK counts the same as the pre-rename CLOSING-TIME-ACK', (t) => {
  const { ct } = controller(t);
  ct.start();
  ct.onRouted({ from: 'hazel', subject: 'WRAP-UP-ACK' }, ['god']);
  ct.onRouted({ from: 'bulba', subject: 'Wrap Up Ack' }, ['god']);
  assert.equal(ct.isAcked('hazel'), true);
  assert.equal(ct.isAcked('bulba'), true);
});
