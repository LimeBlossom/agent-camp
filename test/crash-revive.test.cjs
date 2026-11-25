'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { CrashTracker, crashNotice, CRASH_WINDOW_MS, CRASH_MAX_IN_WINDOW, CRASH_BACKOFF_BASE_MS } = loadTs('src/main/crashRevive.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

test('each crash doubles the hold on automatic wakes, and the cap stops them', () => {
  const t = new CrashTracker();
  const t0 = 1_000_000;
  const first = t.record('w', t0);
  assert.deepEqual(first, { revive: true, crashesInWindow: 1, backoffMs: CRASH_BACKOFF_BASE_MS });
  assert.equal(t.held('w', t0 + CRASH_BACKOFF_BASE_MS - 1), true);
  assert.equal(t.held('w', t0 + CRASH_BACKOFF_BASE_MS), false);
  assert.equal(t.record('w', t0 + 60_000).backoffMs, 2 * CRASH_BACKOFF_BASE_MS);
  const capped = t.record('w', t0 + 120_000);
  assert.equal(CRASH_MAX_IN_WINDOW, 3);
  assert.equal(capped.revive, false);
  assert.equal(t.held('w', t0 + 10 * CRASH_WINDOW_MS), true, 'held until someone asks for it');
  assert.equal(t.held('other', t0), false);
});

test('crashes outside the window are forgotten, and a wake request clears the hold', () => {
  const t = new CrashTracker();
  t.record('w', 0);
  t.record('w', 1000);
  assert.equal(t.record('w', CRASH_WINDOW_MS + 2000).crashesInWindow, 1);
  t.record('w', CRASH_WINDOW_MS + 3000);
  t.record('w', CRASH_WINDOW_MS + 4000);
  assert.equal(t.held('w', 99 * CRASH_WINDOW_MS), true);
  t.clear('w');
  assert.equal(t.held('w', 99 * CRASH_WINDOW_MS), false);
  assert.equal(t.record('w', 99 * CRASH_WINDOW_MS).crashesInWindow, 1);
});

test('the boss notice says whether the worker restarts by itself', () => {
  const revive = crashNotice('Hazel', 'g1', 2, 0, { revive: true, crashesInWindow: 1, backoffMs: 30_000 });
  assert.equal(revive.subject, 'Agent Hazel crashed (exit code 2)');
  assert.match(revive.body, /restarts on its next todo\/doing card or direct mail after 30 s/);
  const stop = crashNotice('Hazel', 'g1', 0, 11, { revive: false, crashesInWindow: 3, backoffMs: Infinity });
  assert.equal(stop.subject, 'Agent Hazel crashed (signal 11)');
  assert.match(stop.body, /will NOT restart on its own.*wake-requests\/g1\.json/);
});

test('recordAgentExit reports whether the exit was abnormal', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-crash-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  assert.equal(hive.recordAgentExit('w1', { exitCode: 0 }), false);
  assert.equal(hive.recordAgentExit('w1', { exitCode: 2 }), true);
  assert.equal(hive.recordAgentExit('w1', { exitCode: 0, signal: 9 }), true);
  await hive.flushCommits();
});

test('a wake request the floor could not act on moves from .done to .failed with the reason', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wakefail-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'claude', cwd: home });
  const dir = path.join(home, 'hive', 'wake-requests');
  fs.mkdirSync(path.join(dir, '.done'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.done', 'w1.json'), JSON.stringify({ reason: 'resume', handledAt: 'x' }));
  assert.equal(hive.failWakeRequest('w1', 'the worker is not on this floor'), true);
  assert.equal(fs.existsSync(path.join(dir, '.done', 'w1.json')), false);
  const failed = JSON.parse(fs.readFileSync(path.join(dir, '.failed', 'w1.json'), 'utf8'));
  assert.equal(failed.reason, 'resume');
  assert.equal(failed.error, 'the worker is not on this floor');
  assert.equal(hive.failWakeRequest('../x', 'no'), false);
  await hive.flushCommits();
});
