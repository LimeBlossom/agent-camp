'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { createModelSwitcher } = loadTs('src/main/modelSwitch.ts');

const SONNET = { provider: 'claude', model: 'claude-sonnet-4-6' };
const OPUS = { provider: 'claude', model: 'claude-opus-4-8' };

function rig(over = {}) {
  const s = { t: 1_000_000, quiet: true, closing: false, live: true, persisted: [], ledger: [], restarts: [], ...over };
  const sw = createModelSwitcher({
    now: () => s.t,
    agent: (id) => (id === 'w' ? { id: 'w', name: 'W', isGod: false, current: SONNET, walk: [SONNET, OPUS], live: s.live } : null),
    quiet: () => s.quiet,
    closing: () => s.closing,
    choices: () => [SONNET, OPUS],
    persist: (id, entry) => s.persisted.push({ id, entry }),
    restart: async (id, from, to) => { s.restarts.push({ id, from, to }); return true; },
    ledger: (ev) => s.ledger.push(ev)
  });
  return { s, sw };
}

test('switchAgentModel to the current model stays a no-op that restarts nothing', async () => {
  const { s, sw } = rig();
  const r = await sw.switchAgentModel('w', SONNET, 'checkpoint');
  assert.equal(r.noop, true);
  assert.equal(s.restarts.length, 0);
});

test('freshRestart respawns a quiet live agent on the same model without storing a model', async () => {
  const { s, sw } = rig();
  const r = await sw.freshRestart('w', 'checkpoint');
  assert.deepEqual({ ok: r.ok, state: r.state, from: r.from, to: r.to }, { ok: true, state: 'switching', from: 'claude/claude-sonnet-4-6', to: 'claude/claude-sonnet-4-6' });
  assert.equal(s.restarts.length, 1);
  assert.equal(s.persisted.length, 0);
  assert.equal(s.ledger[0].reason, 'checkpoint');
  assert.equal(s.ledger[0].changed, false);
  assert.equal(sw.status('w').state, 'switching');
  sw.completed('w');
  assert.equal(sw.status('w'), null);
});

test('freshRestart waits for a quiet terminal, like a switch', async () => {
  const { s, sw } = rig({ quiet: false });
  assert.equal((await sw.freshRestart('w', 'checkpoint')).state, 'pending');
  assert.equal(s.restarts.length, 0);
  s.quiet = true;
  await sw.tick();
  assert.equal(s.restarts.length, 1);
});

test('freshRestart of a dormant agent has nothing to restart', async () => {
  const { s, sw } = rig({ live: false });
  assert.equal((await sw.freshRestart('w', 'checkpoint')).state, 'applied');
  assert.equal(s.restarts.length, 0);
});

test('freshRestart of an unknown agent is refused', async () => {
  const { sw } = rig();
  const r = await sw.freshRestart('nope', 'checkpoint');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown-agent');
});
