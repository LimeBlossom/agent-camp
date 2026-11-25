'use strict';

/**
 * agy's turn end. The fixture is the hook timeline agy 1.2.14 logged for a real
 * two-turn session (a reply, then a turn with four model calls): Stop fires once at
 * the end of each turn and not at exit, while PreInvocation/PostInvocation fire once
 * per model call. Replayed through the next-card nudge, each turn must end exactly
 * once, at Stop, and the next turn's first model call must cancel what the last Stop
 * scheduled and withdraw a close proposed for it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { TodoNudger } = loadTs('src/main/todoNudge.ts');

const EVENT = { 'pre-invocation': 'PreInvocation', 'post-invocation': 'PostInvocation', stop: 'Stop' };

/** [{ at, event }] in log order. */
function agyTimeline() {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-hook-turns.txt'), 'utf8');
  return raw.trim().split('\n').map((line) => {
    const [, at, , kind] = line.split(' ');
    assert.ok(EVENT[kind], `unknown hook kind in fixture: ${line}`);
    return { at, event: EVENT[kind] };
  });
}

function fakeScheduler() {
  let seq = 0;
  const pending = new Map();
  return {
    scheduler: {
      set: (fn) => { const h = ++seq; pending.set(h, fn); return h; },
      clear: (h) => { pending.delete(h); }
    },
    flush() { for (const [h, fn] of [...pending]) { pending.delete(h); fn(); } },
    size: () => pending.size
  };
}

const AGENT = 'spruce';

test('the fixture is two turns: one Stop per turn and several invocations in the second', () => {
  const events = agyTimeline().map((e) => e.event);
  assert.equal(events.filter((e) => e === 'Stop').length, 2);
  assert.equal(events.filter((e) => e === 'PostInvocation').length, 5);
  assert.equal(events[events.length - 1], 'Stop');
});

test('replayed through the next-card nudge, each agy turn ends once, at its Stop', () => {
  const s = fakeScheduler();
  const nudged = [];
  const cards = [{ id: 'card-1', title: 'one', assignee: AGENT, status: 'todo' }];
  const n = new TodoNudger({
    facts: () => ({ eligible: true, hasMail: false, cards }),
    nudge: (id, c) => { nudged.push(c.map((x) => x.id)); cards[0] = { ...cards[0], notes: `seen ${nudged.length}` }; return true; },
    ignored: () => {},
    scheduler: s.scheduler
  });
  let checks = 0;
  for (const { event } of agyTimeline()) {
    const before = n.isPending(AGENT);
    n.noteHook(AGENT, event);
    if (event === 'Stop') {
      assert.equal(n.isPending(AGENT), true, 'Stop schedules the check');
      checks++;
      s.flush();
    } else {
      assert.equal(n.isPending(AGENT), false, `${event} must not end the turn (was pending: ${before})`);
    }
  }
  assert.equal(checks, 2);
  assert.deepEqual(nudged, [['card-1'], ['card-1']]);
});

test('the next turn\'s first model call cancels the check and withdraws the close the last Stop proposed', () => {
  const ns = fakeScheduler();
  const ledger = [{ id: 'done-1', assignee: AGENT, status: 'todo' }, { id: 'c', assignee: AGENT, status: 'todo' }];
  const closes = [];
  const n = new TodoNudger({
    facts: () => ({ eligible: true, hasMail: false, canClose: true, cards: ledger.filter((c) => c.status === 'todo') }),
    nudge: () => true,
    ignored: () => {},
    close: (id) => { closes.push(id); return true; },
    scheduler: ns.scheduler
  });
  n.begin(AGENT, ['done-1', 'c']);
  ledger[0] = { ...ledger[0], status: 'done' };
  const timeline = agyTimeline();
  const firstStop = timeline.findIndex((e) => e.event === 'Stop');
  for (const { event } of timeline.slice(0, firstStop + 1)) n.noteHook(AGENT, event);
  assert.equal(n.isPending(AGENT), true);

  const next = timeline[firstStop + 1];
  assert.equal(next.event, 'PreInvocation');
  n.noteHook(AGENT, next.event);
  assert.equal(n.isPending(AGENT), false);
  ns.flush();
  assert.deepEqual(closes, [], 'the cancelled check never ran');

  for (const { event } of timeline.slice(firstStop + 2)) {
    n.noteHook(AGENT, event);
    if (event !== 'Stop') assert.equal(n.isPending(AGENT), false, `${event} must not end the turn`);
  }
  assert.equal(ns.size(), 1, 'the second turn\'s Stop schedules one check, not one per invocation');
  ns.flush();
  assert.deepEqual(closes, [AGENT]);
  assert.equal(n.closeStands(AGENT), true);
  n.noteHook(AGENT, 'PreInvocation');
  assert.equal(n.closeStands(AGENT), false, 'a model call before main acts withdraws the close');
});
