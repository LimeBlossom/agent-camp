'use strict';

// camp-jail-provider-claude step 5: a sandboxed agent the jail refuses to spawn is down,
// so the floor (fleet row, Boss floor tool, standup) says so, not only log.jsonl.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { standupProblems } = loadTs('src/main/standupGate.ts');
const { floorSummary } = loadTs('src/main/campTools.ts');
const { JailRefusals } = loadTs('src/main/jailRefusals.ts');

const ERR = 'the agent sandbox does not support provider "codex" yet';

function state(jailRefused) {
  return {
    fleet: { agents: [{ id: 'spruce', name: 'Spruce', isGod: false, dormant: false, breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0, ...(jailRefused ? { jailRefused } : {}) }] },
    tasks: { tasks: [] }
  };
}

test('refusals: recorded per agent, cleared by a later successful spawn', () => {
  const r = new JailRefusals();
  assert.equal(r.get('spruce'), null);
  r.refused('spruce', ERR, 1000);
  assert.deepEqual(r.get('spruce'), { error: ERR, at: 1000 });
  r.refused('spruce', ERR, 2000);
  assert.equal(r.get('spruce').at, 2000, 'the latest refusal wins');
  r.spawned('spruce');
  assert.equal(r.get('spruce'), null);
});

test('standup names a jail-refused agent and the reason', () => {
  const { fleet, tasks } = state({ error: ERR, at: 1000 });
  const report = standupProblems(fleet, tasks).join('\n');
  assert.match(report, /spruce/);
  assert.match(report, /sandbox refused/i);
  assert.match(report, /codex/);
});

test('standup is quiet for an agent the jail did not refuse', () => {
  const { fleet, tasks } = state(null);
  assert.deepEqual(standupProblems(fleet, tasks), []);
});

test('floor tool shows a jail-refused agent as down', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-jail-refused-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { fleet, tasks } = state({ error: ERR, at: 1000 });
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify(fleet));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(tasks));
  const result = floorSummary({ hiveRoot: root });
  assert.equal(result.ok, true);
  assert.match(result.summary.split('\n').find(line => line.includes('[spruce]')), /sandbox refused/i);
});
