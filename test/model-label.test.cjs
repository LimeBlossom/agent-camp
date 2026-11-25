'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { agentModelLabel, shortModelName } = loadTs('src/shared/modelLabel.ts');

test('model label: provider short name, then the model without boilerplate', () => {
  assert.equal(agentModelLabel('codex', 'gpt-6.1-sol'), 'Codex · gpt-6.1-sol');
  assert.equal(agentModelLabel('antigravity', 'Claude Opus 4.6 (Thinking)'), 'agy · Opus 4.6 Thinking');
  assert.equal(agentModelLabel('antigravity', 'Gemini 3.8 Flash (High)'), 'agy · Gemini 3.8 Flash High');
  assert.equal(agentModelLabel('claude', 'claude-opus-4-8[1m]'), 'Claude · Opus 4.8 1m');
  assert.equal(agentModelLabel('claude', 'claude-sonnet-4-5-20250929'), 'Claude · Sonnet 4.5');
  assert.equal(agentModelLabel('opencode', 'anthropic/claude-haiku-4-5'), 'OpenCode · Haiku 4.5');
});

test('model label: no model reads as the CLI default', () => {
  assert.equal(agentModelLabel('codex', undefined), 'Codex · default');
  assert.equal(agentModelLabel('claude', '  '), 'Claude · default');
  assert.equal(shortModelName('fable'), 'fable', 'a bare family name with no version is left alone');
});
