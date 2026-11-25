'use strict';

/** Floor thoughts steer away from lines said recently. */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { pickFresh } = loadTs('src/renderer/src/scene/office/freshPick.ts');

test('no line repeats within half a pool of picks, whatever the seeds', () => {
  const pool = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const said = [];
  for (let i = 0; i < 200; i++) said.push(pickFresh(pool, Math.floor(Math.random() * 1e6)));
  for (let i = 0; i < said.length; i++) {
    assert.equal(said.slice(Math.max(0, i - 4), i).includes(said[i]), false, `repeat at pick ${i}`);
  }
  assert.equal(new Set(said).size, 10, 'every line still gets used');
});

test('a constant seed still walks the pool instead of repeating one line', () => {
  const pool = ['a', 'b', 'c', 'd'];
  const said = [0, 1, 2, 3, 4, 5].map(() => pickFresh(pool, 0));
  assert.notEqual(said[0], said[1]);
  assert.notEqual(said[1], said[2]);
});

test('pools keep separate histories, and a one-line pool always returns that line', () => {
  const a = ['x', 'y'];
  const b = ['x', 'y'];
  assert.equal(pickFresh(a, 0), 'x');
  assert.equal(pickFresh(b, 0), 'x');
  assert.equal(pickFresh(['only'], 7), 'only');
});
