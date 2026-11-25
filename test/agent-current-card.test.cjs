'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { currentCard } = loadTs('src/renderer/src/components/agentCurrentCard.ts');

test('only the agent\'s doing cards count', () => {
  const tasks = [
    { id: 't1', title: 'todo one', status: 'todo', assignee: 'a' },
    { id: 't2', title: 'someone else', status: 'doing', assignee: 'b' },
    { id: 't3', title: 'done one', status: 'done', assignee: 'a' }
  ];
  assert.equal(currentCard(tasks, 'a'), null);
});

test('the highest priority doing card wins and the rest are counted', () => {
  const tasks = [
    { id: 'low', title: 'Low', status: 'doing', assignee: 'a', priority: 1 },
    { id: 'high', title: 'High', status: 'doing', assignee: 'a', priority: 5 },
    { id: 'mid', title: 'Mid', status: 'doing', assignee: 'a' }
  ];
  assert.deepEqual(currentCard(tasks, 'a'), { id: 'high', title: 'High', nickname: 'High', more: 2 });
});

test('a high doing card wins over a low doing card listed first', () => {
  const tasks = [
    { id: 'low', title: 'Low', status: 'doing', assignee: 'a', priority: 'low' },
    { id: 'high', title: 'High', status: 'doing', assignee: 'a', priority: 'high' }
  ];
  assert.equal(currentCard(tasks, 'a').id, 'high');
});

test('a card with no title shows its id as title and derives nickname', () => {
  assert.deepEqual(currentCard([{ id: 'x1', status: 'doing', assignee: 'a' }], 'a'), { id: 'x1', title: 'x1', nickname: '', more: 0 });
});

test('card nickname is preferred over derived title', () => {
  const tasks = [
    { id: 'card-1', title: 'Alpha: very long title that would get cut off', nickname: 'Short Nick', status: 'doing', assignee: 'a' }
  ];
  assert.deepEqual(currentCard(tasks, 'a'), {
    id: 'card-1',
    title: 'Alpha: very long title that would get cut off',
    nickname: 'Short Nick',
    more: 0
  });
});

test('card nickname is auto-derived from full title when unset', () => {
  const tasks = [
    { id: 'card-2', title: 'Camp: queue input box lags typing while running', status: 'doing', assignee: 'a' }
  ];
  assert.deepEqual(currentCard(tasks, 'a'), {
    id: 'card-2',
    title: 'Camp: queue input box lags typing while running',
    nickname: 'Queue input box',
    more: 0
  });
});

const { tileInfoLine } = loadTs('src/renderer/src/components/agentCurrentCard.ts');

test('a working tile with a doing card shows the card nickname, not the shell line', () => {
  assert.equal(tileInfoLine({ status: 'working', action: 'running set -eu H=/home/u', cardName: 'Agent tile card', description: 'd', project: 'p' }), 'Agent tile card');
});

test('a working tile with no card falls back to the current line', () => {
  assert.equal(tileInfoLine({ status: 'working', action: 'running tests', cardName: '', description: 'd', project: 'p' }), 'running tests');
});

test('an idle tile keeps its description even when a card is doing', () => {
  assert.equal(tileInfoLine({ status: 'idle', action: 'x', cardName: 'Card', description: 'desc', project: 'p' }), 'desc');
  assert.equal(tileInfoLine({ status: 'idle', cardName: 'Card', project: 'proj' }), 'proj');
});

test('a working tile with neither card nor action shows description then project', () => {
  assert.equal(tileInfoLine({ status: 'thinking', description: ' ', project: 'proj' }), 'proj');
});

test('a card name is the nickname, falling back to the id when the title is empty', () => {
  const tasks = [{ id: 'abc-1', title: 'Camp: bare node --test picks up fixtures and benchmarks', status: 'doing', assignee: 'a' }];
  const c = currentCard(tasks, 'a');
  assert.ok(c.nickname.length <= 20);
});
