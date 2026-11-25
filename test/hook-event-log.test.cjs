'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer, HOOK_EVENT_LOG_INTERVAL_MS } = loadTs('src/main/hooks.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-event-log-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'agy', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  const fire = (payload) => server.handle({ agent_id: 'quince-1', session_id: 's1', ...payload });
  const events = async () => {
    await hive.flushWrites();
    return fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((e) => e.kind === 'hook-event');
  };
  return { fire, events };
}

function withClock(t, start) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  t.after(() => { Date.now = real; });
  return (ms) => { now += ms; };
}

test('every Stop is written to log.jsonl as a hook-event line with agentId, event and ts', async (t) => {
  const { fire, events } = await floor(t);
  fire({ hook_event_name: 'Stop' });
  fire({ hook_event_name: 'Stop' });
  const lines = await events();
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.agentId, 'quince-1');
    assert.equal(l.event, 'Stop');
    assert.equal(typeof l.ts, 'number');
  }
});

test('a PreToolUse flood writes one line per agent per interval, and the next line counts what it skipped', async (t) => {
  const advance = withClock(t, 1_000_000);
  const { fire, events } = await floor(t);
  for (let i = 0; i < 50; i++) fire({ hook_event_name: 'PreToolUse', tool_name: 'run_command', tool_input: { CommandLine: `echo ${i}` } });
  assert.equal((await events()).length, 1);
  advance(HOOK_EVENT_LOG_INTERVAL_MS);
  fire({ hook_event_name: 'PreToolUse', tool_name: 'run_command', tool_input: { CommandLine: 'echo last' } });
  const lines = await events();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].event, 'PreToolUse');
  assert.equal(lines[1].suppressed, 49);
});

test('a throttled tool flood never hides a Stop that follows it', async (t) => {
  withClock(t, 2_000_000);
  const { fire, events } = await floor(t);
  for (let i = 0; i < 5; i++) fire({ hook_event_name: 'PreToolUse', tool_name: 'run_command', tool_input: { CommandLine: 'ls' } });
  fire({ hook_event_name: 'Stop' });
  const lines = await events();
  assert.deepEqual(lines.map((l) => l.event), ['PreToolUse', 'Stop']);
});

test('status-line ticks are telemetry and write no hook-event line', async (t) => {
  const { fire, events } = await floor(t);
  fire({ hook_event_name: 'Status', context_window: { total_input_tokens: 10, context_window_size: 100 } });
  fire({ hook_event_name: 'Stop' });
  assert.deepEqual((await events()).map((l) => l.event), ['Stop']);
});
