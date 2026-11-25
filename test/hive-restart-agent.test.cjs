'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

async function rig(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-restart-route-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushCommits(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'chief', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker', name: 'Worker', provider: 'antigravity', cwd: home });
  hive.writeTasks([{ id: 'current', title: 'Restart support', assignee: 'worker', status: 'doing', brief: 'Resume here', dependsOn: [] }]);
  const calls = [];
  assert.equal(typeof hive.setRestartAgentHook, 'function', 'restart requests need a harness-to-main hook');
  hive.setRestartAgentHook((sender, body) => { calls.push({ sender, body }); return { ok: true }; });
  const send = (sender, body) => {
    fs.writeFileSync(path.join(home, 'hive', 'agents', sender, 'outbox', 'restart.json'), JSON.stringify({ to: 'harness', act: 'restart-agent', body }));
    hive.routeOnce();
  };
  return { hive, calls, send };
}

test('harness routes Boss restart to main with authenticated sender and unchanged options', async t => {
  const { calls, send } = await rig(t);
  const body = { agentId: 'worker', reason: 'hung', force: true, model: { provider: 'codex', model: 'gpt-5.4' } };
  send('chief', body);
  assert.deepEqual(calls, [{ sender: 'chief', body }]);
});

test('raw worker outbox cannot bypass MCP Boss-only guard by spoofing who', async t => {
  const { hive, calls, send } = await rig(t);
  send('worker', { agentId: 'worker', reason: 'hung', force: true, who: 'chief' });
  assert.deepEqual(calls, []);
  assert.match(JSON.stringify(hive.inbox('worker')), /boss|authoriz|forbidden/i);
});

test('raw Boss outbox cannot restart Boss even with force', async t => {
  const { hive, calls, send } = await rig(t);
  send('chief', { agentId: 'chief', reason: 'hung', force: true });
  assert.deepEqual(calls, []);
  assert.match(JSON.stringify(hive.inbox('chief')), /boss|itself|self/i);
});
