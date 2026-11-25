'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { whoLookup, handleCampMcpCall } = loadTs('src/main/campTools.ts');

function hive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-who-'));
  t.after(() => rmTree(root));
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ agents: {
    'cedar-1': { name: 'Cedar', provider: 'claude', status: 'idle' },
    'cherry-2': { name: 'Cherry', provider: 'codex', status: 'idle', dormant: true },
    'pine-3': { name: 'Pine', provider: 'codex', status: 'working' }
  } }));
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ agents: [
    { id: 'cedar-1', name: 'Cedar', model: 'claude-opus-5-5', breaker: 'healthy', lastActiveSecAgo: 120, inboxBacklog: 0 },
    { id: 'cherry-2', name: 'Cherry', model: 'gpt-6-luna', dormant: true, breaker: 'healthy' },
    { id: 'pine-3', name: 'Pine', model: 'gpt-6.1-sol', breaker: 'steering', lastActiveSecAgo: 3000, inboxBacklog: 2 }
  ] }));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'card-a', assignee: 'cedar-1', status: 'doing' },
    { id: 'card-b', assignee: 'cherry-2', status: 'todo' }
  ] }));
  return root;
}

test('who gives provider, model, state and card in one line', (t) => {
  const root = hive(t);
  assert.equal(whoLookup({ hiveRoot: root, agent: 'cedar' }).line, 'Cedar [cedar-1] | claude | claude-opus-5-5 | idle | active 2m ago | doing card-a');
  assert.equal(whoLookup({ hiveRoot: root, agent: 'cherry-2' }).line, 'Cherry [cherry-2] | codex | gpt-6-luna | dormant | 1 todo');
  assert.equal(whoLookup({ hiveRoot: root, agent: 'pin' }).line, 'Pine [pine-3] | codex | gpt-6.1-sol | working | breaker steering | active 50m ago | inbox 2');
});

test('an ambiguous or unknown name is refused with the candidates', (t) => {
  const root = hive(t);
  assert.match(whoLookup({ hiveRoot: root, agent: 'c' }).error, /matches Cedar, Cherry/);
  assert.match(whoLookup({ hiveRoot: root, agent: 'zz' }).error, /no agent/);
  const res = handleCampMcpCall('who', { agent: 'Pine' }, { hiveRoot: root, agentId: 'god' });
  assert.match(res.content[0].text, /^Pine \[pine-3\] \| codex/);
});
