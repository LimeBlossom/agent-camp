'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle() {} } } };

const { CodexLimitsReader, newestInText, parseRateLimitLine, recentDateDirs, withResets } = loadTs('src/main/codexLimits.ts');

function line(ts, p5, pw, { limitId = 'codex', reset5 = 2000000000, resetW = 2000500000 } = {}) {
  return JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: limitId,
      primary: { used_percent: p5, window_minutes: 300, resets_at: reset5 },
      secondary: { used_percent: pw, window_minutes: 10080, resets_at: resetW },
      credits: { balance: 'secret' }
    } }
  });
}

test('a rollout line yields both windows, matched by window length, and nothing else', () => {
  const r = parseRateLimitLine(line('2026-10-01T03:17:11.739Z', 4, 2));
  assert.deepEqual(r, {
    updatedAt: Date.parse('2026-10-01T03:17:11.739Z'),
    fiveHour: { percent: 4, windowMinutes: 300, resetsAt: 2000000000 },
    weekly: { percent: 2, windowMinutes: 10080, resetsAt: 2000500000 }
  });
  assert.ok(!JSON.stringify(r).includes('secret'), 'credits are never carried');
});

test('malformed, unrelated and other-limit lines are skipped', () => {
  for (const bad of ['', '{"rate_limits":', 'not json "rate_limits"', JSON.stringify({ timestamp: 'x', payload: { rate_limits: null } }),
    JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 1, window_minutes: 300 } } } }),
    line('2026-10-01T00:00:00Z', 1, 1, { limitId: 'other' }),
    JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', payload: { rate_limits: { primary: { used_percent: 'x', window_minutes: 300 } } } })]) {
    assert.equal(parseRateLimitLine(bad), null, bad);
  }
});

test('newest wins inside a tail whose first line was cut', () => {
  const text = line('2026-10-01T01:00:00Z', 9, 9).slice(20) + '\n' + line('2026-10-01T03:00:00Z', 3, 2) + '\n'
    + line('2026-10-01T02:00:00Z', 7, 7) + '\n{garbage\n';
  assert.equal(newestInText(text).fiveHour.percent, 3);
});

test('a window whose reset passed after the reading shows 0%, the other keeps its number', () => {
  const r = parseRateLimitLine(line('2026-10-01T03:00:00Z', 40, 20, { reset5: 1000, resetW: 2000500000 }));
  const now = withResets(r, 5000 * 1000);
  assert.deepEqual(now.fiveHour, { percent: 0, windowMinutes: 300, reset: true });
  assert.equal(now.weekly.percent, 20);
});

test('the reader takes the newest record across agents and the user CLI, once per real file', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-limits-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-10-01T12:00:00Z');
  const date = recentDateDirs(now)[0];
  const user = path.join(home, '.codex');
  const hive = path.join(home, 'hive');
  const write = (dir, name, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name); };
  write(path.join(user, 'sessions', date), 'rollout-a.jsonl', line('2026-10-01T10:00:00Z', 10, 5) + '\n');
  const agentSessions = path.join(user, 'sessions', 'munder-difflin', 'abc', 'pine');
  write(path.join(agentSessions, date), 'rollout-b.jsonl', line('2026-10-01T11:00:00Z', 30, 6) + '\n' + line('2026-10-01T09:00:00Z', 90, 90) + '\n');
  // The agent's CODEX_HOME links to the same tree; it must not double-count or break.
  fs.mkdirSync(path.join(hive, 'agents', 'pine', '.codex'), { recursive: true });
  fs.symlinkSync(agentSessions, path.join(hive, 'agents', 'pine', '.codex', 'sessions'));
  write(path.join(user, 'sessions', '2020', '01', '01'), 'rollout-old.jsonl', line('2026-10-01T11:59:00Z', 99, 99) + '\n');

  const reader = new CodexLimitsReader(user, () => hive);
  const r = reader.read(now);
  assert.equal(r.fiveHour.percent, 30, 'newest record wins; folders outside the recent days are not read');
  assert.equal(r.weekly.percent, 6);
  assert.equal(r.updatedAt, Date.parse('2026-10-01T11:00:00Z'));

  fs.appendFileSync(path.join(user, 'sessions', date, 'rollout-a.jsonl'), line('2026-10-01T11:30:00Z', 12, 7) + '\n');
  assert.equal(reader.read(now).fiveHour.percent, 12, 'a grown file is read again');
  assert.equal(new CodexLimitsReader(path.join(home, 'none'), () => null).read(now), null);
});
