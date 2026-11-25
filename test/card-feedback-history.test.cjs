'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { completedCardsForDifficultyReview } = loadTs('src/shared/cardFeedback.ts');
const run = (card, body) => planTaskMessage({ act: 'task-patch', body, sender: 'god', isBoss: true, tasks: [card], now: '2026-11-02T12:00:00Z' });

test('difficulty changes retain old/new, actor, time and reason on the card', () => {
  const p = run({ id: 'x', status: 'todo', difficulty: 'normal' }, { id: 'x', difficulty: 'hard', difficultyReason: 'Repeated review send-backs' });
  assert.deepEqual(p.patch.difficultyHistory, [{ old: 'normal', new: 'hard', who: 'god', when: '2026-11-02T12:00:00Z', reason: 'Repeated review send-backs' }]);
});

test('difficulty review query returns done cards with at least two send-backs below hard', () => {
  assert.deepEqual(completedCardsForDifficultyReview([
    { id: 'eligible', status: 'done', difficulty: 'normal', sendBacks: 2 },
    { id: 'hard', status: 'done', difficulty: 'hard', sendBacks: 3 },
    { id: 'open', status: 'doing', difficulty: 'normal', sendBacks: 3 },
    { id: 'few', status: 'done', difficulty: 'easy', sendBacks: 1 }
  ]).map((card) => card.id), ['eligible']);
});

test('a human answered blocked card reopening increments sendBacks and stores answer', () => {
  const p = run({ id: 'x', status: 'blocked', humanQA: [{ q: 'Which?', a: 'The second option', answeredAt: '2026-11-02T11:00:00Z' }] }, { id: 'x', status: 'doing' });
  assert.equal(p.patch.sendBacks, 1);
  assert.deepEqual(p.patch.sendBackHistory, [{ answer: 'The second option', when: '2026-11-02T11:00:00Z' }]);
});
