'use strict';

process.env.TZ = 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { LimitLockNotices, limitLockText } = loadTs('src/main/providerLimits.ts');

const RESET = Date.parse('2026-10-02T06:08:00.000Z');

function notices(enabled = () => true) {
  const shown = [];
  return { shown, n: new LimitLockNotices(enabled, (title, body) => shown.push({ title, body })) };
}

test('the toast names the agent, the provider, the reset and the way out', () => {
  assert.equal(
    limitLockText('Dwight', 'codex', RESET),
    'Dwight is locked: codex limit reached, resets 1:08 AM. Add another model to its Balance list to keep it working.'
  );
  assert.equal(
    limitLockText('Dwight', 'codex', undefined),
    'Dwight is locked: codex limit reached. Add another model to its Balance list to keep it working.'
  );
});

test('a hold toasts once and not again while it lasts', () => {
  const { shown, n } = notices();
  for (let beat = 0; beat < 3; beat++) {
    n.held('dwight', 'Dwight', 'codex', RESET);
    n.keepOnly(['dwight']);
  }
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /^Dwight is locked: codex limit reached, resets 1:08 AM\./);
});

test('a hold that ended and begins again toasts again', () => {
  const { shown, n } = notices();
  n.held('dwight', 'Dwight', 'codex', RESET);
  n.keepOnly(['dwight']);
  n.keepOnly([]);
  n.held('dwight', 'Dwight', 'codex', RESET);
  assert.equal(shown.length, 2);
});

test('a switched agent never toasts; only the held one does', () => {
  const { shown, n } = notices();
  // Jim switched engines this beat: the beat leaves him out of limitWaits and never calls held().
  n.held('dwight', 'Dwight', 'codex', RESET);
  n.keepOnly(['dwight']);
  assert.deepEqual(shown.map((s) => s.body.split(' ')[0]), ['Dwight']);
});

test('notifications off: no toast, and turning them on mid-hold does not toast that hold', () => {
  let on = false;
  const { shown, n } = notices(() => on);
  n.held('dwight', 'Dwight', 'codex', RESET);
  n.keepOnly(['dwight']);
  on = true;
  n.held('dwight', 'Dwight', 'codex', RESET);
  assert.equal(shown.length, 0);
  n.keepOnly([]);
  n.held('dwight', 'Dwight', 'codex', RESET);
  assert.equal(shown.length, 1);
});
