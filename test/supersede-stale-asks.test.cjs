'use strict';

// A card shows the human at most ONE open ask, its newest. Re-asking used to append
// beside the old question, so one card filled ASK ME with every ask it ever made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { askHuman } = loadTs('src/main/campTools.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const NOW = '2026-11-21T04:00:00.000Z';
// The predicate both ASK ME (AskMeTab.openAsks) and the phone (openQuestions) list by.
const openAsks = (card) => (card.humanQA ?? []).filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);

const card = (id, humanQA, extra = {}) => ({ id, title: id, status: 'blocked', assignee: 'hazel', dependsOn: [], priority: 'medium', humanQA, ...extra });
const history = () => [
  { q: 'old one', askedAt: '2026-10-01T00:00:00.000Z' },
  { q: 'answered', askedAt: '2026-10-02T00:00:00.000Z', a: 'yes', answeredAt: '2026-10-02T01:00:00.000Z' },
  { q: 'dismissed by the human', askedAt: '2026-10-03T00:00:00.000Z', dismissedAt: '2026-10-03T02:00:00.000Z' },
  { q: 'old two', askedAt: '2026-10-04T00:00:00.000Z' }
];
const patchAsk = (cards, body, sender = 'god') =>
  planTaskMessage({ act: 'task-patch', body, sender, isBoss: sender === 'god', tasks: cards, now: NOW, closingTime: false });

test('humanQAAppend retires every earlier open ask on the card, keeping them in history unanswered', () => {
  const plan = patchAsk([card('c', history())], { id: 'c', humanQAAppend: { q: 'newest' } });
  assert.equal(plan.ok, true, plan.reason);
  const qa = plan.patch.humanQA;
  assert.equal(qa.length, 5, 'history kept: nothing removed');
  assert.deepEqual(openAsks({ humanQA: qa }).map((e) => e.q), ['newest']);
  for (const i of [0, 3]) {
    assert.equal(qa[i].dismissedAt, NOW);
    assert.equal(qa[i].supersededBy, NOW, 'points at the askedAt of the ask that replaced it');
    assert.equal(qa[i].a, undefined, 'never fabricates an answer');
  }
  assert.deepEqual(qa[1], history()[1], 'an answered ask is untouched');
  assert.deepEqual(qa[2], history()[2], 'an ask the human dismissed keeps its own dismissal');
});

test('ask_human on a card with an open ask leaves one open ask, the new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-supersede-ask-'));
  try {
    const res = askHuman({ hiveRoot: path.join(dir, 'hive'), agentId: 'god', cardId: 'c', kind: 'decision', answers: 'yes_no', questionMd: '**Ship it?**', outboxDir: dir });
    assert.equal(res.ok, true, res.error);
    const plan = patchAsk([card('c', history())], res.patchPayload.body);
    assert.equal(plan.ok, true, plan.reason);
    assert.equal(openAsks({ humanQA: plan.patch.humanQA }).length, 1);
    assert.match(openAsks({ humanQA: plan.patch.humanQA })[0].q, /Ship it/);
  } finally { rmTree(dir); }
});

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-supersede-floor-'));
  t.after(() => rmTree(home));
  return new HiveManager(() => home);
}

test('no caller can write a card with two open asks: the ledger write retires all but the newest', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('many', history()), card('one', [{ q: 'only', askedAt: '2026-10-01T00:00:00.000Z' }])]);
  const [many, one] = hive.tasks().tasks;
  assert.deepEqual(openAsks(many).map((e) => e.q), ['old two'], 'newest open ask by ledger order stays');
  assert.equal(many.humanQA.length, 4);
  assert.equal(many.humanQA[0].supersededBy, '2026-10-04T00:00:00.000Z');
  assert.ok(many.humanQA[0].dismissedAt);
  assert.equal(many.humanQA[0].a, undefined);
  assert.deepEqual(one.humanQA, [{ q: 'only', askedAt: '2026-10-01T00:00:00.000Z' }], 'a card with one open ask is untouched');

  // A full-array patch (the renderer and phone path) cannot reopen a second ask either.
  const qa = many.humanQA.map((e) => ({ ...e, dismissedAt: undefined, supersededBy: undefined }));
  assert.equal(hive.patchTask('many', { humanQA: qa }), true);
  assert.equal(openAsks(hive.tasks().tasks[0]).length, 1);
});

test('the one-time migration backs up tasks.json, retires stale asks and reports the count', (t) => {
  const hive = floor(t);
  const root = hive.root();
  fs.mkdirSync(root, { recursive: true });
  const ledgerPath = path.join(root, 'tasks.json');
  const before = { tasks: [card('a', history()), card('b', [{ q: 'b1' }, { q: 'b2' }, { q: 'b3' }]), card('c', [{ q: 'c1' }])] };
  fs.writeFileSync(ledgerPath, JSON.stringify(before));

  const res = hive.retireSupersededAsks();
  assert.deepEqual(res.retired, [{ id: 'a', count: 1 }, { id: 'b', count: 2 }]);
  assert.ok(res.backup && fs.existsSync(res.backup), 'backup written before the change');
  assert.deepEqual(JSON.parse(fs.readFileSync(res.backup, 'utf8')), before);
  const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).tasks;
  assert.deepEqual(after.map((c) => openAsks(c).length), [1, 1, 1]);
  assert.deepEqual(openAsks(after[1]).map((e) => e.q), ['b3']);

  const again = hive.retireSupersededAsks();
  assert.deepEqual(again.retired, [], 'idempotent');
  assert.equal(again.backup, undefined, 'no backup when nothing changes');
});
