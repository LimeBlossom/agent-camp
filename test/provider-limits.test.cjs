'use strict';

// Reset times are local clock times; pin the zone the live refusal was written in.
process.env.TZ = 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  agyRefusal, applyExhaustion, claudeLimitHit, codexLimitHit, hitUntil, isExhausted, limitDecision,
  noteExhaustion, parseResetTime, spentUntil, UNKNOWN_RESET_MS
} = loadTs('src/main/providerLimits.ts');
const { balanceEngines, engineFor, limitSwitchPick, readEngine } = loadTs('src/main/engineChoice.ts');
const { agyPoolWindows, parseAgyQuota } = loadTs('src/main/agyQuotaParse.ts');
const fs = require('node:fs');
const path = require('node:path');
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const { deliveryHeldByLimit, limitResumeText } = loadTs('src/shared/limitHold.ts');

// Verbatim from a live rollout (curly apostrophe included).
const CODEX_MSG = 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:08 AM.';
const refusal = (ts, msg = CODEX_MSG) => JSON.stringify({
  timestamp: ts, type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: null, error: { message: msg, codex_error_info: 'usage_limit_exceeded' } }
});
const success = (ts) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } });

test('the live Codex refusal is detected and its reset is the next 1:08 AM after it', () => {
  const hit = codexLimitHit([success('2026-10-02T05:30:00.000Z'), refusal('2026-10-02T05:40:34.945Z')].join('\n'));
  assert.ok(hit);
  assert.equal(hit.atMs, Date.parse('2026-10-02T05:40:34.945Z'));
  assert.equal(hit.resetAtMs, Date.parse('2026-10-02T06:08:00.000Z'));
  assert.match(hit.message, /You’ve hit your usage limit/);
});

test('the straight-apostrophe spelling and the bare "error" event are detected too', () => {
  const msg = "You've hit your usage limit. Try again at 3:15 PM.";
  const line = JSON.stringify({ timestamp: '2026-10-02T05:00:00.000Z', type: 'event_msg', payload: { type: 'error', message: msg } });
  const hit = codexLimitHit(line);
  assert.equal(new Date(hit.resetAtMs).getHours(), 15);
  assert.equal(new Date(hit.resetAtMs).getMinutes(), 15);
});

test('a later successful turn clears an earlier refusal', () => {
  assert.equal(codexLimitHit([refusal('2026-10-02T05:40:00.000Z'), success('2026-10-02T06:10:00.000Z')].join('\n')), null);
});

test('a refusal with no time holds for UNKNOWN_RESET_MS', () => {
  const hit = codexLimitHit(refusal('2026-10-02T05:40:00.000Z', 'You’ve hit your usage limit.'));
  assert.equal(hit.resetAtMs, undefined);
  assert.equal(hitUntil(hit), hit.atMs + UNKNOWN_RESET_MS);
});

test('reset forms: next-day clock, dated, relative, epoch', () => {
  const at = new Date(2026, 9, 2, 23, 0).getTime();
  assert.equal(parseResetTime('try again at 1:08 AM.', at), new Date(2026, 9, 3, 1, 8).getTime());
  assert.equal(parseResetTime('try again at Oct 5th, 2026 1:08 AM.', at), new Date(2026, 9, 5, 1, 8).getTime());
  assert.equal(parseResetTime('try again in 2 hours 5 minutes.', at), at + 2 * 3_600_000 + 5 * 60_000);
  assert.equal(parseResetTime('Claude AI usage limit reached|1790921280', at), 1790921280000);
  assert.equal(parseResetTime('5-hour limit reached ∙ resets 3am', at), new Date(2026, 9, 3, 3, 0).getTime());
  assert.equal(parseResetTime('no time here', at), undefined);
});

test('a Claude Code limit message flagged as an API error is detected; a context error is not', () => {
  const rec = (text, extra = {}) => JSON.stringify({
    type: 'assistant', timestamp: '2026-10-02T05:00:00.000Z', isApiErrorMessage: true,
    message: { content: [{ type: 'text', text }] }, ...extra
  });
  const hit = claudeLimitHit(rec("You've hit your limit · resets 1am (America/Chicago)"));
  assert.ok(hit);
  assert.equal(new Date(hit.resetAtMs).getHours(), 1);
  assert.equal(claudeLimitHit(rec('Context limit reached · /compact or /clear to continue')), null);
  const reply = JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T07:00:00.000Z', message: { content: [{ type: 'text', text: 'back at it' }] } });
  assert.equal(claudeLimitHit([rec('Claude AI usage limit reached|1790921280'), reply].join('\n')), null);
});

test('a meter at 100% is spent until its reset; a past reset or 99% is not', () => {
  const now = 1_000_000;
  assert.equal(spentUntil([{ percent: 100, resetsAtMs: now + 5000 }, { percent: 40, resetsAtMs: now + 9e6 }], now), now + 5000);
  assert.equal(spentUntil([{ percent: 100, resetsAtMs: now - 1 }], now), undefined);
  assert.equal(spentUntil([{ percent: 99, resetsAtMs: now + 5000 }], now), undefined);
});

test('an exhausted engine reads full, so the balancer skips it despite a stale low reading', () => {
  const now = 1_000_000;
  const map = {};
  noteExhaustion(map, 'codex', now + 3_600_000, 'refusal', now);
  noteExhaustion(map, 'claude', now - 1, 'past', now);
  assert.equal(isExhausted(map, 'codex', now), true);
  assert.equal(isExhausted(map, 'claude', now), false);
  const readings = applyExhaustion({ codex: { percent: 20 }, claude: { percent: 50 } }, map, now);
  assert.deepEqual(readings.codex, { percent: 100, roomAtMs: now + 3_600_000 });
  const cands = [{ engine: 'codex', label: 'codex/default' }, { engine: 'claude', label: 'claude/default' }];
  assert.equal(balanceEngines(cands, readings, now).index, 1);
});

test('switch decision: an allowed entry on another engine with room means switch', () => {
  const now = 1_000_000;
  const map = { codex: { untilMs: now + 60_000, source: 'x' } };
  const cands = [{ engine: 'codex', label: 'codex/a' }, { engine: 'claude', label: 'claude/b' }];
  const pick = balanceEngines(cands, applyExhaustion({}, map, now), now);
  assert.deepEqual(limitDecision('codex', cands, pick, map, now), { kind: 'switch', index: 1 });
});

test('switch decision: nothing else, another model on the same meter, or everything out means wait until reset', () => {
  const now = 1_000_000;
  const map = { codex: { untilMs: now + 60_000, source: 'x' }, claude: { untilMs: now + 120_000, source: 'y' } };
  const one = [{ engine: 'codex', label: 'codex/a' }];
  assert.deepEqual(limitDecision('codex', one, { index: 0 }, map, now), { kind: 'wait', untilMs: now + 60_000 });
  const sameMeter = [{ engine: 'codex', label: 'codex/a' }, { engine: 'codex', label: 'codex/b' }];
  assert.equal(limitDecision('codex', sameMeter, { index: 1 }, map, now).kind, 'wait');
  const both = [{ engine: 'codex', label: 'codex/a' }, { engine: 'claude', label: 'claude/b' }];
  const pick = balanceEngines(both, applyExhaustion({}, map, now), now);
  assert.equal(limitDecision('codex', both, pick, map, now).kind, 'wait');
  assert.equal(limitDecision('codex', [both[0], { engine: 'agy', label: 'agy' }], { index: 1 }, map, now, false).kind, 'wait');
  assert.deepEqual(limitDecision('agy', both, { index: 0 }, map, now), { kind: 'ok' });
});

test('nudge suppression: a held agent gets nothing automatic, only a "send now" message', () => {
  const waits = { hazel: { provider: 'codex', resetAtMs: 1 } };
  assert.equal(deliveryHeldByLimit(waits, 'hazel', undefined), true);
  assert.equal(deliveryHeldByLimit(waits, 'hazel', false), true);
  assert.equal(deliveryHeldByLimit(waits, 'hazel', true), false);
  assert.equal(deliveryHeldByLimit(waits, 'other', undefined), false);
  assert.match(limitResumeText('codex'), /codex usage limit has reset/);
});

// Raw PTY bytes agy 1.2.14 printed for a turn refused by the spent Claude pool.
const AGY_PTY = fixture('agy-refusal.pty.txt');

test('agy\'s refusal is read off its raw terminal output with its reset and error id', () => {
  assert.deepEqual(agyRefusal(AGY_PTY), {
    message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h16m24s.',
    errorId: '5d4a33c7-5290-407f-8ec9-84f0bb8be1c1-1',
    resetInMs: ((4 * 60 + 16) * 60 + 24) * 1000
  });
});

test('agy refusal: a half-printed line, or the text quoted without the warning sign, is not one', () => {
  assert.equal(agyRefusal(AGY_PTY.slice(0, AGY_PTY.indexOf('limits.'))), null);
  assert.equal(agyRefusal("  const msg = 'Individual quota reached. Please upgrade. Resets in 4h.';\n"), null);
  assert.equal(agyRefusal('> ⚠ is what agy prints\n'), null);
  const noId = agyRefusal('⚠ Individual quota reached. Please upgrade your subscription to increase your limits.\n');
  assert.equal(noId.errorId, undefined);
  assert.equal(noId.resetInMs, undefined);
});

test('Birch on agy-claude with [codex, agy-claude]: the spent panel switches it to codex at 49%', () => {
  const now = 1_790_000_000_000;
  const q = parseAgyQuota(fixture('agy-quota-exhausted.screen.txt'), now);
  const windows = agyPoolWindows(q.pools.find((p) => p.label === 'claude'), now);
  const map = {};
  noteExhaustion(map, 'agy-claude', spentUntil(windows, now), 'agy-claude meter at 100%', now);
  assert.equal(map['agy-claude'].untilMs, now + (4 * 60 + 18) * 60_000);
  const readings = applyExhaustion({ codex: { percent: 49 }, 'agy-claude': readEngine(windows, now) }, map, now);
  const list = [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'antigravity', model: 'claude-opus-5-5-high' }];
  const cands = list.map((e) => ({ engine: engineFor(e.provider, e.model), label: `${e.provider}/${e.model}` }));
  const current = engineFor('antigravity', 'claude-opus-5-5-high');
  assert.equal(current, 'agy-claude');
  const pick = balanceEngines(cands, readings, now);
  assert.deepEqual(limitDecision(current, cands, pick, map, now), { kind: 'switch', index: 0 });
});

test('the same switch follows from a terminal refusal alone, before any probe', () => {
  const now = 1_790_000_000_000;
  const r = agyRefusal(AGY_PTY);
  const hit = { atMs: now, message: r.message, resetAtMs: now + r.resetInMs };
  const map = {};
  noteExhaustion(map, 'agy-claude', hitUntil(hit), 'birch', now);
  const cands = [{ engine: 'codex', label: 'codex/gpt-6.1-sol' }, { engine: 'agy-claude', label: 'antigravity/Claude Opus 4.6 (Thinking)' }];
  const readings = applyExhaustion({ codex: { percent: 49 }, 'agy-claude': { percent: 3 } }, map, now);
  assert.deepEqual(limitDecision('agy-claude', cands, balanceEngines(cands, readings, now), map, now), { kind: 'switch', index: 0 });
});

// Live 2026-10-02 10:38: codex refused, agy's Claude pool at 100%, Claude at 89%. The
// agent was held although Claude had room for a session.
const NOW = Date.parse('2026-10-02T15:38:09.000Z');
const LIST = [
  { engine: 'codex', label: 'codex/gpt-6.1-sol' },
  { engine: 'agy-claude', label: 'antigravity/Claude Opus 4.6 (Thinking)' },
  { engine: 'claude', label: 'claude/claude-opus-5-5[1m]' }
];
const spentMap = (engines) => {
  const map = {};
  for (const e of engines) noteExhaustion(map, e, NOW + 3600_000, `${e} spent`, NOW);
  return map;
};
const liveReadings = (map, claude = 89) => applyExhaustion({
  codex: { percent: 100, roomAtMs: NOW + 3600_000 },
  'agy-claude': { percent: 100, roomAtMs: NOW + 3600_000 },
  claude: { percent: claude, roomAtMs: NOW + 4 * 3600_000 }
}, map, NOW);

test('a spent engine switches to an entry at 89% rather than holding', () => {
  const map = spentMap(['codex', 'agy-claude']);
  const pick = limitSwitchPick(LIST, liveReadings(map), NOW);
  assert.deepEqual(limitDecision('codex', LIST, pick, map, NOW, true), { kind: 'switch', index: 2 });
});

test('the switch prefers an entry under the full line by the balancer order', () => {
  const map = spentMap(['codex']);
  const readings = applyExhaustion({ 'agy-claude': { percent: 60 }, claude: { percent: 89 } }, map, NOW);
  assert.equal(limitSwitchPick(LIST, readings, NOW).index, 1);
});

test('every entry spent: the agent holds', () => {
  const map = spentMap(['codex', 'agy-claude', 'claude']);
  const pick = limitSwitchPick(LIST, liveReadings(map, 100), NOW);
  assert.equal(limitDecision('codex', LIST, pick, map, NOW, true).kind, 'wait');
});

test('a fresh start never picks a spent entry while one is not spent', () => {
  const map = spentMap(['codex', 'agy-claude']);
  // codex resets soonest, but it is spent; Claude at 89% is the only one that can run.
  assert.equal(balanceEngines(LIST, liveReadings(map), NOW).index, 2);
  // All spent: soonest reset still decides.
  const all = spentMap(['codex', 'agy-claude', 'claude']);
  assert.ok(balanceEngines(LIST, liveReadings(all, 100), NOW));
});
