'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { modelStrength, isWeakModel } = loadTs('src/shared/modelStrength.ts');
const { engineOrderFor } = loadTs('src/shared/difficulty.ts');
const { formatEnginePromptProse, DEFAULT_ENGINES } = loadTs('src/main/engineChoice.ts');

test('strength comes from the catalog data: Opus strong, Sonnet and Flash weak', () => {
  assert.equal(modelStrength('claude-opus-5-5'), 'strong');
  assert.equal(modelStrength('gpt-6.1-sol'), 'strong');
  assert.equal(modelStrength('gpt-6.2-astra'), 'strong');
  assert.equal(isWeakModel('claude-sonnet-5-5'), true);
  assert.equal(isWeakModel('gemini-3.8-flash-high'), true);
  assert.equal(isWeakModel('gpt-6-luna'), true);
  assert.equal(isWeakModel('claude-haiku-4-5-20251001'), true);
  assert.equal(isWeakModel(undefined), false);
});

test('the taught spawn default is Claude first, Codex next, agy for easy or bulk work', () => {
  const prose = formatEnginePromptProse(DEFAULT_ENGINES);
  assert.match(prose, /\["claude","codex","agy-claude","agy"\]/);
  assert.doesNotMatch(prose, /cheapest\s+first/);
  assert.match(prose, /Claude first/i);
  assert.match(prose, /visual judging/i);
  assert.match(prose, /image generation/i);
  assert.match(prose, /visual-judgment\|image-making/);
  assert.match(prose, /a visual check is code/i);
  assert.match(prose, /VISUAL CHECKS tiers: a script guard first, its own eyes or subagent next, Willow only for taste/);
  assert.ok(prose.indexOf('"claude"') < prose.indexOf('"agy"'), 'claude is named before agy');
});

test('hard spawn engines keep Claude-first order and push weak engines to the back', () => {
  const isWeak = (e) => e === 'agy';
  assert.deepEqual(engineOrderFor(['claude', 'codex', 'agy'], 'hard', isWeak), ['claude', 'codex', 'agy']);
  assert.deepEqual(engineOrderFor(['agy', 'claude', 'codex'], 'hard', isWeak), ['claude', 'codex', 'agy']);
  assert.deepEqual(engineOrderFor(['agy', 'claude'], 'easy', isWeak), ['agy', 'claude']);
});
