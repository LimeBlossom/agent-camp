'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const OLD = { provider: 'antigravity', model: 'gemini-3-pro' };
const NEXT = { provider: 'codex', model: 'gpt-5.4' };
const NAMED = { provider: 'claude', model: 'claude-sonnet-4-6' };
const NOW = 1_800_000_000_000;

// Proposed injectable seam: main supplies process-tree stop/fresh-spawn and
// HiveManager supplies authenticated sender, cards and audit persistence.
function rig(over = {}) {
  const modulePath = path.join(__dirname, '../src/main/agentRestart.ts');
  assert.ok(fs.existsSync(modulePath), 'missing recovery controller src/main/agentRestart.ts');
  const { createAgentRestarter } = loadTs('src/main/agentRestart.ts');
  assert.equal(typeof createAgentRestarter, 'function');
  const s = {
    calls: [], logs: [], notes: [],
    worker: { id: 'worker', isGod: false, current: OLD, ladder: [OLD, NEXT, NAMED], live: true, lastActivityAt: NOW - 3 * 3600_000 },
    card: { id: 'current', status: 'doing', assignee: 'worker', brief: 'Keep the red tests and finish restart support' },
    ...over
  };
  const controller = createAgentRestarter({
    now: () => NOW,
    bossId: () => 'chief',
    recentActivityMs: () => 5 * 60_000,
    agent: id => id === 'worker' ? s.worker : id === 'chief' ? { ...s.worker, id, isGod: true } : null,
    currentCard: () => s.card,
    choices: () => [OLD, NEXT, NAMED],
    writeHandoff: async (id, data) => { s.calls.push(['handoff', id, data]); if (s.fail === 'handoff') throw Error('handoff unavailable'); },
    stopTree: async id => { s.calls.push(['stop', id]); if (s.stopGate) await s.stopGate; if (s.fail === 'stop') throw Error('stop unavailable'); return true; },
    startFresh: async (id, model, cardId) => { s.calls.push(['start', id, model, cardId]); if (s.fail === 'start') throw Error('spawn unavailable'); return true; },
    appendLog: event => s.logs.push(event),
    noteCard: (id, note) => s.notes.push({ id, note })
  });
  return { s, restart: (body = {}, sender = 'chief') => controller.restart(sender, { agentId: 'worker', reason: 'Silent for three hours', ...body }) };
}

test('hung worker handoff precedes awaited tree stop and fresh start on next ladder model/current card', async () => {
  const { s, restart } = rig();
  const result = await restart();
  assert.equal(result.ok, true);
  assert.deepEqual(s.calls.map(c => c[0]), ['handoff', 'stop', 'start']);
  const handoff = s.calls[0][2];
  assert.equal(handoff.card.id, 'current');
  assert.equal(handoff.card.brief, s.card.brief);
  assert.equal(handoff.lastActivityAt, s.worker.lastActivityAt);
  assert.match(handoff.reason, /Silent for three hours/);
  assert.deepEqual(s.calls[2], ['start', 'worker', NEXT, 'current']);
});

test('success emits agent-restart who/reason/old/new model and annotates current card', async () => {
  const { s, restart } = rig();
  assert.equal((await restart()).ok, true);
  const event = s.logs.find(e => e.kind === 'agent-restart');
  assert.ok(event, 'log.jsonl needs a distinct agent-restart audit event');
  assert.equal(event.who, 'chief');
  assert.equal(event.agentId, 'worker');
  assert.equal(event.reason, 'Silent for three hours');
  assert.deepEqual(event.oldModel, OLD);
  assert.deepEqual(event.newModel, NEXT);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].id, 'current');
  assert.match(s.notes[0].note, /restart/i);
  assert.match(s.notes[0].note, /Silent for three hours/);
});

test('explicit named model overrides ladder successor', async () => {
  const { s, restart } = rig();
  assert.equal((await restart({ model: NAMED })).ok, true);
  assert.deepEqual(s.calls.find(c => c[0] === 'start')[2], NAMED);
});

for (const [label, body, sender, change] of [
  ['worker spoofing Boss', { force: true, who: 'chief' }, 'worker', {}],
  ['Boss target with force', { agentId: 'chief', force: true }, 'chief', {}],
  ['unknown target', { agentId: 'absent' }, 'chief', {}],
  ['blank reason', { reason: ' ' }, 'chief', {}],
  ['unavailable model', { model: { provider: 'codex', model: 'missing' } }, 'chief', {}],
  ['missing current card', {}, 'chief', { card: null }],
  ['recent session activity', {}, 'chief', { age: 60_000 }],
  ['unknown session activity', {}, 'chief', { age: null }]
]) {
  test(`controller refuses ${label} before any side effect`, async () => {
    const { s, restart } = rig(change);
    if (Object.hasOwn(change, 'age')) s.worker.lastActivityAt = change.age === null ? undefined : NOW - change.age;
    const result = await restart(body, sender);
    assert.equal(result.ok, false);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.notes, []);
    assert.equal(s.logs.some(e => e.kind === 'agent-restart' && e.ok !== false), false);
  });
}

test('force explicitly permits recent activity without changing card/model selection', async () => {
  const { s, restart } = rig();
  s.worker.lastActivityAt = NOW - 1000;
  assert.equal((await restart({ force: true })).ok, true);
  assert.deepEqual(s.calls.find(c => c[0] === 'start'), ['start', 'worker', NEXT, 'current']);
});

test('start waits for process-tree stop to finish', async () => {
  let release;
  const stopGate = new Promise(resolve => { release = resolve; });
  const { s, restart } = rig({ stopGate });
  const pending = restart();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(s.calls.map(c => c[0]), ['handoff', 'stop']);
  } finally { release(); }
  assert.equal((await pending).ok, true);
});

for (const fail of ['handoff', 'stop', 'start']) {
  test(`${fail} failure is reported without later actions or false success audit`, async () => {
    const { s, restart } = rig({ fail });
    const result = await restart();
    assert.equal(result.ok, false);
    const expected = fail === 'handoff' ? ['handoff'] : fail === 'stop' ? ['handoff', 'stop'] : ['handoff', 'stop', 'start'];
    assert.deepEqual(s.calls.map(c => c[0]), expected);
    assert.equal(s.logs.some(e => e.kind === 'agent-restart' && e.ok !== false), false);
  });
}
