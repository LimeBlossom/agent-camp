'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { createModelSwitcher } = loadTs('src/main/modelSwitch.ts');
const { balanceEngines } = loadTs('src/main/engineChoice.ts');

const SONNET = { provider: 'claude', model: 'claude-sonnet-4-6' };
const OPUS = { provider: 'claude', model: 'claude-opus-4-8' };
const CODEX = { provider: 'codex', model: 'gpt-5.4' };

function rig(over = {}) {
  const s = {
    t: 1_000_000, quiet: true, closing: false, live: true,
    agent: { id: 'worker', name: 'Elm', isGod: false, current: SONNET, walk: [SONNET, OPUS] },
    persisted: [], ledger: [], restarts: [], restartOk: true,
    ...over
  };
  const deps = {
    now: () => s.t,
    agent: (id) => (id === s.agent.id ? { ...s.agent, live: s.live } : null),
    quiet: () => s.quiet,
    closing: () => s.closing,
    choices: () => [SONNET, OPUS, CODEX],
    persist: (id, entry) => { s.persisted.push({ id, entry }); },
    storedPin: (id) => s.storedPins?.[id] ?? null,
    restart: async (id, from, to) => { s.restarts.push({ id, from, to }); return s.restartOk; },
    ledger: (ev) => s.ledger.push(ev)
  };
  return { s, sw: createModelSwitcher(deps) };
}

test('a quiet live agent is switched at once: persisted, restarted, in flight', async () => {
  const { s, sw } = rig();
  const r = await sw.switchAgentModel('worker', OPUS, 'phone');
  assert.deepEqual({ ok: r.ok, state: r.state, from: r.from, to: r.to }, { ok: true, state: 'switching', from: 'claude/claude-sonnet-4-6', to: 'claude/claude-opus-4-8' });
  assert.equal(s.persisted.length, 1);
  assert.equal(s.restarts.length, 1);
  assert.equal(sw.status('worker').state, 'switching');
  sw.completed('worker');
  assert.equal(sw.status('worker'), null);
});

test('a busy terminal queues the switch as pending and applies it at the next quiet tick', async () => {
  const { s, sw } = rig({ quiet: false });
  const r = await sw.switchAgentModel('worker', OPUS, 'phone');
  assert.equal(r.ok, true);
  assert.equal(r.state, 'pending');
  assert.equal(s.restarts.length, 0, 'must not cut a turn that is producing output');
  assert.equal(s.persisted.length, 0, 'nothing is stored until the switch is applied');
  await sw.tick();
  assert.equal(s.restarts.length, 0);
  assert.equal(sw.status('worker').state, 'pending');
  s.quiet = true;
  await sw.tick();
  assert.equal(s.restarts.length, 1);
  assert.equal(sw.status('worker').state, 'switching');
});

test('closing time holds a switch pending even when the terminal is quiet', async () => {
  const { s, sw } = rig({ closing: true });
  assert.equal((await sw.switchAgentModel('worker', OPUS, 'phone')).state, 'pending');
  await sw.tick();
  assert.equal(s.restarts.length, 0);
  s.closing = false;
  await sw.tick();
  assert.equal(s.restarts.length, 1);
});

test('a second request replaces the queued one; the latest choice wins', async () => {
  const { s, sw } = rig({ quiet: false });
  await sw.switchAgentModel('worker', OPUS, 'phone');
  await sw.switchAgentModel('worker', CODEX, 'phone');
  s.quiet = true;
  await sw.tick();
  assert.equal(s.restarts.length, 1);
  assert.equal(s.restarts[0].to, 'codex/gpt-5.4');
});

test('an in-flight restart the renderer never carried out is proposed again after a minute', async () => {
  const { s, sw } = rig();
  await sw.switchAgentModel('worker', OPUS, 'phone');
  s.t += 30_000; await sw.tick();
  assert.equal(s.restarts.length, 1);
  s.t += 31_000; await sw.tick();
  assert.equal(s.restarts.length, 2);
});

test('a dormant agent has nothing to restart: the choice is stored for its next wake', async () => {
  const { s, sw } = rig({ live: false });
  const r = await sw.switchAgentModel('worker', CODEX, 'phone');
  assert.equal(r.state, 'applied');
  assert.equal(s.restarts.length, 0);
  assert.deepEqual(s.persisted[0].entry, CODEX);
  assert.equal(s.ledger.length, 1);
});

test('each applied switch is one engine-ledger record with reason phone', async () => {
  const { s, sw } = rig({ quiet: false });
  await sw.switchAgentModel('worker', OPUS, 'phone');
  assert.equal(s.ledger.length, 0, 'a queued switch is not recorded until it is applied');
  s.quiet = true;
  await sw.tick();
  assert.equal(s.ledger.length, 1);
  assert.deepEqual(
    { kind: s.ledger[0].kind, agentId: s.ledger[0].agentId, reason: s.ledger[0].reason, chosen: s.ledger[0].chosen, previous: s.ledger[0].previous, changed: s.ledger[0].changed },
    { kind: 'model-switch', agentId: 'worker', reason: 'phone', chosen: 'claude/claude-opus-4-8', previous: 'claude/claude-sonnet-4-6', changed: true }
  );
});

test('the chosen entry is stored as the engine and the persisted pin, keeping its tier cap', async () => {
  const capped = { ...CODEX, maxPercent: 70 };
  const { s, sw } = rig({ agent: { id: 'worker', name: 'F', isGod: false, current: SONNET, walk: [SONNET, capped, OPUS] } });
  await sw.switchAgentModel('worker', CODEX, 'phone');
  assert.equal(s.persisted.length, 1);
  assert.deepEqual(s.persisted[0].entry, CODEX);
  assert.equal('ladder' in s.persisted[0], false, 'no per-agent ladder is written');
});

test('the switch sticks: the next balancer pick keeps it even when a later entry paces better', async () => {
  const { sw } = rig();
  await sw.switchAgentModel('worker', OPUS, 'phone');
  const ladder = [OPUS, SONNET];
  const cands = ladder.map((e) => ({ engine: e === OPUS ? 'codex' : 'claude', label: e.model }));
  const readings = {
    codex: { used: 60, pace: 95, lockoutMs: 5 * 3_600_000 },
    claude: { used: 5, pace: 10, lockoutMs: 0 }
  };
  const bare = balanceEngines(cands, readings, 1_000_000);
  assert.notEqual(bare && bare.index, 0, 'precondition: without a pin the balancer prefers the other entry');
  const usable = () => true;
  assert.deepEqual(sw.pinnedEntry('worker', usable), OPUS);
  assert.deepEqual(sw.pinnedEntry('worker', usable), OPUS, 'a pin survives repeated beats');
});

test('a pin lapses once its entry is unusable, so the limit path can move the agent', async () => {
  const { sw } = rig();
  await sw.switchAgentModel('worker', OPUS, 'phone');
  assert.equal(sw.pinnedEntry('worker', () => false), null);
  assert.equal(sw.pinnedEntry('worker', () => true), null, 'a lapsed session pin does not come back');
});

test('a persisted pin applies again once its entry has room after a reset', () => {
  const { s, sw } = rig();
  s.storedPins = { worker: OPUS };
  assert.equal(sw.pinnedEntry('worker', () => false), null, 'unusable while its meter is spent');
  assert.deepEqual(sw.pinnedEntry('worker', () => true), OPUS, 'back after the reset');
});

test('unknown agents, entries outside the choices, and the Boss without confirmation are refused cleanly', async () => {
  const { s, sw } = rig();
  assert.deepEqual(await sw.switchAgentModel('nobody', OPUS, 'phone'), { ok: false, code: 'unknown-agent', error: 'unknown agent' });
  const bad = await sw.switchAgentModel('worker', { provider: 'claude', model: 'claude-nonesuch' }, 'phone');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unknown-entry');
  const boss = rig({ agent: { id: 'boss', name: 'Boss', isGod: true, current: SONNET, walk: [SONNET, OPUS] } });
  const refused = await boss.sw.switchAgentModel('boss', OPUS, 'phone');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'boss-unconfirmed');
  assert.equal(boss.s.restarts.length, 0);
  assert.equal(s.restarts.length, 0);
  const ok = await boss.sw.switchAgentModel('boss', OPUS, 'phone', { confirmBoss: true });
  assert.equal(ok.ok, true);
});

test('choosing the model the agent already runs is a no-op that still pins it', async () => {
  const { s, sw } = rig();
  const r = await sw.switchAgentModel('worker', SONNET, 'phone');
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal(s.restarts.length, 0);
  assert.equal(s.ledger.length, 0);
  assert.deepEqual(sw.pinnedEntry('worker', () => true), SONNET);
});

test('a restart that could not start keeps the switch queued for the next tick', async () => {
  const { s, sw } = rig({ restartOk: false });
  assert.equal((await sw.switchAgentModel('worker', OPUS, 'phone')).state, 'pending');
  s.restartOk = true;
  await sw.tick();
  assert.equal(sw.status('worker').state, 'switching');
});

test('a desktop pin reaches the switcher with reason desktop, persists the roster pin and records the caller', async () => {
  const { s, sw } = rig();
  const r = await sw.switchAgentModel('worker', OPUS, 'desktop', { confirmBoss: true });
  assert.equal(r.ok, true);
  assert.deepEqual(s.persisted, [{ id: 'worker', entry: OPUS }], 'the roster pin is stored');
  assert.equal(s.ledger[0].reason, 'desktop');
  assert.equal(s.ledger[0].chosen, 'claude/claude-opus-4-8');
  assert.deepEqual(sw.pinnedEntry('worker', () => true), OPUS, 'the session pin follows');
});

test('engine:pinModel hands the entry to switchAgentModel as a desktop switch', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const at = src.indexOf("ipcMain.handle('engine:pinModel'");
  assert.ok(at > 0, 'handler is registered');
  const body = src.slice(at, src.indexOf('\n});', at));
  assert.match(body, /modelSwitcher\.switchAgentModel\(agentId, entry as AgentModelEntry, 'desktop'/);
});
