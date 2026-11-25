'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-exception-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { await hive.flushWrites(); rmTree(home); });
  await hive.ensureAgent({ id: 'boss-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Worker', provider: 'claude', cwd: home });
  hive.writeTasks([{
    id: 'target', title: 'Target', assignee: 'worker-1', status: 'todo',
    dependsOn: [], priority: 'high', createdAt: '2026-11-12T00:00:00.000Z'
  }]);
  return { hive, home };
}

const cases = [
  { name: 'worker routeMessage Error', sender: 'worker-1', reason: 'simulated routing failure', task: false },
  { name: 'Boss task-patch Error', sender: 'boss-1', reason: 'simulated ledger write failure', task: true },
  { name: 'worker routeMessage string throw', sender: 'worker-1', reason: 'simulated non-Error failure', task: false, string: true }
];

async function failedOutbox(t, scenario) {
  const { hive, home } = await floor(t);
  const outbox = path.join(home, 'hive', 'agents', scenario.sender, 'outbox');
  const filename = 'a-throwing.json';
  const payload = scenario.task
    ? { to: 'harness', act: 'task-patch', body: { id: 'target', notesAppend: 'must not land' } }
    : { to: 'boss', from: 'spoofed-sender', act: 'inform', subject: 'trigger failure', body: 'payload' };
  const raw = JSON.stringify(payload);
  fs.writeFileSync(path.join(outbox, filename), raw);
  let attempts = 0;
  const fail = () => {
    attempts++;
    throw scenario.string ? scenario.reason : new Error(scenario.reason);
  };
  if (scenario.task) {
    const original = hive.patchTask.bind(hive);
    hive.patchTask = (id, patch) => id === 'target' ? fail() : original(id, patch);
  } else {
    const original = hive.routeMessage.bind(hive);
    hive.routeMessage = (msg) => msg.subject === 'trigger failure' ? fail() : original(msg);
  }
  return { hive, outbox, filename, raw, attempts: () => attempts };
}

for (const scenario of cases) {
  test(`${scenario.name}: logs sender, file and exception reason`, async (t) => {
    const { hive, filename, attempts } = await failedOutbox(t, scenario);
    assert.equal(hive.routeOnce(), 0);
    assert.equal(attempts(), 1, 'must exercise the throwing production call');
    const events = hive.logTail(500).filter((event) => event.file === filename);
    assert.equal(events.length, 1, 'throwing outbox file needs one diagnostic event');
    assert.equal(events[0].from, scenario.sender, 'directory owner is authoritative');
    assert.equal(typeof events[0].kind, 'string');
    assert.ok(JSON.stringify(events[0]).includes(scenario.reason), 'diagnostic must preserve the exception reason');
  });

  test(`${scenario.name}: mails a refusal to the actual sender with the reason`, async (t) => {
    const { hive, attempts } = await failedOutbox(t, scenario);
    assert.equal(hive.routeOnce(), 0);
    assert.equal(attempts(), 1);
    const replies = hive.inbox(scenario.sender);
    assert.equal(replies.length, 1, 'sender must learn that its outbox message failed');
    const reply = replies[0];
    assert.equal(reply.from, 'harness');
    assert.equal(reply.to, scenario.sender);
    assert.ok(['inform', 'refuse'].includes(reply.act));
    assert.match(reply.subject, /refus|fail|error/i);
    assert.ok(`${reply.subject} ${typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)}`.includes(scenario.reason));
    assert.equal(reply.requires_reply, false);
  });

  test(`${scenario.name}: quarantines once and continues routing`, async (t) => {
    const { hive, outbox, filename, raw, attempts } = await failedOutbox(t, scenario);
    const recipient = scenario.sender === 'boss-1' ? 'worker-1' : 'boss-1';
    fs.writeFileSync(path.join(outbox, 'b-good.json'), JSON.stringify({ to: recipient, act: 'inform', subject: 'good', body: 'still routed' }));
    assert.equal(hive.routeOnce(), 1);
    assert.equal(attempts(), 1);
    assert.equal(fs.existsSync(path.join(outbox, filename)), false);
    assert.equal(fs.readFileSync(path.join(outbox, '.sent', `bad-${filename}`), 'utf8'), raw);
    assert.equal(fs.existsSync(path.join(outbox, '.sent', 'b-good.json')), true);
    assert.equal(hive.inbox(recipient).filter((msg) => msg.subject === 'good').length, 1);
    assert.equal(hive.tasks().tasks[0].notes, undefined, 'failed patch must not change the ledger');
    const before = { log: hive.logTail(500), inbox: hive.inbox(scenario.sender) };
    assert.equal(hive.routeOnce(), 0);
    assert.equal(attempts(), 1, 'quarantined message must not be retried');
    assert.deepEqual(hive.logTail(500), before.log);
    assert.deepEqual(hive.inbox(scenario.sender), before.inbox);
  });
}
