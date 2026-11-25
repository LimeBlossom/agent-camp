'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { deriveNickname, cardNickname, isValidNickname } = loadTs('src/shared/cardNickname.ts');

test('deriveNickname drops bracketed project prefixes and colons', () => {
  assert.equal(
    deriveNickname('Alpha: dust and debris fall from the ceiling on screen shake'),
    'Dust and debris'
  );
  assert.equal(
    deriveNickname('Gamma: web build so people can play in the browser'),
    'Web build'
  );
  assert.equal(
    deriveNickname('Camp: read Argon\'s own quota bucket from agy /quota'),
    'Read Argon\'s own'
  );
  assert.equal(
    deriveNickname('[Studio]: Card nicknames so Camp dialogs never cut off a card name'),
    'Card nicknames'
  );
  assert.equal(
    deriveNickname('Delta phase 1: design borrow survey'),
    'Design borrow survey'
  );
  assert.equal(
    deriveNickname('Alpha junk tower v10: Willow visual critique (moss, mana veins)'),
    'Willow visual'
  );
  assert.equal(
    deriveNickname('Ruling: move Cedar\'s look work to a stronger model?'),
    'Move Cedar\'s look'
  );
});

test('deriveNickname respects constraints: max 20 chars, 1-3 words, never cuts mid-word, no ellipsis', () => {
  const result = deriveNickname('Alpha: mana vein pulses move like a Game of Life, not a travelling wave');
  assert.equal(result, 'Mana vein pulses');
  assert.ok(result.length <= 20);
  assert.ok(result.split(/\s+/).length <= 3);
  assert.doesNotMatch(result, /…|\.\.\./);

  // Single word longer than 20 chars is kept whole rather than cut mid-word
  const longWord = deriveNickname('Supercalifragilisticexpialidocious card');
  assert.equal(longWord, 'Supercalifragilisticexpialidocious');

  // Multi-word stopping before 20 chars
  assert.equal(deriveNickname('Alpha: Switch Teleport should not show slash effect'), 'Switch Teleport');
});

test('deriveNickname drops trailing dangling conjunctions, prepositions and particles', () => {
  assert.equal(deriveNickname('Alpha: find boards with death pits for the human to pick'), 'Find boards');
  assert.equal(deriveNickname('Gamma: put the web build on itch'), 'Put the web');
  assert.equal(deriveNickname('Card nicknames so Camp dialogs never cut off a card name'), 'Card nicknames');
});

test('deriveNickname handles edge cases gracefully', () => {
  assert.equal(deriveNickname(''), '');
  assert.equal(deriveNickname(null), '');
  assert.equal(deriveNickname(undefined), '');
  assert.equal(deriveNickname('Alpha:'), 'Alpha');
  assert.equal(deriveNickname(':::'), '');
  assert.equal(deriveNickname('Fix: "quote handling problem"'), 'Quote handling');
});

test('cardNickname uses explicit nickname when set and non-empty', () => {
  assert.equal(cardNickname({ nickname: 'Mana pulses', title: 'Alpha: mana vein pulses move' }), 'Mana pulses');
  assert.equal(cardNickname({ nickname: '   ', title: 'Alpha: mana vein pulses move' }), 'Mana vein pulses');
  assert.equal(cardNickname({ title: 'Alpha: mana vein pulses move' }), 'Mana vein pulses');
  assert.equal(cardNickname('Alpha: mana vein pulses move'), 'Mana vein pulses');
  assert.equal(cardNickname(null), '');
});

test('isValidNickname enforces max 20 chars and max 3 words', () => {
  assert.equal(isValidNickname('Short Nick').ok, true);
  assert.equal(isValidNickname('').ok, true);
  assert.equal(isValidNickname(null).ok, false);
  assert.equal(isValidNickname(123).ok, false);
  assert.equal(isValidNickname('This nickname is definitely way too long').ok, false);
  assert.equal(isValidNickname('one two three four').ok, false);
});
