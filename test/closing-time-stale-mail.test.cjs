'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
const { DEFAULT_TIMINGS } = loadTs('src/main/timings.ts');
const { dormantWakeReason } = loadTs('src/shared/dormantWake.ts');
const { inboxNudgeText, isClosingNudge, nudgeForWakeMode } = loadTs('src/shared/hiveNudge.ts');

const NOW = Date.parse('2026-11-12T01:00:00.000Z');
const TWO_HOURS = 2 * 60 * 60_000;
const WORKER = 'willow';
const BOSS = 'god-1';
const WRAP_SUBJECT = 'WRAP UP — office is shutting down';
const WRAP_BODY = 'Park or commit your work-in-progress, save memory.md, then send WRAP-UP-ACK. Do not start, resume or accept any other work or card.';

async function floor(t, worker = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-stale-wrapup-'));
  const hive = new HiveManager(() => home);
  const meta = { id: WORKER, name: 'Willow', provider: 'claude', cwd: home, ...worker };
  await hive.ensureAgent({ id: BOSS, name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent(meta);
  const live = new Set([BOSS, WORKER]);
  const held = new Set();
  const events = [];
  const ct = new ClosingTimeController(hive, () => [...live],
    () => ({ send: (_channel, event) => events.push(event) }), () => {}, undefined, (id) => held.has(id));
  hive.setLiveAgentSource(() => [...live]);
  hive.setClosingTimeSource(() => ct.isActive());
  hive.setRoutedObserver((msg, targets) => ct.onRouted(msg, targets));
  t.after(() => { ct.cancel(); rmTree(home); });
  return { home, hive, meta, ct, live, held, events };
}

function mail(hive, subject = WRAP_SUBJECT, ageMs = 0, body = WRAP_BODY, extra = {}) {
  return hive.send({ to: WORKER, act: 'request', subject, body,
    created_at: new Date(Date.now() - ageMs).toISOString(), ...extra }, BOSS);
}

function inboxPath(hive, msg, done = false) {
  return path.join(hive.root(), 'agents', WORKER, 'inbox', ...(done ? ['.done'] : []), `${msg.id}.json`);
}

function assertFiled(hive, msg, original) {
  assert.equal(fs.existsSync(inboxPath(hive, msg)), false, 'shutdown order must leave the physical inbox before the agent can read it');
  assert.equal(fs.readFileSync(inboxPath(hive, msg, true), 'utf8'), original, 'filing preserves the original message byte-for-byte');
  assert.ok(hive.logTail(500).some((entry) => entry.kind === 'inbox-auto-filed'
    && entry.agentId === WORKER && entry.files?.includes(`${msg.id}.json`)), 'auto-filing must leave an audit event');
}

for (const subject of [WRAP_SUBJECT, 'Wrap-Up — save and stop', 'CLOSING-TIME — run the shutdown protocol now']) {
  test(`wake files an expired shutdown request: ${subject}`, async (t) => {
    const { hive, meta } = await floor(t);
    const stale = mail(hive, subject, TWO_HOURS + 1);
    const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
    const work = mail(hive, 'Start inventory mockup', 0, 'Continue the assigned inventory card.');
    hive.writeTasks([{ id: 'inventory', title: 'Inventory mockup', status: 'todo', assignee: WORKER, dependsOn: [], createdAt: new Date().toISOString() }]);
    const spawned = await hive.ensureAgent(meta);
    const kickoff = (spawned.kickoff ?? '');
    assert.match(kickoff, /inventory/);
    assert.doesNotMatch(kickoff, new RegExp(stale.id), 'fresh session must never be handed the stale mail id');
    assertFiled(hive, stale, original);
    assert.deepEqual(hive.inbox(WORKER).map((m) => m.id), [work.id]);
  });
}

test('entering dormant files an expired wrap-up before a future card wake', async (t) => {
  const { hive } = await floor(t);
  const stale = mail(hive, WRAP_SUBJECT, TWO_HOURS + 1);
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  hive.setDormancy({ dormant: [WORKER], archived: [] });
  assertFiled(hive, stale, original);
  assert.equal(dormantWakeReason(WORKER, [], hive.inbox(WORKER)), null, 'stale direct mail must not wake a sleeping worker');
});

test('Stop-hook drain excludes and files an expired shutdown order', async (t) => {
  const { hive } = await floor(t);
  const stale = mail(hive, WRAP_SUBJECT, TWO_HOURS + 1);
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  const work = mail(hive, 'Review inventory', 0, 'Review the new inventory layout.');
  const drained = hive.drainForStop(WORKER);
  assert.equal(drained.block, true);
  assert.match(drained.reason, /Review inventory/);
  assert.doesNotMatch(drained.reason, /office is shutting down|Do not start, resume or accept/);
  assertFiled(hive, stale, original);
  assert.deepEqual(hive.inbox(WORKER).map((m) => m.id), [work.id]);
});

test('app restart expires even a one-minute-old shutdown request', async (t) => {
  const { home, hive, meta } = await floor(t);
  const stale = mail(hive, WRAP_SUBJECT, 60_000);
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  const work = mail(hive, 'Keep this work request', 60_000, 'An ordinary request survives restart.');
  const restarted = new HiveManager(() => home);
  // Mirrors bootstrap: runtime info and app-start precede dormancy sync/spawn.
  restarted.setRuntimeInfo({ version: '0.4.6', packaged: true });
  restarted.appendLog({ kind: 'app-start', version: '0.4.6', packaged: true });
  restarted.setDormancy({ dormant: [WORKER], archived: [] });
  await restarted.ensureAgent(meta);
  assertFiled(restarted, stale, original);
  assert.deepEqual(restarted.inbox(WORKER).map((m) => m.id), [work.id]);
});

test('ending a shutdown expires its fresh unread broadcast before the next card wake', async (t) => {
  const { hive, ct, meta } = await floor(t);
  ct.start();
  const stale = mail(hive, WRAP_SUBJECT, 0, WRAP_BODY, { to: 'broadcast' });
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  ct.cancel();
  const spawned = await hive.ensureAgent(meta);
  assert.doesNotMatch((spawned.kickoff ?? ''), new RegExp(stale.id));
  assertFiled(hive, stale, original);
  assert.equal(ct.wakeMode(WORKER), 'normal');
});

test('an open shutdown still delivers a fresh broadcast and injects closing instructions', async (t) => {
  const { hive, ct } = await floor(t);
  ct.start();
  const brief = mail(hive, WRAP_SUBJECT, 0, WRAP_BODY, { to: 'broadcast' });
  const original = fs.readFileSync(inboxPath(hive, brief), 'utf8');
  assert.ok(hive.inbox(WORKER).some((m) => m.id === brief.id));
  assert.match(hive.drainForStop(WORKER).reason, /office is shutting down/);
  assert.equal(fs.readFileSync(inboxPath(hive, brief), 'utf8'), original);
  assert.equal(fs.existsSync(inboxPath(hive, brief, true)), false);
  const queued = inboxNudgeText([brief.id]);
  const delivered = nudgeForWakeMode(queued, ct.wakeMode(WORKER), [brief.id], 'worker');
  assert.equal(isClosingNudge(delivered), true);
  assert.match(delivered, /Do not start, resume or accept any other work or card/);
});

test('two-hour expiry applies even if a shutdown remains open', async (t) => {
  const { hive, ct } = await floor(t);
  ct.start();
  const stale = mail(hive, WRAP_SUBJECT, TWO_HOURS + 1);
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  hive.inbox(WORKER);
  assertFiled(hive, stale, original);
});

test('ordinary mail and protocol reports are never expired just for mentioning wrap-up', async (t) => {
  const { hive, meta } = await floor(t);
  const messages = [
    mail(hive, 'Inventory mockup', TWO_HOURS + 1, 'The old WRAP UP request parked my card; please investigate.'),
    mail(hive, 'WRAP-UP-ACK', TWO_HOURS + 1, 'State saved.', { act: 'inform' }),
    mail(hive, 'WRAP-UP-COMPLETE', TWO_HOURS + 1, 'Shutdown report.', { act: 'inform' }),
    mail(hive, 'WRAP-UP CANCELLED', TWO_HOURS + 1, 'Resume normal operation.', { act: 'inform' })
  ];
  const originals = messages.map((m) => fs.readFileSync(inboxPath(hive, m), 'utf8'));
  hive.setDormancy({ dormant: [WORKER], archived: [] });
  await hive.ensureAgent(meta);
  for (const [i, m] of messages.entries()) assert.equal(fs.readFileSync(inboxPath(hive, m), 'utf8'), originals[i]);
  assert.equal(hive.inbox(WORKER).length, messages.length);
});

test('a persisted closing nudge loses its shutdown prohibition after restart', async (t) => {
  const { hive, ct } = await floor(t);
  ct.start();
  const queued = inboxNudgeText(['old-brief'], 'worker', true);
  const restarted = new ClosingTimeController(hive, () => [BOSS, WORKER], () => null, () => {});
  const delivered = nudgeForWakeMode(queued, restarted.wakeMode(WORKER), ['new-work'], 'worker');
  assert.equal(isClosingNudge(delivered), false);
  assert.doesNotMatch(delivered, /Do not start, resume or accept any other work or card/);
  assert.match(delivered, /new-work/);
});

test('a quota-held worker is counted as ACKed by timeout and its unread order is filed', async (t) => {
  const { hive, ct, held, events } = await floor(t);
  ct.start();
  const stale = mail(hive);
  const original = fs.readFileSync(inboxPath(hive, stale), 'utf8');
  held.add(WORKER);
  t.mock.timers.tick(DEFAULT_TIMINGS.closingTimeoutMs + 1);
  assert.equal(ct.isAcked(WORKER), true, 'a provider that refuses turns cannot leave the worker perpetually pending');
  assert.equal(ct.wakeMode(WORKER), 'skip');
  assert.ok(events.some((ev) => ev.acked === 1 && ev.total === 1), 'shutdown progress must include the timeout acknowledgement');
  assertFiled(hive, stale, original);
});

test('the deadline names a silent worker and concludes without inventing an ACK', async (t) => {
  const { hive, ct, events } = await floor(t);
  ct.start();
  const brief = mail(hive);
  t.mock.timers.tick(DEFAULT_TIMINGS.closingTimeoutMs + 1);
  assert.equal(ct.isAcked(WORKER), false);
  assert.ok(events.some((ev) => ev.phase === 'timeout' && ev.missing.some((worker) => worker.id === WORKER)));
  assert.equal(events.at(-1).phase, 'complete');
  assert.ok(hive.logTail(100).some((entry) => entry.kind === 'closing-time-timeout' && entry.missing?.some((worker) => worker.id === WORKER)));
  assert.ok(!hive.inbox(WORKER).some((m) => m.id === brief.id));
});

for (const [label, config, setup, expected] of [
  ['live Codex worker with an invalid cwd', { provider: 'codex', cwd: '/missing/md-wrapup-cwd' }, () => {}, /cwd|Codex/i],
  ['live Codex worker with a valid cwd', { provider: 'codex' }, () => {}, /Codex/i],
  ['live Claude worker with an invalid cwd', { cwd: '/missing/md-wrapup-cwd' }, () => {}, /cwd/i],
  ['worker with an open card and no live session', {}, ({ hive, live }) => {
    live.delete(WORKER);
    hive.writeTasks([{ id: 'open', title: 'Open', status: 'doing', assignee: WORKER, dependsOn: [], createdAt: new Date().toISOString() }]);
  }, /no live process/i],
  ['archived worker with a lingering live session', {}, ({ hive }) => hive.setDormancy({ dormant: [], archived: [WORKER] }), null],
]) {
  test(`wrap-up can conclude immediately with ${label}`, async (t) => {
    const state = await floor(t, config);
    const { ct, hive, events } = state;
    setup(state);
    assert.equal(ct.start().ok, true);
    if (expected) {
      assert.equal(ct.isAcked(WORKER), true);
      assert.match(events.at(-1).excused[0].reason, expected);
    } else {
      assert.equal(events.at(-1).total, 0);
    }
    ct.onRouted({ subject: 'WRAP-UP-COMPLETE', from: BOSS }, ['human']);
    assert.equal(events.at(-1).phase, 'complete');
  });
}

test('a new closing session preserves its own brief and files the previous session brief', async (t) => {
  const { hive, ct } = await floor(t);
  ct.start();
  const previous = mail(hive);
  const original = fs.readFileSync(inboxPath(hive, previous), 'utf8');
  ct.cancel();
  t.mock.timers.tick(1);
  ct.start();
  const current = mail(hive);
  const pending = hive.inbox(WORKER);
  assertFiled(hive, previous, original);
  assert.deepEqual(pending.map((m) => m.id), [current.id]);
  assert.equal(ct.wakeMode(WORKER), 'closing', 'the new live shutdown still reaches this worker');
});
