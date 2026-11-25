'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { CAMP_MCP_TOOLS, handleCampMcpCall } = loadTs('src/main/campTools.ts');

// This fixture never launches a session or targets the live hive.
function floor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = {
    chief: { id: 'chief', name: 'Boss', isGod: true },
    worker: { id: 'worker', name: 'Worker', isGod: false }
  };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: 'chief', agents }));
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ agents: [
    { ...agents.chief, lastActiveSecAgo: 0 },
    { ...agents.worker, lastActiveSecAgo: 3 * 3600, dormant: false }
  ] }));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'current', status: 'doing', assignee: 'worker', brief: 'Preserve this work' }
  ] }));
  const outboxDir = path.join(root, 'outbox');
  fs.mkdirSync(outboxDir);
  const call = (args, agentId = 'chief') => handleCampMcpCall('restart_agent', args, { hiveRoot: root, agentId, outboxDir });
  const queued = () => fs.readdirSync(outboxDir).map(f => JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8')));
  return { call, queued };
}

test('restart_agent schema requires agentId/reason and exposes force and named model', () => {
  const tool = CAMP_MCP_TOOLS.find(t => t.name === 'restart_agent');
  assert.ok(tool, 'Boss needs restart_agent in the MCP tool list');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['agentId', 'reason']);
  assert.equal(tool.inputSchema.properties.force.type, 'boolean');
  assert.ok(tool.inputSchema.properties.model);
});

test('Boss queues a restart with its reason for the harness, not ordinary mail', t => {
  const { call, queued } = floor(t);
  const response = call({ agentId: 'worker', reason: 'Silent for three hours' });
  assert.notEqual(response.isError, true, response.content[0].text);
  assert.equal(queued().length, 1);
  assert.deepEqual(queued()[0], {
    to: 'harness', act: 'restart-agent', body: { agentId: 'worker', reason: 'Silent for three hours' }
  });
});

test('force and explicit model survive MCP transport', t => {
  const { call, queued } = floor(t);
  const model = { provider: 'codex', model: 'gpt-5.4' };
  const response = call({ agentId: 'worker', reason: 'Recover hung provider', force: true, model });
  assert.notEqual(response.isError, true, response.content[0].text);
  assert.equal(queued()[0].body.force, true);
  assert.deepEqual(queued()[0].body.model, model);
});

for (const [label, args, caller, error] of [
  ['worker caller even with force', { agentId: 'worker', reason: 'hung', force: true }, 'worker', /boss|authoriz|forbidden/i],
  ['Boss itself even with force', { agentId: 'chief', reason: 'hung', force: true }, 'chief', /boss|itself|self/i],
  ['unknown agent', { agentId: 'missing', reason: 'hung' }, 'chief', /unknown|not found/i],
  ['blank reason', { agentId: 'worker', reason: '  ' }, 'chief', /reason/i],
  ['path escape', { agentId: '../worker', reason: 'hung' }, 'chief', /agent|invalid/i],
  ['non-boolean force', { agentId: 'worker', reason: 'hung', force: 'true' }, 'chief', /force/i]
]) {
  test(`MCP refuses ${label} without a queued action`, t => {
    const { call, queued } = floor(t);
    const response = call(args, caller);
    assert.equal(response.isError, true);
    assert.doesNotMatch(response.content[0].text, /unknown tool/i, 'refusal must come from restart validation');
    assert.match(response.content[0].text, error);
    assert.deepEqual(queued(), []);
  });
}
