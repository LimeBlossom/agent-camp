'use strict';

/**
 * Next-card nudge: a worker whose turn ends (Stop) with todo/doing cards is told
 * once to start the next one; the same unchanged set after that is reported to
 * the Boss once. A fake scheduler stands in for setTimeout.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { TodoNudger, openCards, cardSetKey, todoNudgeText, todoNudgeEligible, ignoredTodoNudgeBody, closingTimeParkable } = loadTs('src/main/todoNudge.ts');

function fakeScheduler() {
  let seq = 0;
  const pending = new Map();
  return {
    scheduler: {
      set: (fn) => { const h = ++seq; pending.set(h, fn); return h; },
      clear: (h) => { pending.delete(h); }
    },
    flush() {
      for (const [h, fn] of [...pending]) { pending.delete(h); fn(); }
    },
    size: () => pending.size
  };
}

const card = (id, status = 'todo', extra = {}) => ({ id, title: `Title ${id}`, assignee: 'bulba', status, ...extra });

/** `state` is what facts() reports; `ledger` is the whole tasks.json list. */
function harness({ eligible = true, hasMail = false, ledger = [card('a'), card('b')] } = {}) {
  const clock = fakeScheduler();
  const state = { eligible, hasMail, ledger };
  const nudges = [];
  const ignored = [];
  const nudger = new TodoNudger({
    facts: (id) => ({
      eligible: state.eligible,
      hasMail: state.hasMail,
      cards: openCards(id, state.ledger),
      ...(state.hasWork !== undefined ? { hasWork: state.hasWork } : {}),
      ...(state.lastWorkAt !== undefined ? { lastWorkAt: state.lastWorkAt } : {})
    }),
    nudge: (id, cards) => { nudges.push({ id, cards: cards.map((c) => c.id) }); return true; },
    ignored: (id, cards) => { ignored.push({ id, cards: cards.map((c) => c.id) }); },
    scheduler: clock.scheduler
  });
  const stop = () => { nudger.noteHook('bulba', 'Stop'); clock.flush(); };
  return { clock, state, nudges, ignored, nudger, stop };
}

test('Stop with todo cards nudges once, naming the cards', () => {
  const h = harness();
  h.stop();
  assert.deepEqual(h.nudges, [{ id: 'bulba', cards: ['a', 'b'] }]);
  assert.deepEqual(h.ignored, []);
});

test('no nudge while unread mail is pending; the inbox nudge owns that turn', () => {
  const h = harness({ hasMail: true });
  h.stop();
  assert.deepEqual(h.nudges, []);
  h.state.hasMail = false;
  h.stop();
  assert.equal(h.nudges.length, 1, 'mail drained: the next Stop nudges');
});

test('no nudge when the agent is not eligible', () => {
  const h = harness({ eligible: false });
  h.stop();
  h.stop();
  assert.deepEqual(h.nudges, []);
  assert.deepEqual(h.ignored, []);
});

test('eligibility excludes the Boss, limit holds, closing time, holds and pauses', () => {
  const ok = { hiveEnabled: true, closingTime: false, hasPty: true, registered: true, isBoss: false, limitHeld: false };
  assert.equal(todoNudgeEligible(ok), true);
  assert.equal(todoNudgeEligible({ ...ok, isBoss: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, limitHeld: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, closingTime: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, onHold: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, isAssistant: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, paused: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, halted: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, autoDeliveryPaused: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, hasPty: false }), false);
  assert.equal(todoNudgeEligible({ ...ok, archived: true }), false);
  assert.equal(todoNudgeEligible({ ...ok, hiveEnabled: false }), false);
});

test('unchanged set after a nudge: no second nudge, one ignored report, then silence', () => {
  const h = harness();
  h.stop();
  h.stop();
  h.stop();
  h.stop();
  assert.equal(h.nudges.length, 1);
  assert.deepEqual(h.ignored, [{ id: 'bulba', cards: ['a', 'b'] }]);
});

test('a changed card set re-arms the nudge and the ignored report', () => {
  const h = harness();
  h.stop();
  h.stop();
  assert.equal(h.ignored.length, 1);
  h.state.ledger = [card('a', 'blocked', { notes: 'waiting on the human' }), card('b')];
  h.stop();
  assert.deepEqual(h.nudges.map((n) => n.cards), [['a', 'b'], ['b']]);
  h.stop();
  assert.equal(h.ignored.length, 2, 'the new set can be reported once too');
});

test('a notes edit, a new humanQA entry or a status change counts as a change', () => {
  const base = [card('a')];
  assert.notEqual(cardSetKey(base), cardSetKey([card('a', 'todo', { notes: 'x' })]));
  assert.notEqual(cardSetKey(base), cardSetKey([card('a', 'todo', { humanQA: [{ q: '?' }] })]));
  assert.notEqual(cardSetKey(base), cardSetKey([card('a', 'doing')]));
  assert.equal(cardSetKey([card('a'), card('b')]), cardSetKey([card('b'), card('a')]));
});

test('running out of cards clears the guard, so a later identical set nudges again', () => {
  const h = harness();
  h.stop();
  const cards = h.state.ledger;
  h.state.ledger = [];
  h.stop();
  h.state.ledger = cards;
  h.stop();
  assert.equal(h.nudges.length, 2);
  assert.deepEqual(h.ignored, []);
});

test('a turn hook or terminal input before the check cancels it', () => {
  const h = harness();
  h.nudger.noteHook('bulba', 'Stop');
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  h.clock.flush();
  h.nudger.noteHook('bulba', 'Stop');
  h.nudger.noteInput('bulba', 'hi');
  h.clock.flush();
  assert.deepEqual(h.nudges, []);
  h.nudger.noteHook('bulba', 'Stop');
  h.nudger.noteInput('bulba', '\x1b[I');
  h.clock.flush();
  assert.equal(h.nudges.length, 1, 'a focus report is not input');
});

test('a failed delivery is not remembered, so the next Stop tries again', () => {
  const clock = fakeScheduler();
  let ok = false;
  const sent = [];
  const nudger = new TodoNudger({
    facts: () => ({ eligible: true, hasMail: false, cards: [card('a')] }),
    nudge: (id) => { sent.push(id); return ok; },
    ignored: () => assert.fail('not ignored: it was never delivered'),
    scheduler: clock.scheduler
  });
  nudger.noteHook('bulba', 'Stop'); clock.flush();
  ok = true;
  nudger.noteHook('bulba', 'Stop'); clock.flush();
  assert.equal(sent.length, 2);
});

test('forget() on a new session resets the guard', () => {
  const h = harness();
  h.stop();
  h.nudger.forget('bulba');
  h.stop();
  assert.equal(h.nudges.length, 2);
  assert.deepEqual(h.ignored, []);
});

test('order: doing first, then priority, then oldest; other agents and statuses excluded', () => {
  const ledger = [
    card('old-low', 'todo', { priority: 'low', createdAt: '2026-10-01T00:00:00Z' }),
    card('new-none', 'todo', { createdAt: '2026-10-02T08:00:00Z' }),
    card('old-none', 'todo', { createdAt: '2026-10-02T07:00:00Z' }),
    card('high', 'todo', { priority: 'high', createdAt: '2026-10-02T09:00:00Z' }),
    card('live', 'doing', { priority: 'low' }),
    card('stuck', 'blocked'),
    card('finished', 'done'),
    { ...card('theirs'), assignee: 'pine' }
  ];
  assert.deepEqual(openCards('bulba', ledger).map((c) => c.id), ['live', 'high', 'old-none', 'new-none', 'old-low']);
});

test('nudge text names the cards and tells the worker to block through a task-patch, not a tasks.json write', () => {
  const text = todoNudgeText([card('jam-sphere-imago-devkit', 'todo', { title: 'Imago devkit' }), card('jam-sphere-pause-volume')], '/hive/agents/bulba/outbox');
  assert.match(text, /`jam-sphere-imago-devkit` \(todo\): Imago devkit/);
  assert.match(text, /`jam-sphere-pause-volume` \(todo\)/);
  assert.match(text, /Start the first one now/);
  assert.match(text, /set its status to "blocked" with a one-line reason/);
  assert.match(text, /message boss/);
  assert.match(text, /end your turn: each card starts in its own fresh session/);
  assert.match(text, /tasks\.json is read-only for agents/);
  assert.match(text, /into \/hive\/agents\/bulba\/outbox/);
  assert.match(text, /"act":"task-patch","body":\{"id":"<id>","status":"blocked","notesAppend":"BLOCKED: <reason>"\}/);
  assert.doesNotMatch(text, /\bjq\b|\bmv\b|> "\$F|tasks\.json"/);
});

/** A harness whose facts allow a close, recording closes apart from nudges. */
function closeHarness({ canClose = true, closeOk = true, hasMail = false, ledger = [card('a'), card('b')] } = {}) {
  const clock = fakeScheduler();
  const state = { canClose, closeOk, hasMail, eligible: true, ledger };
  const nudges = [];
  const closes = [];
  const nudger = new TodoNudger({
    facts: (id) => ({ eligible: state.eligible, hasMail: state.hasMail, canClose: state.canClose, cards: openCards(id, state.ledger), finishedCards: state.ledger.filter(c => c.assignee === id), memoryUpdated: state.memoryUpdated }),
    nudge: (id, cards) => { nudges.push(cards.map((c) => c.id)); return true; },
    ignored: () => {},
    close: (id, cards) => { closes.push(cards.map((c) => c.id)); return state.closeOk; },
    scheduler: clock.scheduler
  });
  const stop = () => { nudger.noteHook('bulba', 'Stop'); clock.flush(); };
  return { clock, state, nudges, closes, nudger, stop };
}

test('finishing a card the session started for, with a todo card left, closes for the next one', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  h.state.ledger = [card('a', 'done'), card('b')];
  h.stop();
  assert.deepEqual(h.closes, [['b']]);
  assert.deepEqual(h.nudges, []);
});

test('finishing the last card keeps the session up', () => {
  const h = closeHarness({ ledger: [card('a')] });
  h.nudger.begin('bulba', ['a']);
  h.state.ledger = [card('a', 'done')];
  h.stop();
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, []);
  assert.deepEqual(h.nudges, []);
});

test('a card set to blocked or handed to someone else also moves the agent on', () => {
  const blocked = closeHarness();
  blocked.nudger.begin('bulba', ['a', 'b']);
  blocked.state.ledger = [card('a', 'blocked'), card('b')];
  blocked.stop();
  assert.equal(blocked.closes.length, 1);
  const moved = closeHarness();
  moved.nudger.begin('bulba', ['a', 'b']);
  moved.state.ledger = [{ ...card('a'), assignee: 'pine' }, card('b')];
  moved.stop();
  assert.equal(moved.closes.length, 1);
});

test('a fresh session that has not touched its cards is nudged, never closed, so a wake cannot loop', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  h.stop();
  h.stop();
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, []);
  assert.equal(h.nudges.length, 1);
});

test('a "doing" card the session worked keeps the session: it is work in progress', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  assert.equal(h.nudger.mayWork('bulba', 'b', h.state.ledger), true, 'started for b, a still open');
  h.state.ledger = [card('a', 'done'), card('b', 'doing'), card('c')];
  h.stop();
  assert.deepEqual(h.closes, []);
  assert.equal(h.nudges.length, 1);
});

test('a card someone else set to "doing" starts fresh like a todo card', () => {
  const h = closeHarness({ ledger: [card('a')] });
  h.nudger.begin('bulba', ['a']);
  h.state.ledger = [card('a', 'done')];
  h.stop();
  h.state.ledger = [card('a', 'done'), card('c', 'doing')];
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [['c']], 'the Boss revived a parked card straight to doing');
});

test('a card the session was begun on as doing counts as its own', () => {
  const h = closeHarness({ ledger: [card('a', 'doing'), card('b')] });
  h.nudger.begin('bulba', ['a', 'b'], ['a']);
  h.stop();
  assert.deepEqual(h.closes, []);
});

test('mayWork: a worker cannot chain onto a card its session was not started for', () => {
  const h = closeHarness({ ledger: [card('a')] });
  h.nudger.begin('bulba', ['a']);
  assert.equal(h.nudger.mayWork('bulba', 'a', [card('a')]), true);
  assert.equal(h.nudger.mayWork('bulba', 'c', [card('a'), card('c')]), false, 'a new card mid-session');
  assert.equal(h.nudger.mayWork('bulba', 'a', [card('c')]), true, 'rework on a card it worked, after it left the open set');
});

test('mayWork: once a card it was started for leaves, the other start cards need a fresh session too', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  assert.equal(h.nudger.mayWork('bulba', 'a', [card('a'), card('b')]), true);
  assert.equal(h.nudger.mayWork('bulba', 'b', [card('b')]), false, 'a is done: b is its own card');
  h.state.ledger = [card('a', 'done'), card('b')];
  h.stop();
  assert.deepEqual(h.closes, [['b']]);
});

test('mayWork: a session never begun is not gated', () => {
  const h = closeHarness();
  h.stop();
  assert.equal(h.nudger.mayWork('bulba', 'z', [card('z')]), true);
});

test('mail arriving in the seconds after a Stop is still held for a new card', () => {
  const h = closeHarness({ ledger: [card('a')] });
  h.nudger.begin('bulba', ['a']);
  h.state.ledger = [card('a', 'blocked'), card('c')];
  h.nudger.noteHook('bulba', 'Stop');
  assert.equal(h.clock.size(), 1, 'the post-Stop check is still pending');
  assert.equal(h.nudger.holdMail('bulba'), true);
  assert.deepEqual(h.closes, [['c']]);
});

test('no close for a worker that may not be closed or is not eligible; a refused close falls back to the nudge', () => {
  const pinned = closeHarness({ canClose: false });
  pinned.nudger.begin('bulba', ['a', 'b']);
  pinned.state.ledger = [card('a', 'done'), card('b')];
  pinned.stop();
  assert.deepEqual(pinned.closes, []);
  assert.deepEqual(pinned.nudges, [['b']]);
  const held = closeHarness();
  held.nudger.begin('bulba', ['a', 'b']);
  held.state.ledger = [card('a', 'done'), card('b')];
  held.state.eligible = false;
  held.stop();
  assert.deepEqual(held.closes, []);
  const refused = closeHarness({ closeOk: false });
  refused.nudger.begin('bulba', ['a', 'b']);
  refused.state.ledger = [card('a', 'done'), card('b')];
  refused.stop();
  assert.equal(refused.closes.length, 1);
  assert.deepEqual(refused.nudges, [['b']]);
});

test('unread mail does not hold back a close: the fresh start lists the mail', () => {
  const h = closeHarness({ hasMail: true });
  h.nudger.begin('bulba', ['a', 'b']);
  h.state.ledger = [card('a', 'done'), card('b')];
  h.stop();
  assert.equal(h.closes.length, 1);
});

test('a new card assigned to an idle worker closes it for that card, without waiting for a Stop', () => {
  const h = closeHarness({ ledger: [] });
  h.nudger.begin('bulba', []);
  h.stop();
  assert.deepEqual(h.closes, []);
  h.state.ledger = [card('c')];
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [['c']]);
  assert.deepEqual(h.nudges, [], 'the idle re-check only ever closes');
});

test('a new card while the worker is mid-turn waits for its Stop', () => {
  const h = closeHarness({ ledger: [] });
  h.nudger.begin('bulba', []);
  h.stop();
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  h.state.ledger = [card('c')];
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, []);
  h.nudger.noteHook('bulba', 'PreToolUse');
  h.nudger.noteInput('bulba', 'x');
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, []);
  h.stop();
  assert.deepEqual(h.closes, [['c']]);
});

test('a worker that never ended a turn is not idle, so a card change alone does not close it', () => {
  const h = closeHarness({ ledger: [] });
  h.nudger.begin('bulba', []);
  h.state.ledger = [card('c')];
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, []);
});

test('after a close the agent is no longer idle, and begin() on the fresh session starts over', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  h.state.ledger = [card('a', 'done'), card('b')];
  h.stop();
  h.nudger.cardsChanged();
  assert.equal(h.closes.length, 1, 'no second close from the re-check');
  h.nudger.begin('bulba', ['b']);
  h.stop();
  assert.equal(h.closes.length, 1);
  assert.deepEqual(h.nudges, [['b']]);
});

test('a proposed close stands until the agent does anything, and a refused one can be proposed again', () => {
  const h = closeHarness();
  h.nudger.begin('bulba', ['a', 'b']);
  h.state.ledger = [card('a', 'done'), card('b')];
  h.stop();
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.noteInput('bulba', 'typed');
  assert.equal(h.nudger.closeStands('bulba'), false, 'input withdraws it');
  h.stop();
  assert.equal(h.closes.length, 2, 'the next Stop proposes it again');
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  assert.equal(h.nudger.closeStands('bulba'), false, 'a turn withdraws it');
});

function retryHarness() {
  const clock = fakeScheduler();
  const state = { eligible: true, canClose: true, hasMail: false, deliveryAvailable: true, cards: [card('new')] };
  const closes = [], nudges = [], refusals = [], delays = [], reports = [];
  const nudger = new TodoNudger({
    facts: () => state,
    scheduler: { ...clock.scheduler, set: (fn, ms) => { delays.push(ms); return clock.scheduler.set(fn, ms); } },
    close: (id) => { closes.push(id); return true; },
    nudge: (id) => { nudges.push(id); return state.deliveryAvailable; },
    ignored: (id) => { reports.push(id); },
    refused: (id, reason) => refusals.push(reason)
  });
  nudger.begin('bulba', []);
  nudger.noteHook('bulba', 'Stop');
  clock.flush();
  return { clock, state, nudger, closes, nudges, refusals, delays, reports };
}

test('refusal releases close, retries after a minute, then reminds once', () => {
  const h = retryHarness();
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.closeRefused('bulba', 'draft');
  assert.equal(h.nudger.closeStands('bulba'), false);
  assert.equal(h.delays.at(-1), 60000);
  h.nudger.cardsChanged();
  assert.equal(h.closes.length, 1, 'task changes cannot bypass the retry delay');
  h.clock.flush();
  assert.equal(h.closes.length, 2);
  h.nudger.closeRefused('bulba', 'draft');
  assert.deepEqual(h.nudges, ['bulba']);
  assert.deepEqual(h.refusals, ['draft', 'draft']);
  h.nudger.cardsChanged();
  assert.equal(h.nudges.length, 1);
  h.state.cards = [card('another')];
  h.nudger.cardsChanged();
  assert.equal(h.closes.length, 3, 'new cards receive their own close attempts');
});

test('unanswered proposals time out rather than leaving a permanent pending close', () => {
  const h = retryHarness();
  h.clock.flush();
  assert.deepEqual(h.refusals, ['renderer-timeout']);
  assert.equal(h.nudger.closeStands('bulba'), false);
  h.clock.flush();
  assert.equal(h.closes.length, 2);
  h.clock.flush();
  assert.equal(h.nudges.length, 1);
});

test('a turn or hold prevents a retry from interrupting work', () => {
  const h = retryHarness();
  h.nudger.closeRefused('bulba', 'queued-message');
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  h.clock.flush();
  assert.equal(h.closes.length, 1);
  assert.equal(h.nudges.length, 0);
  const held = retryHarness();
  held.nudger.closeRefused('bulba', 'draft');
  held.state.eligible = false;
  held.clock.flush();
  assert.equal(held.closes.length, 1);
});

test('terminal protocol replies leave idle workers eligible for card changes', () => {
  const h = retryHarness();
  h.nudger.noteInput('bulba', '\x1b]11;rgb:0000/0000/0000\x1b\\');
  h.nudger.noteInput('bulba', '\x1b[?997;2n');
  h.nudger.noteInput('bulba', '\x1b[24;80R');
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.noteInput('bulba', 'hello');
  assert.equal(h.nudger.closeStands('bulba'), false);
  assert.deepEqual(h.refusals, ['agent-activity']);
  assert.equal(h.nudges.length, 0);
});

const boundary = (type, timestamp) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } });
test('Codex completion restores idle after a missed Stop, but never overrides newer input', () => {
  const h = harness({ ledger: [] });
  h.nudger.begin('bulba', []);
  const time = Date.now() + 1000;
  const complete = boundary('task_complete', new Date(time).toISOString());
  h.state.ledger = [card('a')];
  h.nudger.noteSession('bulba', 'partial JSON\n' + complete);
  h.clock.flush();
  assert.equal(h.nudges.length, 1);
  h.nudger.noteInput('bulba', 'typing');
  h.nudger.noteSession('bulba', complete);
  assert.equal(h.clock.size(), 0, 'same completion cannot re-arm idle');
  const busy = harness();
  busy.nudger.noteInput('bulba', 'typing');
  busy.nudger.noteSession('bulba', boundary('task_complete', new Date(Date.now() - 10000).toISOString()));
  assert.equal(busy.clock.size(), 0, 'old completion cannot override new input');
  const active = harness();
  active.nudger.noteSession('bulba', complete + '\n' + boundary('task_started', new Date(time + 1000).toISOString()));
  assert.equal(active.clock.size(), 0, 'latest turn is running');
});

test('card edits after a reminder do not report it ignored before the next turn ends', () => {
  const h = retryHarness();
  h.nudger.closeRefused('bulba', 'draft');
  h.clock.flush();
  h.nudger.closeRefused('bulba', 'draft');
  h.nudger.cardsChanged();
  assert.equal(h.reports.length, 0);
  h.nudger.noteHook('bulba', 'Stop');
  h.clock.flush();
  assert.equal(h.reports.length, 1);
});

test('failed reminder delivery retries while idle and stops after successful delivery', () => {
  const h = retryHarness();
  h.nudger.closeRefused('bulba', 'draft');
  h.clock.flush();
  h.state.deliveryAvailable = false;
  h.nudger.closeRefused('bulba', 'draft');
  assert.equal(h.clock.size(), 1);
  h.state.deliveryAvailable = true;
  h.clock.flush();
  assert.equal(h.nudges.length, 2);
  assert.equal(h.clock.size(), 0);
});

test('mail for an idle agent with a new card is held while it closes for that card', () => {
  const h = closeHarness({ ledger: [card('a')] });
  h.nudger.begin('bulba', ['a']);
  h.state.ledger = [card('a', 'blocked')];
  h.stop();
  assert.deepEqual(h.closes, [], 'no open card left: the session stays up');
  h.state.ledger = [card('a', 'blocked'), card('c')];
  assert.equal(h.nudger.holdMail('bulba'), true, 'the Boss assigned a card and mailed it in the same breath');
  assert.deepEqual(h.closes, [['c']]);
  assert.equal(h.nudger.holdMail('bulba'), true, 'held until the close lands');
});

test('mail is not held for a busy agent or one with nothing new', () => {
  const busy = closeHarness();
  busy.nudger.begin('bulba', ['a', 'b']);
  busy.state.ledger = [card('a', 'done'), card('b')];
  assert.equal(busy.nudger.holdMail('bulba'), false, 'mid-turn: no close, mail goes through');
  const fresh = closeHarness();
  fresh.nudger.begin('bulba', ['a', 'b']);
  fresh.stop();
  assert.equal(fresh.nudger.holdMail('bulba'), false, 'cards it was started for: mail goes through');
  assert.deepEqual(fresh.closes, []);
});

test('doing card with unchanged key -> no report', () => {
  const h = harness({ ledger: [card('a', 'doing')] });
  h.stop();
  assert.equal(h.nudges.length, 1, 'nudge sent initially to continue doing card');
  h.stop();
  assert.deepEqual(h.ignored, [], 'doing card with unchanged key never reports ignored');
  h.stop();
  assert.deepEqual(h.ignored, []);
});

test('doing card alongside todo card with unchanged key -> no report', () => {
  const h = harness({ ledger: [card('a', 'doing'), card('b', 'todo')] });
  h.stop();
  assert.equal(h.nudges.length, 1);
  h.stop();
  assert.deepEqual(h.ignored, [], 'active doing card suppresses ignored report for todo cards');
});

test('todo card, agent sent outbox/patch -> no report', () => {
  const h = harness({ ledger: [card('a', 'todo')] });
  h.stop();
  assert.equal(h.nudges.length, 1);
  assert.deepEqual(h.ignored, []);
  h.nudger.noteWork('bulba');
  h.stop();
  assert.deepEqual(h.ignored, [], 'work activity since nudge prevents ignored report');
});

test('todo card, agent sent outbox/patch reflected in facts -> no report', () => {
  const h = harness({ ledger: [card('a', 'todo')] });
  h.stop();
  assert.equal(h.nudges.length, 1);
  h.state.hasWork = true;
  h.stop();
  assert.deepEqual(h.ignored, [], 'facts hasWork prevents ignored report');
});

test('todo card, agent had tool activity -> no report', () => {
  const h = harness({ ledger: [card('a', 'todo')] });
  h.stop();
  assert.equal(h.nudges.length, 1);
  h.nudger.noteHook('bulba', 'PreToolUse');
  h.stop();
  assert.deepEqual(h.ignored, [], 'tool hook activity since nudge prevents ignored report');
});

test('todo card, no activity across two Stops -> one report', () => {
  const h = harness({ ledger: [card('a', 'todo')] });
  h.stop();
  assert.equal(h.nudges.length, 1);
  assert.deepEqual(h.ignored, []);
  h.stop();
  assert.equal(h.ignored.length, 1);
  assert.deepEqual(h.ignored, [{ id: 'bulba', cards: ['a'] }]);
  h.stop();
  assert.equal(h.ignored.length, 1, 'reported once only');
});

test('alert body states each card real status instead of always todo', () => {
  const body = ignoredTodoNudgeBody('Bulba', 'bulba', [
    card('task-1', 'todo'),
    card('task-2', 'doing')
  ]);
  assert.match(body, /has cards task-1 \(todo\), task-2 \(doing\) but is not starting them/);
  assert.doesNotMatch(body, /has todo cards/);
});


test('closing time parks only an idle, closeable worker with nothing open', () => {
  const base = { eligible: true, canClose: true, hasMail: false, cards: [] };
  assert.equal(closingTimeParkable(base, true), true);
  assert.equal(closingTimeParkable(base, false), false, 'mid-turn: it gets the brief');
  assert.equal(closingTimeParkable({ ...base, cards: [card('a', 'doing')] }, true), false, 'an open card: it parks its own work');
  assert.equal(closingTimeParkable({ ...base, hasMail: true }, true), false);
  assert.equal(closingTimeParkable({ ...base, hasWork: true }, true), false);
  assert.equal(closingTimeParkable({ ...base, canClose: false }, true), false, 'keep-running or spawn-request worker');
  assert.equal(closingTimeParkable({ ...base, eligible: false }, true), false);
});

function idleAfterBlockedCard() {
  const h = closeHarness({ ledger: [card('a', 'doing')] });
  h.nudger.begin('bulba', ['a'], ['a']);
  h.state.ledger = [card('a', 'blocked')];
  h.stop();
  assert.equal(h.nudger.isIdle('bulba'), true);
  return h;
}

const COMPACT = '/compact Keep current work and decisions.';

test('idle compaction: a blocked card returned to todo closes without another Stop', () => {
  const h = idleAfterBlockedCard();
  h.nudger.noteHook('bulba', 'PreCompact');
  h.nudger.noteHook('bulba', 'PostCompact');
  h.state.ledger = [card('a')];
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [['a']]);
  assert.deepEqual(h.nudges, []);
  assert.equal(h.nudger.holdMail('bulba'), true);
});

test('idle compaction: queued command, Enter retries and compact SessionStart restore idle', () => {
  const h = idleAfterBlockedCard();
  h.nudger.noteInput('bulba', COMPACT);
  h.nudger.noteInput('bulba', '\r');
  h.nudger.noteInput('bulba', '\r');
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  h.nudger.noteHook('bulba', 'PreCompact');
  h.nudger.noteHook('bulba', 'SessionStart', undefined, 'compact');
  h.state.ledger = [card('a')];
  assert.equal(h.nudger.holdMail('bulba'), true);
  assert.deepEqual(h.closes, [['a']]);
});

test('a card arriving during idle compaction closes once compaction ends', () => {
  const h = idleAfterBlockedCard();
  h.nudger.noteInput('bulba', `\x1b[200~${COMPACT}\x1b[201~`);
  h.nudger.noteHook('bulba', 'PreCompact');
  h.state.ledger = [card('a', 'blocked'), card('c')];
  h.nudger.cardsChanged();
  assert.equal(h.nudger.isIdle('bulba'), false);
  assert.equal(h.nudger.holdMail('bulba'), false, 'no card-close while compacting');
  h.clock.flush();
  assert.deepEqual(h.closes, []);
  assert.deepEqual(h.nudges, []);
  h.nudger.noteHook('bulba', 'PostCompact');
  assert.deepEqual(h.closes, [['c']]);
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.noteHook('bulba', 'SessionStart', undefined, 'compact');
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [['c']], 'both completion hooks still propose only one close');
});

test('compaction during a work turn stays busy until Stop', () => {
  const h = idleAfterBlockedCard();
  h.nudger.noteHook('bulba', 'UserPromptSubmit');
  h.nudger.noteHook('bulba', 'PreCompact');
  h.nudger.noteHook('bulba', 'PostCompact');
  h.nudger.noteHook('bulba', 'SessionStart', undefined, 'compact');
  h.state.ledger = [card('a')];
  h.nudger.cardsChanged();
  assert.equal(h.nudger.isIdle('bulba'), false);
  assert.equal(h.nudger.holdMail('bulba'), false);
  assert.deepEqual(h.closes, []);
  h.stop();
  assert.deepEqual(h.closes, [['a']]);
});

test('real input or work during compaction cancels idle restoration', () => {
  const activity = [
    (n) => n.noteInput('bulba', 'hello'),
    (n) => n.noteHook('bulba', 'PreToolUse'),
    (n) => n.noteHook('bulba', 'Notification', 'permission required'),
    (n) => n.noteWork('bulba')
  ];
  for (const act of activity) {
    const h = idleAfterBlockedCard();
    h.nudger.noteInput('bulba', COMPACT);
    h.nudger.noteHook('bulba', 'PreCompact');
    act(h.nudger);
    h.nudger.noteHook('bulba', 'PostCompact');
    h.nudger.noteHook('bulba', 'SessionStart', undefined, 'compact');
    h.state.ledger = [card('a')];
    h.nudger.cardsChanged();
    assert.equal(h.nudger.isIdle('bulba'), false);
    assert.deepEqual(h.closes, []);
    h.stop();
    assert.deepEqual(h.closes, [['a']]);
  }
});

test('session startup and unmatched compact completion cannot mark a busy worker idle', () => {
  const h = closeHarness({ ledger: [] });
  h.nudger.begin('bulba', []);
  h.nudger.noteHook('bulba', 'PostCompact');
  h.nudger.noteHook('bulba', 'SessionStart', undefined, 'compact');
  h.state.ledger = [card('c')];
  h.nudger.cardsChanged();
  assert.equal(h.nudger.isIdle('bulba'), false);
  assert.deepEqual(h.closes, []);
});

test('a new session forgets in-flight compaction state', () => {
  const h = idleAfterBlockedCard();
  h.nudger.noteInput('bulba', COMPACT);
  h.nudger.begin('bulba', ['c']);
  h.state.ledger = [card('c'), card('d')];
  h.nudger.noteHook('bulba', 'PostCompact');
  assert.equal(h.nudger.holdMail('bulba'), false);
  assert.equal(h.nudger.isIdle('bulba'), false);
  assert.deepEqual(h.closes, []);
});

function completedHarness() {
  const h = closeHarness({ ledger: [card('a', 'doing')] });
  h.nudger.begin('bulba', ['a'], ['a']);
  h.state.memoryUpdated = true;
  h.state.ledger = [card('a', 'blocked', { notes: 'awaiting boss merge', brief: 'branch abc; verified' })];
  return h;
}

test('last-card done waits for Stop, then proposes a close with no next card', () => {
  const h = completedHarness();
  h.nudger.noteDone('bulba');
  h.nudger.cardsChanged();
  h.clock.flush();
  assert.deepEqual(h.closes, [], 'never close mid-turn');
  h.stop();
  assert.deepEqual(h.closes, [[]]);
  assert.equal(h.nudger.closeStands('bulba'), true);
  h.nudger.noteHook('bulba', 'PreToolUse');
  assert.equal(h.nudger.closeStands('bulba'), false, 'new activity withdraws the close');
});

test('done arriving after Stop still queues last-card close', () => {
  const h = completedHarness();
  h.stop();
  assert.deepEqual(h.closes, []);
  h.nudger.noteDone('bulba');
  assert.deepEqual(h.closes, [], 'settling delay still applies');
  h.clock.flush();
  assert.deepEqual(h.closes, [[]]);
});

test('last-card handoff requires report, brief, memory and completion status', () => {
  for (const missing of ['report', 'brief', 'memory', 'status', 'worked', 'eligible', 'closeable']) {
    const h = completedHarness();
    if (missing !== 'report') h.nudger.noteDone('bulba');
    if (missing === 'brief') h.state.ledger[0].brief = '  ';
    if (missing === 'memory') h.state.memoryUpdated = false;
    if (missing === 'status') h.state.ledger[0].notes = 'waiting on human';
    if (missing === 'worked') h.nudger.begin('bulba', ['a']);
    if (missing === 'eligible') h.state.eligible = false;
    if (missing === 'closeable') h.state.canClose = false;
    h.stop();
    assert.deepEqual(h.closes, [], missing);
  }
});

test('doing work prevents last-card close, and a revived card withdraws eligibility', () => {
  const h = completedHarness();
  h.nudger.begin('bulba', ['a', 'b'], ['a', 'b']);
  h.nudger.noteDone('bulba');
  h.state.ledger.push(card('b', 'doing'));
  h.stop();
  assert.deepEqual(h.closes, []);
  h.state.ledger.pop();
  h.stop();
  assert.deepEqual(h.closes, [[]]);
  h.state.ledger[0].status = 'doing';
  assert.equal(h.nudger.shouldClose('bulba'), false);
});

test('fresh wake forgets old completion and cannot park itself in a loop', () => {
  const h = completedHarness();
  h.nudger.noteDone('bulba');
  h.stop();
  h.nudger.begin('bulba', []);
  h.stop();
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [[]]);
});

test('done card, delayed ledger handoff, mail holding and retry use the same close guard', () => {
  const h = completedHarness();
  h.state.ledger[0].status = 'doing';
  h.nudger.noteDone('bulba');
  h.stop();
  h.state.ledger[0].status = 'done';
  h.nudger.cardsChanged();
  assert.deepEqual(h.closes, [[]]);
  assert.equal(h.nudger.holdMail('bulba'), true);
  assert.equal(h.nudger.closeRefused('bulba', 'draft'), true);
  h.clock.flush();
  assert.deepEqual(h.closes, [[], []]);
});
