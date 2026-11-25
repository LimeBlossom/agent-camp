'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { handledInboxFiles } = loadTs('src/main/inboxFiling.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const inbox = [
  { file: 'm1.json', id: 'm1', conversation: 'c1', from: 'god', mtimeMs: 100 },
  { file: 'm2.json', id: 'm2', conversation: 'c1', from: 'god', mtimeMs: 300 },
  { file: 'm3.json', id: 'm3', conversation: 'c1', from: 'w2', mtimeMs: 100 },
  { file: 'm4.json', id: 'm4', conversation: 'c2', from: 'god', mtimeMs: 100 }
];

test('in_reply_to files the named message, by id or file name', () => {
  assert.deepEqual(handledInboxFiles({ in_reply_to: 'm4', to: 'god', atMs: 200 }, inbox), ['m4.json']);
  assert.deepEqual(handledInboxFiles({ in_reply_to: 'm4.json', to: 'w9', atMs: 200 }, inbox), ['m4.json']);
});

test('a conversation files earlier mail from the same peer only', () => {
  assert.deepEqual(handledInboxFiles({ conversation: 'c1', to: 'god', atMs: 200 }, inbox), ['m1.json'], 'm2 came after the reply, m3 is another peer');
});

test('explicit in_reply_to does not sweep other messages in the same conversation', () => {
  assert.deepEqual(
    handledInboxFiles({ in_reply_to: 'm1', conversation: 'c1', to: 'god', atMs: 500 }, inbox),
    ['m1.json'],
    'explicit reply must archive only the explicitly handled message, leaving other same-conversation mail'
  );
});

test('a reply naming nothing files nothing', () => {
  assert.deepEqual(handledInboxFiles({ to: 'god', atMs: 999 }, inbox), []);
});

test('through the outbox: a reply moves the answered mail to inbox/.done and leaves the rest', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-inbox-file-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  const q = hive.send({ to: 'w1', act: 'query', subject: 'status?' }, 'god-1');
  const other = hive.send({ to: 'w1', act: 'request', subject: 'other job' }, 'god-1');
  const dir = path.join(home, 'hive', 'agents', 'w1');
  fs.writeFileSync(path.join(dir, 'outbox', 'r.json'), JSON.stringify({ to: 'boss', act: 'inform', subject: 'fine', in_reply_to: q.id }));
  hive.routeOnce();
  assert.ok(fs.existsSync(path.join(dir, 'inbox', '.done', `${q.id}.json`)));
  assert.ok(fs.existsSync(path.join(dir, 'inbox', `${other.id}.json`)), 'unanswered mail stays');
  assert.ok(hive.logTail(100).some((e) => e.kind === 'inbox-auto-filed' && e.files.includes(`${q.id}.json`)));
});

test('through the outbox: explicit in_reply_to in a shared conversation archives only the answered message', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-inbox-file-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  const q1 = hive.send({ to: 'w1', act: 'query', subject: 'first query', conversation: 'c-shared' }, 'god-1');
  const q2 = hive.send({ to: 'w1', act: 'query', subject: 'second query', conversation: 'c-shared' }, 'god-1');
  const dir = path.join(home, 'hive', 'agents', 'w1');
  fs.writeFileSync(
    path.join(dir, 'outbox', 'r.json'),
    JSON.stringify({ to: 'boss', act: 'inform', subject: 'answer 1', in_reply_to: q1.id, conversation: 'c-shared' })
  );
  hive.routeOnce();
  assert.ok(fs.existsSync(path.join(dir, 'inbox', '.done', `${q1.id}.json`)), 'explicitly answered message must be in .done');
  assert.ok(fs.existsSync(path.join(dir, 'inbox', `${q2.id}.json`)), 'other same-conversation request must remain pending in inbox');
  assert.equal(fs.existsSync(path.join(dir, 'inbox', '.done', `${q2.id}.json`)), false, 'unanswered same-conversation request must not be swept into .done');
});
