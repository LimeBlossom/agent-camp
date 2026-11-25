'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { nextRestartModel, createAgentRestarter } = loadTs('src/main/agentRestart.ts');
const { DEFAULT_TIMINGS } = loadTs('src/main/timings.ts');

const A = { provider: 'antigravity', model: 'a' };
const B = { provider: 'codex', model: 'b' };
const C = { provider: 'claude', model: 'c' };

function hiveRig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-restart-wire-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  return hive;
}

test('PROTOCOL-BOSS.md documents restart_agent, force and model', t => {
  const hive = hiveRig(t);
  const text = fs.readFileSync(path.join(hive.root(), 'PROTOCOL-BOSS.md'), 'utf8');
  assert.match(text, /## Restarting a hung agent/);
  assert.match(text, /restart_agent/);
  assert.match(text, /force: true/);
  assert.match(text, /STALLED/);
});

test('appendCardNote persists on the named card only and throws for a missing one', t => {
  const hive = hiveRig(t);
  hive.writeTasks([
    { id: 'one', title: 'One', assignee: 'w', status: 'doing', notes: 'older', dependsOn: [] },
    { id: 'two', title: 'Two', assignee: 'w', status: 'todo', dependsOn: [] }
  ]);
  hive.appendCardNote('one', 'Boss restarted w');
  const cards = hive.tasks().tasks;
  assert.match(cards.find(c => c.id === 'one').notes, /^older\n.* Boss restarted w$/);
  assert.equal(cards.find(c => c.id === 'two').notes, undefined);
  assert.throws(() => hive.appendCardNote('ghost', 'x'), /ghost/);
});

test('successor skips unlaunchable entries and stays put at the end of the ladder', () => {
  assert.deepEqual(nextRestartModel(A, [A, B, C], [A, C]), C);
  assert.deepEqual(nextRestartModel(C, [A, B, C], [A, B, C]), C);
  assert.deepEqual(nextRestartModel(A, [A], [A]), A);
  assert.deepEqual(nextRestartModel(B, [A, C], [A, B, C]), A);
});

test('a log or note failure after a successful restart is a warning, not a failure', async () => {
  const calls = [];
  const { restart } = createAgentRestarter({
    now: () => 10_000_000, bossId: () => 'chief', recentActivityMs: () => 60_000,
    agent: id => ({ id, isGod: id === 'chief', current: A, ladder: [A, B], lastActivityAt: 0 }),
    currentCard: () => ({ id: 'c1' }), choices: () => [A, B],
    writeHandoff: async () => calls.push('handoff'), stopTree: async () => calls.push('stop') || true, startFresh: async () => calls.push('start') || true,
    appendLog: () => { throw new Error('disk full'); }, noteCard: () => { throw new Error('ledger locked'); }
  });
  const r = await restart('chief', { agentId: 'w', reason: 'hung' });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(calls, ['handoff', 'stop', 'start']);
});

test('overlapping restarts of one agent run once', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let starts = 0;
  const { restart } = createAgentRestarter({
    now: () => 10_000_000, bossId: () => 'chief', recentActivityMs: () => 60_000,
    agent: id => ({ id, isGod: id === 'chief', current: A, ladder: [A, B], lastActivityAt: 0 }),
    currentCard: () => ({ id: 'c1' }), choices: () => [A, B],
    writeHandoff: async () => {}, stopTree: async () => { await gate; return true; }, startFresh: async () => { starts++; return true; },
    appendLog: () => {}, noteCard: () => {}
  });
  const first = restart('chief', { agentId: 'w', reason: 'hung' });
  const second = await restart('chief', { agentId: 'w', reason: 'hung again' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already in progress/);
  release();
  assert.equal((await first).ok, true);
  assert.equal(starts, 1);
});

test('blocked restart (closing time, switch in flight) touches nothing', async () => {
  const calls = [];
  const { restart } = createAgentRestarter({
    now: () => 10_000_000, bossId: () => 'chief', recentActivityMs: () => 60_000,
    agent: id => ({ id, isGod: id === 'chief', current: A, ladder: [A], lastActivityAt: 0 }),
    currentCard: () => ({ id: 'c1' }), choices: () => [A], blocked: () => 'closing time is running',
    writeHandoff: async () => calls.push('h'), stopTree: async () => calls.push('s') || true, startFresh: async () => calls.push('f') || true,
    appendLog: () => calls.push('l'), noteCard: () => calls.push('n')
  });
  const r = await restart('chief', { agentId: 'w', reason: 'hung', force: true });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
});

test('stall and restart timings default to 45 and 10 minutes', () => {
  assert.equal(DEFAULT_TIMINGS.stallAfterMs, 45 * 60_000);
  assert.equal(DEFAULT_TIMINGS.restartRecentActivityMs, 10 * 60_000);
});
