'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { priorityDots } = loadTs('src/shared/taskPriority.ts');

test('a high and a low card show different dot levels', () => {
  assert.ok(priorityDots('high') > priorityDots('low'));
  assert.equal(priorityDots('high'), 5);
  assert.equal(priorityDots('medium'), 3);
  assert.equal(priorityDots('low'), 1);
});

test('word case and padding do not matter; unreadable is medium', () => {
  assert.equal(priorityDots(' High '), 5);
  assert.equal(priorityDots('urgent'), 3);
  assert.equal(priorityDots(undefined), 3);
});

test('a legacy number keeps its own dot count, clamped to 1..5', () => {
  assert.equal(priorityDots(4), 4);
  assert.equal(priorityDots(9), 5);
  assert.equal(priorityDots(0), 1);
});

test('the kanban parser reads priority through priorityDots', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/TasksKanban.tsx'), 'utf8');
  assert.match(src, /priority:\s*priorityDots\(t\.priority\)/);
});
