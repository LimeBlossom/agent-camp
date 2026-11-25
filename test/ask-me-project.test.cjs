'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { projectOf, projectCounts, OTHER_PROJECT } = loadTs('src/shared/askMeProject.ts');

test('the card project field wins over the title', () => {
  assert.equal(projectOf({ project: 'SphereSurvivors', title: 'Alpha: x' }), 'SphereSurvivors');
});

test('the title prefix names the project, by its first word', () => {
  assert.equal(projectOf({ title: 'SphereSurvivors: integrate the Imago Devkit' }), 'SphereSurvivors');
  assert.equal(projectOf({ title: 'Alpha content: set up OBS replay buffer' }), 'Alpha');
  assert.equal(projectOf({ title: 'Delta: rule on world-loop defaults' }), 'Delta');
});

test('no prefix, or a sentence before the colon, falls to Other', () => {
  assert.equal(projectOf({ title: 'Verify combo chip juice ladder fires in play' }), OTHER_PROJECT);
  assert.equal(projectOf({ title: 'Shorts analytics in one place (steam-dashboard sister): next' }), OTHER_PROJECT);
  assert.equal(projectOf({}), OTHER_PROJECT);
});

test('projectCounts orders busiest first and keeps Other last', () => {
  const counts = projectCounts([
    { title: 'Loose ask' }, { title: 'Another loose ask' }, { title: 'Third loose ask' },
    { title: 'Alpha: a' }, { title: 'Alpha: b' }, { title: 'Delta: c' }
  ]);
  assert.deepEqual(counts, [
    { project: 'Alpha', count: 2 }, { project: 'Delta', count: 1 }, { project: OTHER_PROJECT, count: 3 }
  ]);
});
