'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { doneAutoBlockPatch, AUTO_BLOCK_NOTE } = loadTs('src/main/doneAutoBlock.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const boss = (to) => to === 'boss' || to === 'god';
const card = (id, status, extra = {}) => ({ id, status, assignee: 'w1', brief: 'did it', ...extra });

test('a done message to the Boss parks the sender\'s only doing card', () => {
  const p = doneAutoBlockPatch('w1', { act: 'done', to: 'boss', subject: 'finished' }, [card('a', 'doing'), card('b', 'todo')], boss);
  assert.deepEqual(p, { id: 'a', status: 'blocked', notesAppend: AUTO_BLOCK_NOTE });
});

test('the card the message names wins over the doing card', () => {
  const tasks = [card('camp-x', 'doing'), card('camp-x-2', 'todo')];
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss', subject: 'camp-x-2 done' }, tasks, boss).id, 'camp-x-2');
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss', body: 'card camp-x: sha 123' }, tasks, boss).id, 'camp-x', 'camp-x inside camp-x-2 does not count');
});

test('nothing changes without a brief, for other mail, or when it is ambiguous', () => {
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss' }, [card('a', 'doing', { brief: ' ' })], boss), null, 'no brief');
  assert.equal(doneAutoBlockPatch('w1', { act: 'inform', to: 'boss' }, [card('a', 'doing')], boss), null, 'not done');
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'w2' }, [card('a', 'doing')], boss), null, 'not to the Boss');
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss' }, [card('a', 'doing'), card('b', 'doing')], boss), null, 'two doing cards, none named');
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss', subject: 'a' }, [card('a', 'blocked')], boss), null, 'already blocked');
  assert.equal(doneAutoBlockPatch('w1', { act: 'done', to: 'boss' }, [card('a', 'doing', { assignee: 'w2' })], boss), null, 'someone else\'s card');
});

test('through the outbox: done plus a brief patch in one batch parks the card once, never done', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-done-block-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.writeTasks([{ id: 'mine', title: 'Mine', assignee: 'w1', status: 'doing', dependsOn: [], createdAt: '2026-11-06T00:00:00Z' }]);
  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(path.join(out, 'a-done.json'), JSON.stringify({ to: 'boss', act: 'done', subject: 'mine finished', body: 'sha abc' }));
  fs.writeFileSync(path.join(out, 'b-brief.json'), JSON.stringify({ to: 'harness', act: 'task-patch', body: { id: 'mine', brief: 'what was done' } }));
  hive.routeOnce();
  const c = hive.tasks().tasks.find((x) => x.id === 'mine');
  assert.equal(c.status, 'blocked');
  assert.equal(c.notes, AUTO_BLOCK_NOTE);
  assert.equal(hive.inbox('god-1').length, 1, 'the done mail still reaches the Boss');
  assert.equal(hive.inbox('w1').length, 0, 'no refusal mailed back');
  assert.ok(hive.logTail(100).some((e) => e.kind === 'done-auto-block' && e.id === 'mine'));
});
