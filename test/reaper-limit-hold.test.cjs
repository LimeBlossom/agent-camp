'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { advanceHoldClock, idleOutsideHold } = loadTs('src/shared/limitHold.ts');

const MIN = 60_000;
// One reaper tick: advance the clock, return the idle the reaper would compare to its timeout.
const tick = (s, held, idleMs, now) => {
  s.clock = advanceHoldClock(s.clock, held, idleMs, now);
  return idleOutsideHold(idleMs, s.clock);
};

test('a worker on limit-hold for 3 hours is not idle', () => {
  const s = { clock: { heldMs: 0 } };
  tick(s, true, 1 * MIN, 1 * MIN);
  assert.ok(tick(s, true, 181 * MIN, 181 * MIN) < 20 * MIN);
});

test('idle time before the hold still counts', () => {
  const s = { clock: { heldMs: 0 } };
  tick(s, false, 15 * MIN, 15 * MIN);
  tick(s, true, 16 * MIN, 16 * MIN);
  assert.equal(tick(s, true, 100 * MIN, 100 * MIN), 16 * MIN);
});

test('after the hold ends, only quiet time after it counts toward the timeout', () => {
  const s = { clock: { heldMs: 0 } };
  tick(s, true, 1 * MIN, 1 * MIN);
  tick(s, true, 121 * MIN, 121 * MIN);
  assert.equal(tick(s, false, 122 * MIN, 122 * MIN), 1 * MIN);
  assert.ok(tick(s, false, 145 * MIN, 145 * MIN) > 20 * MIN);
});

test('output during a hold resets the held time with the idle clock', () => {
  const s = { clock: { heldMs: 0 } };
  tick(s, true, 10 * MIN, 10 * MIN);
  tick(s, false, 1 * MIN, 60 * MIN);
  assert.equal(tick(s, false, 5 * MIN, 64 * MIN), 5 * MIN);
});

test('a worker that was never held reaps on plain idle time', () => {
  const s = { clock: { heldMs: 0 } };
  assert.equal(tick(s, false, 21 * MIN, 21 * MIN), 21 * MIN);
});
