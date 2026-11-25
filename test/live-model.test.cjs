'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { liveModelFromLog, liveModelAllowed, sameModel } = loadTs('src/shared/liveModel.ts');
const { setTomlTableKey } = loadTs('src/shared/codexSandbox.ts');

const codexLine = (type, payload) => JSON.stringify({ timestamp: '2026-10-07T20:00:00Z', type, payload });

test('codex: the latest thread settings beat the launch turn context', () => {
  const log = [
    codexLine('turn_context', { model: 'gpt-6.1-sol', effort: 'high' }),
    codexLine('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna' } })
  ].join('\n');
  assert.equal(liveModelFromLog(log, 'codex'), 'gpt-6-luna');
});

test('codex: a later turn context switching back wins', () => {
  const log = [
    codexLine('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna' } }),
    codexLine('turn_context', { model: 'gpt-6.1-sol' })
  ].join('\n');
  assert.equal(liveModelFromLog(log, 'codex'), 'gpt-6.1-sol');
});

test('claude: the latest real assistant model, skipping synthetic messages', () => {
  const log = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } })
  ].join('\n');
  assert.equal(liveModelFromLog(log, 'claude'), 'claude-opus-5-5');
});

test('a torn first line from a tail read and a log with no model give null', () => {
  assert.equal(liveModelFromLog('l":"gpt-6-luna"}}\n{"type":"session_meta"}', 'codex'), null);
});

test('allowed: matches on the session provider, ignoring the context-window suffix', () => {
  const list = [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'claude-opus-5-5[1m]' }];
  assert.equal(liveModelAllowed('gpt-6.1-sol', 'codex', list), true);
  assert.equal(liveModelAllowed('gpt-6-luna', 'codex', list), false);
  assert.equal(liveModelAllowed('claude-opus-5-5', 'claude', list), true);
  assert.equal(liveModelAllowed('gpt-6.1-sol', 'codex', [{ provider: 'claude', model: 'claude-opus-5-5[1m]' }]), false);
  assert.equal(liveModelAllowed('anything', 'codex', [{ provider: 'codex' }]), true);
  assert.equal(sameModel('claude-opus-5-5[1m]', 'Claude-Opus-5-5'), true);
});

test('notice table: appended when missing, rewritten in place when present', () => {
  const added = setTomlTableKey('model = "x"\n', 'notice', 'hide_rate_limit_model_nudge', true);
  assert.match(added, /\n\[notice\]\nhide_rate_limit_model_nudge = true\n$/);
  const existing = 'a = 1\n[notice]\nhide_rate_limit_model_nudge = false\nother = 2\n[tui]\nx = 1\n';
  const rewritten = setTomlTableKey(existing, 'notice', 'hide_rate_limit_model_nudge', true);
  assert.equal(rewritten, existing.replace('hide_rate_limit_model_nudge = false', 'hide_rate_limit_model_nudge = true'));
  const inserted = setTomlTableKey('[notice]\nother = 2\n[tui]\n', 'notice', 'hide_rate_limit_model_nudge', true);
  assert.equal(inserted, '[notice]\nhide_rate_limit_model_nudge = true\nother = 2\n[tui]\n');
});
