'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loadTs = require('../test-support/load-ts.cjs');

const { buildWorkerLaunch, workerContextEnv } = loadTs('src/main/workerLaunch.ts');

function has250kContextCap(launch) {
  return launch?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '250000';
}

test('worker requested on claude with 1M model in requestModel gets a context cap near 250k', () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude',
    requestModel: 'claude-sonnet-4-6[1m]',
    autoMode: false
  });
  assert.ok(
    has250kContextCap(l),
    'worker launch spec must have a context cap that compacts near 250k (e.g. model without [1m] or auto-compact setting)'
  );
});

test('worker requested on claude with 1M model in command line gets a context cap near 250k', () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude --model claude-opus-5-5[1m]',
    autoMode: false
  });
  assert.ok(
    has250kContextCap(l),
    'worker launch spec from command line must have a context cap that compacts near 250k'
  );
});

test('worker requested on claude with defaultCommand carrying 1M model gets a context cap near 250k', () => {
  const l = buildWorkerLaunch({
    defaultCommand: 'claude --model claude-sonnet-4-6[1m]',
    autoMode: false
  });
  assert.ok(
    has250kContextCap(l),
    'worker launch spec from defaultCommand must have a context cap that compacts near 250k'
  );
});

test('the Boss (agent id god, isGod: true) is exempt from the context cap and retains the 1M window', () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude',
    requestModel: 'claude-opus-5-5[1m]',
    isGod: true,
    agentId: 'god',
    autoMode: false
  });
  assert.deepEqual(l.env, {});
  const modelIdx = l.args.indexOf('--model');
  const model = modelIdx >= 0 ? l.args[modelIdx + 1] : undefined;
  assert.equal(model, 'claude-opus-5-5[1m]', 'the Boss must retain the requested [1m] model');
  assert.equal(
    l.args.some((a) => /^--(auto-compact|max-context)/i.test(a)),
    false,
    'the Boss must not have worker auto-compact flag forced'
  );
});

test('worker on claude with an unadorned model gets the explicit context cap', () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude',
    requestModel: 'claude-sonnet-4-6',
    autoMode: false
  });
  assert.ok(
    has250kContextCap(l),
    'an unadorned model still needs the explicit cap, including native 1M models'
  );
});

test('non-claude worker is not affected by claude context cap', () => {
  const l = buildWorkerLaunch({
    requestCommand: 'codex --model gpt-5.4[1m]',
    requestProvider: 'codex',
    autoMode: false
  });
  const modelIdx = l.args.indexOf('--model');
  const model = modelIdx >= 0 ? l.args[modelIdx + 1] : undefined;
  assert.deepEqual(l.env, {});
  assert.equal(model, 'gpt-5.4[1m]', 'non-claude worker model must be untouched');
});

test('cap detection rejects invented flags, unrelated env and a suffix-free model alone', () => {
  for (const launch of [
    { args: ['--auto-compact', '250000'] },
    { env: { RANDOM_CONTEXT_FLAG: '1' } },
    { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } },
    { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } },
    { args: ['--model', 'claude-opus-5-5'] }
  ]) assert.equal(has250kContextCap(launch), false);
});

test('shared spawn policy caps model-less Claude launches and leaves other providers unchanged', () => {
  assert.ok(has250kContextCap(buildWorkerLaunch({ requestCommand: 'claude', autoMode: false })));
  assert.deepEqual(workerContextEnv('claude', false, 'standing-worker'), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' });
  for (const provider of ['codex', 'agy', 'opencode', 'crush', 'copilot', 'kimi']) {
    assert.deepEqual(workerContextEnv(provider, false, 'worker'), {});
  }
});

test('Boss exemption works with either role metadata or canonical agent id', () => {
  assert.deepEqual(workerContextEnv('claude', true, 'custom-boss-id'), {});
  assert.deepEqual(workerContextEnv('claude', false, 'god'), {});
});

test('the shared spawn boundary enforces the cap after config and engine model selection', () => {
  const src = fs.readFileSync(require('node:path').join(__dirname, '../src/main/index.ts'), 'utf8');
  const core = src.slice(src.indexOf('async function spawnAgentCore('), src.indexOf("ipcMain.handle('pty:write'"));
  const policy = core.indexOf('...workerContextEnv(provider, opts.hive?.isGod, opts.hive?.id ?? opts.id)');
  assert.ok(policy > core.indexOf("args.push('--model', m)"));
  assert.ok(policy > core.indexOf('...inj.env'));
  assert.ok(policy < core.indexOf('ptyManager.spawn(opts, owner)'));
});
