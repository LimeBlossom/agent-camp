'use strict';

/**
 * Card edits through the outbox. A card was lost at 07:15Z on 2026-10-02 to two
 * writers racing on tasks.json; agents now send a task-patch (or, the Boss, a
 * task-create) to the harness, which is the ledger's only writer and writes it
 * atomically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-patch-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Kevin', provider: 'antigravity', cwd: home });
  hive.writeTasks([
    { id: 'mine', title: 'Mine', assignee: 'worker-1', status: 'todo', dependsOn: [], priority: 'high', createdAt: '2026-10-02T07:00:00.000Z', notes: 'first line', slack: { channel: 'C1', thread_ts: '1.2' } },
    { id: 'theirs', title: 'Theirs', assignee: 'worker-2', status: 'todo', dependsOn: [], priority: 'low', createdAt: '2026-10-02T07:00:00.000Z' }
  ]);
  const root = path.join(home, 'hive');
  const send = (agent, msg, file = `${Math.random().toString(36).slice(2)}.json`) => {
    fs.writeFileSync(path.join(root, 'agents', agent, 'outbox', file), JSON.stringify(msg), 'utf8');
    return hive.routeOnce();
  };
  const card = (id) => hive.tasks().tasks.find((c) => c.id === id);
  const patchLog = () => hive.logTail(500).filter((e) => e.kind === 'task-patch');
  return { hive, root, send, card, patchLog };
}

test('a worker patches its own card: status set, notes appended, other fields kept', async (t) => {
  const { hive, send, card, patchLog } = await floor(t);
  assert.equal(send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'blocked', notesAppend: 'BLOCKED: waiting on the human' } }), 1);
  const c = card('mine');
  assert.equal(c.status, 'blocked');
  assert.equal(c.notes, 'first line\nBLOCKED: waiting on the human');
  assert.equal(c.slack.thread_ts, '1.2');
  assert.equal(c.priority, 'high');
  assert.ok(c.updatedAt);
  assert.equal(card('theirs').status, 'todo');
  assert.deepEqual(patchLog().map((e) => [e.from, e.id, e.ok, e.fields]), [['worker-1', 'mine', true, ['status', 'notesAppend']]]);
  assert.equal(hive.inbox('worker-1').length, 0, 'an applied patch sends no mail');
  assert.equal(hive.inbox('god-1').length, 0, 'and is not routed as a message');
});

test('a body sent as a JSON string is applied the same way', async (t) => {
  const { send, card } = await floor(t);
  send('worker-1', { to: 'harness', act: 'task-patch', body: JSON.stringify({ id: 'mine', status: 'doing' }) });
  assert.equal(card('mine').status, 'doing');
});

test('a worker cannot patch another agent\'s card; the refusal is logged and mailed back', async (t) => {
  const { hive, send, card, patchLog } = await floor(t);
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'theirs', status: 'done' } });
  assert.equal(card('theirs').status, 'todo');
  const [e] = patchLog();
  assert.equal(e.ok, false);
  assert.match(e.reason, /not assigned to you/);
  const [mail] = hive.inbox('worker-1');
  assert.equal(mail.from, 'harness');
  assert.match(mail.subject, /task-patch refused for theirs: card theirs is not assigned to you/);
});

test('a bad status, an unknown card and a field a worker may not set are refused', async (t) => {
  const { send, card, patchLog } = await floor(t);
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'finished' } });
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'nope', status: 'done' } });
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', assignee: 'worker-1', status: 'done' } });
  assert.equal(card('mine').status, 'todo');
  assert.equal(card('mine').assignee, 'worker-1');
  const reasons = patchLog().map((e) => e.reason);
  assert.match(reasons[0], /status must be one of todo, doing, blocked, done/);
  assert.match(reasons[1], /no card nope/);
  assert.match(reasons[2], /not allowed: assignee/);
});

test('the Boss patches any card, appends a human ask and creates cards; a worker cannot create', async (t) => {
  const { send, card, patchLog } = await floor(t);
  send('god-1', { to: 'harness', act: 'task-patch', body: { id: 'theirs', assignee: 'worker-1', status: 'blocked', humanQAAppend: { q: '**Which one?**' } } });
  const c = card('theirs');
  assert.equal(c.assignee, 'worker-1');
  assert.equal(c.status, 'blocked');
  assert.equal(c.humanQA.length, 1);
  assert.equal(c.humanQA[0].q, '**Which one?**');
  assert.ok(c.humanQA[0].askedAt);

  send('god-1', { to: 'harness', act: 'task-create', body: { id: 'new-card', title: 'New', assignee: 'worker-2', project: 'SphereSurvivors' } });
  const n = card('new-card');
  assert.equal(n.status, 'todo');
  assert.equal(n.assignee, 'worker-2');
  assert.deepEqual(n.dependsOn, []);
  assert.ok(n.createdAt);

  send('god-1', { to: 'harness', act: 'task-create', body: { id: 'new-card', title: 'Again' } });
  send('worker-1', { to: 'harness', act: 'task-create', body: { id: 'worker-card', title: 'Mine now' } });
  assert.equal(card('new-card').title, 'New');
  assert.equal(card('worker-card'), undefined);
  const refused = patchLog().filter((e) => !e.ok).map((e) => e.reason);
  assert.match(refused[0], /already exists/);
  assert.match(refused[1], /only the Boss creates cards/);
});

test('writeTasks writes tasks.json through a temp file and a rename', async (t) => {
  const { hive, root } = await floor(t);
  const target = path.join(root, 'tasks.json');
  const renames = [];
  const direct = [];
  const origRename = fs.renameSync;
  const origWrite = fs.writeFileSync;
  fs.renameSync = (from, to) => { renames.push([String(from), String(to)]); return origRename(from, to); };
  fs.writeFileSync = (p, ...rest) => { if (String(p) === target) direct.push(p); return origWrite(p, ...rest); };
  try {
    assert.equal(hive.patchTask('mine', { status: 'doing' }), true);
  } finally {
    fs.renameSync = origRename;
    fs.writeFileSync = origWrite;
  }
  assert.deepEqual(direct, [], 'never written in place');
  const r = renames.find(([, to]) => to === target);
  assert.ok(r, 'renamed into place');
  assert.match(path.basename(r[0]), /^tasks\.json\.tmp-/);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).tasks.find((c) => c.id === 'mine').status, 'doing');
});

test('a ledger that does not parse is never overwritten', async (t) => {
  const { hive, root, send, patchLog } = await floor(t);
  const target = path.join(root, 'tasks.json');
  fs.writeFileSync(target, '{"tasks": [{"id": "mine", "tit', 'utf8');
  assert.equal(hive.addTask({ id: 'webhook', title: 'w', status: 'todo', dependsOn: [], priority: 1, createdAt: 'x' }), false);
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'done' } });
  assert.equal(fs.readFileSync(target, 'utf8'), '{"tasks": [{"id": "mine", "tit');
  assert.match(patchLog()[0].reason, /unreadable/);
});

test('planTaskMessage rejects a body that is not an object and a patch with nothing to change', () => {
  const base = { act: 'task-patch', sender: 'w', isBoss: false, tasks: [{ id: 'a', assignee: 'w' }], now: '2026-10-02T12:00:00.000Z' };
  assert.match(planTaskMessage({ ...base, body: 'not json' }).reason, /JSON object/);
  assert.match(planTaskMessage({ ...base, body: { id: 'a' } }).reason, /nothing to change/);
  assert.match(planTaskMessage({ ...base, body: { status: 'done' } }).reason, /card "id"/);
});

test('a burst of task-patches is one tasks.json write and, once flushed, one hive commit', async (t) => {
  const { hive, root, card } = await floor(t);
  await hive.flushCommits();
  const { spawnSync } = require('node:child_process');
  const commits = () => Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim());
  const before = commits();
  const outbox = path.join(root, 'agents', 'worker-1', 'outbox');
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(outbox, `p${String(i).padStart(2, '0')}.json`),
      JSON.stringify({ to: 'harness', act: 'task-patch', body: { id: 'mine', notesAppend: `n${i}` } }));
  }
  const target = path.join(root, 'tasks.json');
  const writes = [];
  const origRename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to) === target) writes.push(to); return origRename(from, to); };
  try {
    assert.equal(hive.routeOnce(), 20);
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(writes.length, 1, 'tasks.json written once for the whole burst');
  assert.equal(card('mine').notes.split('\n').length, 21, 'every patch landed, in order');
  assert.ok(card('mine').notes.endsWith('n19'));
  assert.equal(commits(), before, 'routing returns before any git runs');
  await hive.flushCommits();
  assert.equal(commits(), before + 1);
});

test('hive commits coalesce: commit() never runs git itself, and a flush makes one commit of a burst', async (t) => {
  const { hive, root } = await floor(t);
  await hive.flushCommits();
  const { spawnSync } = require('node:child_process');
  const log = () => spawnSync('git', ['log', '--format=%B%x00'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').map((s) => s.trim()).filter(Boolean);
  const before = log().length;
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(root, `f${i}.md`), String(i));
    hive.commit(i % 2 ? 'hive: tick' : `hive: file ${i}`);
  }
  assert.equal(log().length, before);
  await hive.flushCommits();
  const after = log();
  assert.equal(after.length, before + 1);
  assert.match(after[0], /^hive: 50 changes\n\n/);
  assert.match(after[0], /hive: tick x25/);
});

test('the card patch gate refuses a worker edit with its reason; the Boss is never gated', async (t) => {
  const { hive, send, card, patchLog } = await floor(t);
  const seen = [];
  hive.setCardPatchGate((sender, id, patch, ledger) => {
    seen.push([sender, id, patch.status, ledger.length]);
    return patch.status === 'doing' ? 'mine starts in a fresh session' : null;
  });
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'doing' } });
  assert.equal(card('mine').status, 'todo');
  assert.match(patchLog()[0].reason, /fresh session/);
  assert.match(hive.inbox('worker-1')[0].subject, /task-patch refused for mine: mine starts in a fresh session/);
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', notesAppend: 'note' } });
  assert.equal(card('mine').notes, 'first line\nnote');
  send('god-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'doing' } });
  assert.equal(card('mine').status, 'doing');
  assert.deepEqual(seen, [['worker-1', 'mine', 'doing', 2], ['worker-1', 'mine', undefined, 2]]);
});

test('worker handoff brief: end-to-end patch, refusal without brief on merge, acceptance with brief', async (t) => {
  const { hive, send, card, patchLog } = await floor(t);
  // Attempt to move to awaiting boss merge without brief is refused and mailed back
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', status: 'blocked', notesAppend: 'awaiting boss merge' } });
  assert.equal(card('mine').status, 'todo', 'card remains todo');
  const [refusalLog] = patchLog();
  assert.equal(refusalLog.ok, false);
  assert.match(refusalLog.reason, /write the card's "brief" before moving it to awaiting boss merge/);
  const [refusalMail] = hive.inbox('worker-1');
  assert.match(refusalMail.subject, /task-patch refused for mine: write the card's "brief"/);

  // Patching brief + awaiting boss merge succeeds
  send('worker-1', {
    to: 'harness',
    act: 'task-patch',
    body: { id: 'mine', status: 'blocked', notesAppend: 'awaiting boss merge', brief: 'Completed feature on branch b1' }
  });
  const c = card('mine');
  assert.equal(c.status, 'blocked');
  assert.equal(c.brief, 'Completed feature on branch b1');
  assert.match(c.notes, /awaiting boss merge/);

  // Appending to brief
  send('worker-1', { to: 'harness', act: 'task-patch', body: { id: 'mine', briefAppend: 'Also added test coverage' } });
  assert.equal(card('mine').brief, 'Completed feature on branch b1\nAlso added test coverage');
});
