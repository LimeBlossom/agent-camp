const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { passesContextPressure } = loadTs('src/shared/contextPressure.ts');
const rule = { enabled: true, everyMs: 3600000, minContextPct: 60, minContextPctLargeWindow: 25, bossMinContextTokens: 120000, message: '' };

test('Boss absolute gate fires at 120k independently of window and worker percentage', () => {
  for (const contextLimit of [200000, 1000000, undefined]) {
    assert.equal(passesContextPressure({ isGod: true, contextTokens: 119999, contextLimit }, rule), false);
    assert.equal(passesContextPressure({ isGod: true, contextTokens: 120000, contextLimit }, rule), true);
  }
});
test('worker gate retains its 25% large-window and 60% small-window thresholds', () => {
  for (const [contextLimit, threshold] of [[1000000, 250000], [200000, 120000]]) {
    assert.equal(passesContextPressure({ isGod: false, contextTokens: threshold - 1, contextLimit }, rule), false);
    assert.equal(passesContextPressure({ isGod: false, contextTokens: threshold, contextLimit }, rule), true);
  }
});
test('absolute gate waits for a token reading; workers retain time-only fallback', () => {
  for (const contextTokens of [undefined, NaN]) {
    assert.equal(passesContextPressure({ isGod: true, contextTokens }, rule), false);
    assert.equal(passesContextPressure({ isGod: false, contextTokens }, rule), true);
  }
});
test('absent, zero or invalid override retains previous Boss percentage behavior', () => {
  for (const bossMinContextTokens of [undefined, 0, -1, NaN, Infinity]) {
    assert.equal(passesContextPressure({ isGod: true, contextTokens: 120000, contextLimit: 1000000 }, { ...rule, bossMinContextTokens }), false);
    assert.equal(passesContextPressure({ isGod: true, contextTokens: 250000, contextLimit: 1000000 }, { ...rule, bossMinContextTokens }), true);
  }
});
test('unknown worker windows still use model inference; zero percent disables pressure', () => {
  assert.equal(passesContextPressure({ contextTokens: 119999, model: 'opus[1m]' }, rule), false);
  assert.equal(passesContextPressure({ contextTokens: 600000, model: 'opus[1m]' }, rule), true);
  assert.equal(passesContextPressure({ contextTokens: 1 }, { ...rule, minContextPct: 0 }), true);
});
