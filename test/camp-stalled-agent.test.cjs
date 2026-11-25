'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { standupProblems, runOpsStandup, STANDUP_STALL_SEC } = loadTs('src/main/standupGate.ts');
const { floorSummary } = loadTs('src/main/campTools.ts');

function state(status = 'doing', age = 3 * 3600) {
  return {
    fleet: { agents: [{ id: 'worker', name: 'Worker', isGod: false, dormant: false, breaker: 'healthy', lastActiveSecAgo: age, inboxBacklog: 0 }] },
    tasks: { tasks: [{ id: 'current', status, assignee: 'worker', title: 'Recover me' }] }
  };
}

test('stall default is 45 minutes', () => assert.equal(STANDUP_STALL_SEC, 45 * 60));

for (const status of ['doing', 'todo']) {
  test(`standup marks an inactive ${status} assignee STALLED and names agent/card`, () => {
    const { fleet, tasks } = state(status);
    const report = standupProblems(fleet, tasks).join('\n');
    assert.match(report, /STALLED/);
    assert.match(report, /worker/);
    assert.match(report, /current/);
  });

  test(`floor marks an inactive ${status} assignee STALLED`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-stalled-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { fleet, tasks } = state(status);
    fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify(fleet));
    fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(tasks));
    const result = floorSummary({ hiveRoot: root });
    assert.equal(result.ok, true);
    assert.match(result.summary.split('\n').find(line => line.includes('[worker]')), /STALLED/);
  });
}

for (const status of ['doing', 'todo', 'blocked', 'done']) {
  test(`standup does not flag recent or non-runnable work (${status})`, () => {
    const recent = state(status, 60);
    assert.deepEqual(standupProblems(recent.fleet, recent.tasks), []);
    if (status === 'blocked' || status === 'done') {
      const old = state(status);
      assert.deepEqual(standupProblems(old.fleet, old.tasks), []);
    }
  });
}

test('configured stall threshold changes classification for todo as well as doing', () => {
  for (const status of ['doing', 'todo']) {
    const { fleet, tasks } = state(status, 20 * 60);
    assert.deepEqual(standupProblems(fleet, tasks, 30 * 60), []);
    assert.match(standupProblems(fleet, tasks, 10 * 60).join('\n'), /STALLED/);
  }
});

test('an unchanged floor still wakes Boss when a todo session becomes stalled', () => {
  const { fleet, tasks } = state('todo');
  const notes = [];
  const { standupTaskFingerprint } = loadTs('src/main/standupGate.ts');
  const sent = runOpsStandup({
    mark: () => ({ at: 1_000_000, tasks: standupTaskFingerprint(tasks) }),
    saveMark: () => {}, tasks: () => tasks, logTail: () => [], godId: 'chief',
    systemSenders: new Set(), send: note => notes.push(note), appendLog: () => {},
    now: () => 4_600_000, problems: () => standupProblems(fleet, tasks), ack: () => assert.fail('stalled agent cannot be quietly acknowledged')
  });
  assert.equal(sent, true);
  assert.match(notes.join('\n'), /STALLED/);
});
