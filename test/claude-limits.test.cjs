'use strict';

/**
 * The title-bar limits chip showed a 7d reading five hours stale (2% while the
 * account sat at 7%) and no 5h at all: the only session writing a status-line
 * file had `rate_limits: null`, so the chip kept the last one that did not.
 * The usage endpoint's limits.json had the right numbers the whole time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle() {} } } };

const { readClaudeLimits } = loadTs('src/main/claudeLimits.ts');

function withCache(files) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'md-limits-'));
  const dir = path.join(runtime, 'cc-usage');
  fs.mkdirSync(dir);
  const now = Date.now() / 1000;
  for (const [name, body, ageSec] of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(body));
    fs.utimesSync(p, now - ageSec, now - ageSec);
  }
  process.env.XDG_RUNTIME_DIR = runtime;
}

const endpoint = {
  five_hour: { utilization: 0.0, resets_at: '2026-09-28T09:20:00.222452+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-10-04T17:00:00.222514+00:00' }
};

test('a fresher endpoint reading beats an old session reading and a null one', () => {
  withCache([
    ['old.json', { rate_limits: { seven_day: { used_percentage: 2, resets_at: 1791133200 } } }, 5 * 3600],
    ['null.json', { rate_limits: null }, 60],
    ['limits.json', endpoint, 30]
  ]);
  const got = readClaudeLimits();
  assert.equal(got.sevenDay.percent, 7);
  assert.equal(got.fiveHour.percent, 0);
  assert.equal(got.fiveHour.resetsAt, Math.floor(Date.parse('2026-09-28T09:20:00Z') / 1000));
});

test('a newer session reading beats a stale endpoint', () => {
  withCache([
    ['limits.json', endpoint, 3600],
    ['s.json', { rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 9 } } }, 10]
  ]);
  const got = readClaudeLimits();
  assert.equal(got.fiveHour.percent, 40);
  assert.equal(got.sevenDay.percent, 9);
});

test('an endpoint error body falls back to the session files', () => {
  withCache([
    ['limits.json', { error: { type: 'rate_limit_error' } }, 5],
    ['s.json', { rate_limits: { seven_day: { used_percentage: 3 } } }, 600]
  ]);
  assert.equal(readClaudeLimits().sevenDay.percent, 3);
});

test('no cache directory hides the chip', () => {
  process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'md-limits-empty-'));
  assert.equal(readClaudeLimits(), null);
});

test('a Status payload rate_limits feeds the chip and a null one does not erase it', () => {
  const { noteLiveRateLimits } = loadTs('src/main/claudeLimits.ts');
  withCache([['limits.json', endpoint, 3600]]);
  noteLiveRateLimits({ five_hour: { used_percentage: 33, resets_at: 1791133200 }, seven_day: { used_percentage: 12 } });
  noteLiveRateLimits(null);
  noteLiveRateLimits({});
  const got = readClaudeLimits();
  assert.equal(got.fiveHour.percent, 33);
  assert.equal(got.sevenDay.percent, 12);
});
