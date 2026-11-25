'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { taskSeedLine } = loadTs('src/renderer/src/scene/office/cafeteriaLines.ts');

test('taskSeedLine uses clean short nicknames without ellipsis', () => {
  const line = taskSeedLine('Alpha: mana vein pulses move like a Game of Life, not a travelling wave', true, 0);
  assert.match(line, /“Mana vein pulses”/);
  assert.doesNotMatch(line, /…|\.\.\./);
});

test('taskSeedLine uses explicit card nickname when provided', () => {
  const line = taskSeedLine({ nickname: 'Vein life', title: 'Alpha: mana vein pulses move' }, false, 1);
  assert.match(line, /“Vein life”/);
  assert.doesNotMatch(line, /…|\.\.\./);
});

test('taskSeedLine drops card reference entirely when nickname is absent or empty', () => {
  const lineDone = taskSeedLine('', true, 0);
  assert.doesNotMatch(lineDone, /“/);
  const lineDoing = taskSeedLine(null, false, 0);
  assert.doesNotMatch(lineDoing, /“/);
});
