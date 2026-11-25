'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { wrapForAgentScope, agentScopePrefix } = loadTs('src/main/agentScope.ts');

test('enabled: the agent runs under systemd-run in agents.slice with its argv intact', () => {
  const r = wrapForAgentScope('/usr/bin/claude', ['--model', 'x', 'multi\nline'], true);
  assert.equal(r.file, 'systemd-run');
  assert.deepEqual(r.args, [
    '--user', '--scope', '--quiet', '--collect', '--slice=agents.slice', '--',
    '/usr/bin/claude', '--model', 'x', 'multi\nline'
  ]);
});

test('disabled: file and args pass through untouched', () => {
  const args = ['a'];
  const r = wrapForAgentScope('/usr/bin/claude', args, false);
  assert.equal(r.file, '/usr/bin/claude');
  assert.equal(r.args, args);
});

test('the prefix ends with -- so agent flags are never read as systemd-run flags', () => {
  assert.equal(agentScopePrefix().at(-1), '--');
});
