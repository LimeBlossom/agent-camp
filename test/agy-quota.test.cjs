'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { classifyAgyScreen, parseAgyQuota, bindingRemaining, agyPoolWindows } = loadTs('src/main/agyQuotaParse.ts');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', `agy-${n}.screen.txt`), 'utf8');

test('each captured agy 1.2.14 screen is recognised', () => {
  assert.equal(classifyAgyScreen(fixture('ready')), 'ready');
  assert.equal(classifyAgyScreen(fixture('trust')), 'trust');
  assert.equal(classifyAgyScreen(fixture('menu-quota')), 'menu-quota');
  assert.equal(classifyAgyScreen(fixture('menu-exit')), 'menu-exit');
  assert.equal(classifyAgyScreen(fixture('quota')), 'quota');
  assert.equal(classifyAgyScreen('Update available! Press enter to install'), 'unknown');
  assert.equal(classifyAgyScreen(''), 'unknown');
});

test('the /quota panel parses into both pools with weekly and 5-hour windows', () => {
  const q = parseAgyQuota(fixture('quota'), 123);
  assert.deepEqual(q, {
    at: 123,
    pools: [
      { name: 'GEMINI MODELS', label: 'gem',
        weekly: { remaining: 86.09, note: 'Refreshes in 72h 46m' },
        fiveHour: { remaining: 88.57, note: 'Refreshes in 20m' } },
      { name: 'CLAUDE AND GPT MODELS', label: 'claude',
        weekly: { remaining: 100, note: 'Quota available' },
        fiveHour: { remaining: 100, note: 'Quota available' } }
    ]
  });
  assert.equal(bindingRemaining(q.pools[0]), 86.09);
  assert.ok(!JSON.stringify(q).includes('@'), 'the account line is never carried');
});

test('a partial or absent panel is no reading', () => {
  const text = fixture('quota');
  assert.equal(parseAgyQuota(text.slice(0, text.indexOf('CLAUDE AND GPT MODELS')), 1), null);
  assert.equal(parseAgyQuota(fixture('ready'), 1), null);
  assert.equal(parseAgyQuota(fixture('menu-quota'), 1), null);
});

test('refreshInMs reads agy refresh notes', () => {
  const { refreshInMs } = loadTs('src/main/agyQuotaParse.ts');
  assert.equal(refreshInMs('Refreshes in 72h 46m'), (72 * 60 + 46) * 60_000);
  assert.equal(refreshInMs('Refreshes in 1d 2h'), 26 * 3_600_000);
  assert.equal(refreshInMs('Quota available'), 0);
  assert.equal(refreshInMs(undefined), undefined);
  assert.equal(refreshInMs('Refreshes in soon'), undefined);
});

// Captured 2026-10-02 07:47 CDT while the Claude pool's 5-hour window was spent.
test('a spent Claude pool parses: 5-hour 0% with its refresh, weekly still 61%', () => {
  const { agyPoolWindows } = loadTs('src/main/agyQuotaParse.ts');
  const at = 1_790_000_000_000;
  const q = parseAgyQuota(fixture('quota-exhausted'), at);
  assert.equal(classifyAgyScreen(fixture('quota-exhausted')), 'quota');
  const claude = q.pools.find((p) => p.label === 'claude');
  assert.deepEqual(claude.fiveHour, { remaining: 0, note: 'Refreshes in 4h 18m' });
  assert.deepEqual(claude.weekly, { remaining: 61.22, note: 'Refreshes in 158h 4m' });
  assert.equal(bindingRemaining(claude), 0);
  assert.deepEqual(agyPoolWindows(claude, at), [
    { percent: 100, resetsAtMs: at + (4 * 60 + 18) * 60_000, lengthMs: 5 * 3_600_000 },
    { percent: 100 - 61.22, resetsAtMs: at + (158 * 60 + 4) * 60_000, lengthMs: 7 * 86_400_000 }
  ]);
  const gem = q.pools.find((p) => p.label === 'gem');
  assert.deepEqual(agyPoolWindows(gem, at)[0], { percent: 0, resetsAtMs: at, lengthMs: 5 * 3_600_000 });
});

test('durationMs reads agy\'s run-together refusal form and ignores words', () => {
  const { durationMs } = loadTs('src/shared/agyRefresh.ts');
  assert.equal(durationMs('4h16m24s'), ((4 * 60 + 16) * 60 + 24) * 1000);
  assert.equal(durationMs('72h 46m'), (72 * 60 + 46) * 60_000);
  assert.equal(durationMs('5 minutes'), undefined);
});

test('a pool whose weekly limit is spent shows no 5-hour bar and still parses', () => {
  const at = 1_000_000;
  const q = parseAgyQuota(fixture('quota-weekly-spent'), at);
  assert.ok(q, 'the reading must not be dropped');
  const claude = q.pools.find((p) => p.label === 'claude');
  assert.deepEqual(claude.weekly, { remaining: 0, note: 'Refreshes in 159h 0m' });
  assert.equal(claude.fiveHour, undefined);
  assert.equal(bindingRemaining(claude), 0);
  assert.deepEqual(agyPoolWindows(claude, at), [undefined, { percent: 100, resetsAtMs: at + 159 * 3_600_000, lengthMs: 7 * 86_400_000 }]);
  assert.equal(q.pools.find((p) => p.label === 'gem').fiveHour.remaining, 89.54);
});

// Layout rebuilt from the panel as read on 2026-10-22 00:45Z (agy 1.4): numbers and headings
// as agy printed them, bar widths and the Gemini 5-hour note filled in.
test('agy 1.4 Argon section parses as its own weekly-only pool', () => {
  const at = 1_792_630_000_000;
  const text = fixture('quota-argon');
  assert.equal(classifyAgyScreen(text), 'quota');
  const q = parseAgyQuota(text, at);
  assert.deepEqual(q.pools.map((p) => p.label), ['gem', 'claude', 'argon']);
  const argon = q.pools[2];
  assert.deepEqual(argon, { name: 'GEMINI 4 ARGON', label: 'argon', weekly: { remaining: 0, note: 'Refreshes in 50h 6m' } });
  assert.deepEqual(agyPoolWindows(argon, at), [undefined, { percent: 100, resetsAtMs: at + (50 * 60 + 6) * 60_000, lengthMs: 7 * 86_400_000 }]);
  assert.equal(q.pools[0].weekly.remaining, 89.36);
});

test('agy prints REMAINING; the windows carry percent USED', () => {
  const at = 1_792_630_000_000;
  const claude = parseAgyQuota(fixture('quota-argon'), at).pools.find((p) => p.label === 'claude');
  assert.deepEqual(claude.fiveHour, { remaining: 100, note: 'Quota available' });
  const [fiveHour, weekly] = agyPoolWindows(claude, at);
  assert.equal(fiveHour.percent, 0);
  assert.equal(Math.round(weekly.percent * 100) / 100, 75.34);
});

test('a panel cut before the Argon section still reads its two model pools', () => {
  const text = fixture('quota-argon');
  const q = parseAgyQuota(text.slice(0, text.indexOf('GEMINI 4 ARGON')), 1);
  assert.deepEqual(q.pools.map((p) => p.label), ['gem', 'claude']);
});

test('a spent 5-hour window stops holding its engine once its own refresh time passes', () => {
  const { spentUntil } = loadTs('src/main/providerLimits.ts');
  const at = 1_000_000;
  const q = parseAgyQuota(fixture('quota-exhausted'), at);
  const windows = agyPoolWindows(q.pools.find((p) => p.label === 'claude'), at);
  const resetAt = at + (4 * 60 + 18) * 60_000;
  assert.equal(spentUntil(windows, at), resetAt);
  assert.equal(spentUntil(windows, resetAt - 1), resetAt);
  assert.equal(spentUntil(windows, resetAt), undefined);
});

test('a reading older than three probe intervals is no reading for engine choice', () => {
  const { agyQuotaForEngines, AGY_QUOTA_STALE_MS, AGY_PROBE_EVERY_MS } = loadTs('src/main/agyQuotaParse.ts');
  assert.equal(AGY_QUOTA_STALE_MS, 3 * AGY_PROBE_EVERY_MS);
  const at = 1_000_000;
  const q = parseAgyQuota(fixture('quota-exhausted'), at);
  assert.equal(agyQuotaForEngines(q, at), q);
  assert.equal(agyQuotaForEngines(q, at + AGY_QUOTA_STALE_MS), q);
  assert.equal(agyQuotaForEngines(q, at + AGY_QUOTA_STALE_MS + 1), null);
  assert.equal(agyQuotaForEngines(null, at), null);
});

test('probe failures reach log.jsonl once per reason, and the recovery once', () => {
  const { agyProbeLogEvent } = loadTs('src/main/agyQuotaParse.ts');
  const okAt = Date.UTC(2026, 9, 22, 0, 0, 0);
  assert.equal(agyProbeLogEvent(null, null, 0, okAt), null);
  assert.deepEqual(agyProbeLogEvent(null, 'agy did not reach its prompt (unknown)', 1, okAt),
    { kind: 'agy-quota-probe', ok: false, error: 'agy did not reach its prompt (unknown)', failures: 1, lastOk: '2026-10-22T00:00:00.000Z' });
  assert.equal(agyProbeLogEvent('agy did not reach its prompt (unknown)', 'agy did not reach its prompt (unknown)', 2, okAt), null);
  assert.deepEqual(agyProbeLogEvent('agy did not reach its prompt (unknown)', 'the /quota menu entry did not appear', 3, undefined),
    { kind: 'agy-quota-probe', ok: false, error: 'the /quota menu entry did not appear', failures: 3, lastOk: null });
  assert.deepEqual(agyProbeLogEvent('the /quota menu entry did not appear', null, 0, okAt),
    { kind: 'agy-quota-probe', ok: true, after: 'the /quota menu entry did not appear' });
});

test('agy pool windows feed readEngine with resetsAtMs so spendBeforeReset fires at 86% with 1h left', () => {
  const { readEngine } = loadTs('src/main/engineChoice.ts');
  const at = 1_792_800_000_000;
  const pool = {
    name: 'GEMINI MODELS',
    label: 'gem',
    weekly: { remaining: 14, note: 'Refreshes in 1h 0m' },
    fiveHour: { remaining: 95, note: 'Refreshes in 4h 45m' }
  };
  const windows = agyPoolWindows(pool, at);
  assert.equal(windows[1].percent, 86);
  assert.equal(windows[1].resetsAtMs, at + 3_600_000);
  assert.equal(windows[1].lengthMs, 7 * 86_400_000);

  const reading = readEngine(windows, at);
  assert.equal(reading.percent, 86);
  assert.equal(reading.spendBeforeReset, true);
  assert.equal(reading.resetInMs, 3_600_000);
  assert.equal(reading.lockoutMs, 0);
});
