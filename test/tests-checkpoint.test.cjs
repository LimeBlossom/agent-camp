'use strict';

/**
 * Tests-to-implementation checkpoint: a senior that wrote failing tests and will
 * implement the same card sends testsReady with then: 'implement'.
 * The checkpoint writes the handoff and restarts the senior fresh on the card,
 * on its current engine/model, without asking the human on the phone or waiting for a timeout.
 * An engine switch occurs only if the current model is quota-refused (existing ladder behavior).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { createTestsCheckpoint } = loadTs('src/main/testsCheckpoint.ts');
const { createModelSwitcher } = loadTs('src/main/modelSwitch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const SONNET = { provider: 'claude', model: 'claude-sonnet-4-6' };
const OPUS = { provider: 'claude', model: 'claude-opus-4-8' };
const CODEX = { provider: 'codex', model: 'gpt-5.4' };
const READY = { branch: 'cedar/red', worktree: '/tmp/wt', head: 'a1b2c3d4e5f6', then: 'implement' };

function rig(over = {}) {
  const s = {
    t: 5_000_000, timeout: 600_000, asks: [], settled: [], handoffs: [], switches: [], fresh: [], ledger: [],
    askOk: true, order: [],
    agents: {
      cedar: {
        id: 'cedar',
        name: 'Cedar',
        isGod: false,
        role: 'Senior Software Developer',
        current: SONNET,
        walk: [SONNET, OPUS, CODEX],
        live: true
      }
    },
    cards: { c1: { id: 'c1', assignee: 'cedar' } },
    ...over
  };
  const cp = createTestsCheckpoint({
    now: () => s.t,
    timeoutMs: () => s.timeout,
    agent: (id) => s.agents[id] ?? null,
    card: (id) => s.cards[id] ?? null,
    writeHandoff: async (id) => { s.order.push('handoff'); s.handoffs.push(id); },
    postAsk: (cardId, q) => { s.order.push('ask'); s.asks.push({ cardId, q }); return s.askOk; },
    settle: (cardId, q, note) => { s.settled.push({ cardId, q, note }); },
    switcher: {
      switchAgentModel: async (id, entry, reason) => { s.order.push('switch'); s.switches.push({ id, entry, reason }); return { ok: true, state: 'switching' }; },
      freshRestart: async (id, reason) => { s.order.push('fresh'); s.fresh.push({ id, reason }); return { ok: true, state: 'switching' }; }
    },
    ledger: (ev) => s.ledger.push(ev)
  });
  return { s, cp };
}

test('red tests on a senior implement card: handoff written and senior restarted fresh on current model without asking the human', async () => {
  const { s, cp } = rig();
  const r = await cp.onSignal('cedar', 'c1', READY);
  assert.equal(r.fired, true, 'checkpoint fired for eligible senior implement card');
  assert.equal(s.asks.length, 0, 'sends NO phone/human question to the human');
  assert.equal(s.handoffs.length, 1, 'writes the handoff');
  assert.deepEqual(s.fresh, [{ id: 'cedar', reason: 'checkpoint' }], 'restarts the senior fresh immediately on current model');
  assert.deepEqual(s.order, ['handoff', 'fresh'], 'handoff written before fresh restart');
  assert.equal(s.switches.length, 0, 'does not switch models directly');
  assert.equal(cp.pending?.('c1') ?? null, null, 'does not leave a pending checkpoint waiting for an answer');
});

test('checkpoint does not wait testsCheckpointTimeoutMs before restarting', async () => {
  const { s, cp } = rig();
  await cp.onSignal('cedar', 'c1', READY);
  // Fresh restart must have already happened immediately upon signal without waiting for tick or timeout
  assert.equal(s.fresh.length, 1, 'restarts immediately upon signal');
  assert.equal(s.asks.length, 0, 'no ask was sent');
  s.t += 600_000;
  if (typeof cp.tick === 'function') await cp.tick();
  assert.equal(s.fresh.length, 1, 'timeout tick does not trigger redundant restart');
});

test('the tests-first handoff shape (then: handoff) is not a checkpoint: Elm cards are unaffected', async () => {
  const { s, cp } = rig();
  const r = await cp.onSignal('cedar', 'c1', { ...READY, then: 'handoff' });
  assert.equal(r.fired, false);
  assert.equal(s.asks.length + s.handoffs.length + s.fresh.length, 0);
  assert.equal(cp.pending?.('c1') ?? null, null);
});

test('a Unit Test Developer never gets the checkpoint, whatever it declares', async () => {
  const { s, cp } = rig();
  s.agents.elm = { id: 'elm', name: 'Elm', isGod: false, role: 'Unit Test Developer', current: SONNET, walk: [SONNET, OPUS], live: true };
  s.cards.c2 = { id: 'c2', assignee: 'elm' };
  const r = await cp.onSignal('elm', 'c2', READY);
  assert.equal(r.fired, false);
  assert.equal(s.asks.length, 0);
  assert.equal(s.fresh.length, 0);
});

test('only the card assignee, once per card, and never the Boss', async () => {
  const { s, cp } = rig();
  s.agents.god = { id: 'god', name: 'Boss', isGod: true, current: OPUS, walk: [], live: true };
  assert.equal((await cp.onSignal('god', 'c1', READY)).fired, false);
  s.agents.other = { id: 'other', name: 'O', isGod: false, role: 'Senior', current: OPUS, walk: [], live: true };
  assert.equal((await cp.onSignal('other', 'c1', READY)).fired, false, 'not its card');
  assert.equal((await cp.onSignal('cedar', 'c1', READY)).fired, true);
  s.cards.c1.testsCheckpoint = { state: 'done' };
  assert.equal((await cp.onSignal('cedar', 'c1', READY)).fired, false, 'a card that already went through it does not repeat');
});

test('ladder quota-refusal behaviour: checkpoint fresh restart stays on current engine unless quota-refused', async () => {
  const s = {
    t: 5_000_000,
    quiet: true,
    closing: false,
    persisted: [],
    ledger: [],
    restarts: [],
    agents: {
      cedar: {
        id: 'cedar',
        name: 'Cedar',
        isGod: false,
        role: 'Senior Software Developer',
        current: SONNET,
        walk: [SONNET, OPUS, CODEX],
        live: true
      }
    },
    cards: { c1: { id: 'c1', assignee: 'cedar' } },
    handoffs: [],
    asks: []
  };

  const sw = createModelSwitcher({
    now: () => s.t,
    agent: (id) => s.agents[id] ?? null,
    quiet: () => s.quiet,
    closing: () => s.closing,
    choices: (id) => s.agents[id]?.walk ?? [],
    persist: (id, entry) => s.persisted.push({ id, entry }),
    restart: async (id, from, to) => { s.restarts.push({ id, from, to }); return true; },
    ledger: (ev) => s.ledger.push(ev)
  });

  const cp = createTestsCheckpoint({
    now: () => s.t,
    timeoutMs: () => 600_000,
    agent: (id) => s.agents[id] ?? null,
    card: (id) => s.cards[id] ?? null,
    writeHandoff: async (id) => { s.handoffs.push(id); },
    postAsk: (cardId, q) => { s.asks.push({ cardId, q }); return true; },
    settle: () => {},
    switcher: sw,
    ledger: (ev) => s.ledger.push(ev)
  });

  const r = await cp.onSignal('cedar', 'c1', READY);
  assert.equal(r.fired, true);
  assert.equal(s.asks.length, 0, 'no question asked to the human');
  assert.equal(s.restarts.length, 1, 'fresh restart invoked');
  assert.equal(s.persisted.length, 0, 'does not persist a model switch');

  // When current engine (SONNET) is usable (has quota):
  // The pin holds and the agent stays on SONNET
  const usableWhenHealthy = (e) => e.provider === SONNET.provider && e.model === SONNET.model;
  assert.deepEqual(sw.pinnedEntry('cedar', usableWhenHealthy), SONNET, 'keeps current model when usable');

  // When current engine is quota-refused:
  // The pin lapses so the ladder can switch to fallback (OPUS)
  const usableWhenQuotaRefused = (e) => !(e.provider === SONNET.provider && e.model === SONNET.model);
  assert.equal(sw.pinnedEntry('cedar', usableWhenQuotaRefused), null, 'pin lapses when current model is quota-refused');
});

test('the Boss prompt carries the routing rule', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-checkpoint-'));
  t.after(() => rmTree(dir));
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  const root = hive.root();
  const prompt = hive.injectedPrompt({ id: 'god', name: 'Boss', provider: 'claude', cwd: root, isGod: true }, path.join(root, 'agents', 'god'), root, false, false, undefined, '');
  assert.match(prompt, /TESTS FIRST: a new card starts with its failing tests/);
  assert.match(prompt, /testsReady/);
  assert.match(prompt, /tests-only writer[^.]*separate implementer/);
});
