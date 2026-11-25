'use strict';

/**
 * Codex agents leave no Claude transcript, so fleet.json showed them at 0 tokens and
 * "no activity yet" and the no-progress watchdog fired on agents that were committing.
 * Their activity is read from the rollout file Codex appends to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { codexUsageSample, codexActivityFromTail, codexRolloutPath } = loadTs('src/main/codexUsage.ts');
const { NoProgressWatch, noProgressReason } = loadTs('src/main/quotaWatch.ts');

const SID = '01a1f53c-86fd-7b70-b4f9-9cbb26bddab7';
const line = (ts, type, payload) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload });
const tokens = (ts, input, cached, output) => line(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });

function rollout(nowMs, lines, sid = SID) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-act-'));
  const d = new Date(nowMs), p = (n) => String(n).padStart(2, '0');
  const dir = path.join(home, 'sessions', String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-11-19T13-16-00-${sid}.jsonl`), lines.join('\n') + '\n');
  return home;
}

test('a Codex rollout yields tokens, last tool and last-active time', () => {
  const now = Date.now();
  const home = rollout(now, [
    tokens(now - 90_000, 1000, 400, 50),
    line(now - 60_000, 'response_item', { type: 'custom_tool_call', name: 'exec' }),
    tokens(now - 30_000, 3000, 2000, 120),
  ]);
  const s = codexUsageSample('birch', 'codex', SID, null, now, home);
  assert.equal(s.input, 1000);
  assert.equal(s.cacheRead, 2000);
  assert.equal(s.output, 120);
  assert.equal(s.lastTool, 'exec');
  assert.equal(s.ts, now - 30_000);
});

test('only codex agents with a well-formed session id are read', () => {
  const now = Date.now();
  const home = rollout(now, [tokens(now, 10, 0, 1)]);
  assert.equal(codexUsageSample('a', 'claude', SID, null, now, home), undefined);
  assert.equal(codexUsageSample('a', 'codex', undefined, null, now, home), undefined);
  assert.equal(codexRolloutPath('../../etc/passwd', [path.join(home, 'sessions')], now), null);
  assert.equal(codexUsageSample('a', 'codex', '00000000-0000-0000-0000-000000000000', null, now, home), undefined);
});

test('a cut first line and garbage lines are skipped', () => {
  const a = codexActivityFromTail(['rate_limits":{}}}', 'not json', tokens(5000, 10, 4, 2)].join('\n'), 1);
  assert.deepEqual([a.input, a.cacheRead, a.output, a.ts], [6, 4, 2, 5000]);
  assert.equal(codexActivityFromTail('', 1), null);
});

test('the watchdog stays quiet while rollout events keep changing the token total, and fires once they stop', () => {
  const watch = new NoProgressWatch();
  const t0 = Date.now();
  let fired = false;
  // Same bookkeeping index.ts does: activity moves whenever the token total moves.
  let last = -1, at = 0;
  const activity = (total, now) => { if (total !== last) { last = total; at = now; } return at; };
  for (let m = 0; m <= 30; m++) {
    const now = t0 + m * 60_000;
    fired = watch.check('birch', true, activity(1000 + m * 500, now), now) || fired;
  }
  assert.equal(fired, false);
  let stopped = false;
  for (let m = 31; m <= 45; m++) {
    const now = t0 + m * 60_000;
    stopped = watch.check('birch', true, activity(1000 + 30 * 500, now), now) || stopped;
  }
  assert.equal(stopped, true);
});

test('an unreadable Codex rollout is reported as unknown, not as no activity', () => {
  assert.match(noProgressReason('codex', false), /activity unknown \(codex\)/);
  assert.equal(noProgressReason('codex', true), 'no model activity');
  assert.equal(noProgressReason('claude', false), 'no model activity');
});

test('the roster says unknown rather than "no activity yet" for such a row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');
  assert.match(src, /a\.activityUnknown \? 'activity unknown' : 'no activity yet'/);
});
