'use strict';

// the human can answer a result: a reply reaches the card's assignee and the Boss with the result
// quoted, and lands in the card notes; a result can become a follow-up card. A result that asks
// for the human's call is refused at resultsAppend, since a question belongs in humanQAAppend.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { askHuman } = loadTs('src/main/campTools.ts');
const { questionShapedResult } = loadTs('src/shared/resultsFeed.ts');

const RESULT_AT = '2026-11-22T07:10:00.000Z';
const RESULT = "Palette-80 shipped. Shell Charger's shell plate shipped pale cream instead of soft teal.";

async function floor(t, { assignee = 'w1' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-results-reply-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
  hive.writeTasks([{
    id: 'audit', title: 'Felt audit', assignee, status: 'blocked', project: 'Alpha', priority: 'medium', dependsOn: [],
    notes: 'earlier note',
    results: [{ text: RESULT, label: 'check', at: RESULT_AT }, { text: 'older', label: 'answer', at: '2026-11-21T00:00:00.000Z' }]
  }]);
  const card = (id) => hive.tasks().tasks.find((x) => x.id === id);
  return { hive, card };
}

test('a reply on a result mails the assignee and the Boss with the result quoted and the card id', async (t) => {
  const { hive } = await floor(t);
  const r = hive.replyToResult('audit', RESULT_AT, 'I want teal back on the shell plate.');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.assignee, 'w1');
  assert.equal(r.boss, true);
  for (const id of ['w1', 'god-1']) {
    const mail = hive.inbox(id);
    assert.equal(mail.length, 1, `${id} gets one message`);
    const m = mail[0];
    assert.match(m.subject, /audit/);
    assert.match(m.body, /audit/);
    assert.ok(m.body.includes(`> ${RESULT}`), 'the result text is quoted');
    assert.ok(m.body.includes('I want teal back on the shell plate.'));
  }
});

test('a reply on a result is appended to the card notes and leaves the card status alone', async (t) => {
  const { hive, card } = await floor(t);
  assert.equal(hive.replyToResult('audit', RESULT_AT, 'teal back please').ok, true);
  const c = card('audit');
  assert.equal(c.status, 'blocked');
  assert.match(String(c.notes), /^earlier note\n/);
  assert.match(String(c.notes), /teal back please/);
  assert.match(String(c.notes), /The human replied to result/);
});

test('a reply on a Boss-owned card mails the Boss once', async (t) => {
  const { hive } = await floor(t, { assignee: 'god-1' });
  const r = hive.replyToResult('audit', RESULT_AT, 'ok');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.assignee, null);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('a reply naming no result, or an empty reply, is refused and mails nobody', async (t) => {
  const { hive, card } = await floor(t);
  assert.equal(hive.replyToResult('audit', '1999-01-01T00:00:00.000Z', 'x').ok, false);
  assert.equal(hive.replyToResult('nope', RESULT_AT, 'x').ok, false);
  assert.equal(hive.replyToResult('audit', RESULT_AT, '   ').ok, false);
  assert.equal(hive.inbox('w1').length + hive.inbox('god-1').length, 0);
  assert.equal(card('audit').notes, 'earlier note');
});

test('make follow-up card files a todo card linked to the source with the result text', async (t) => {
  const { hive, card } = await floor(t);
  const r = hive.followUpFromResult('audit', RESULT_AT, 'Put teal back.');
  assert.equal(r.ok, true, r.error);
  const f = card(r.cardId);
  assert.ok(f, 'the card exists');
  assert.equal(f.followUpOf, 'audit');
  assert.equal(f.status, 'todo');
  assert.equal(f.project, 'Alpha');
  assert.equal(f.assignee, 'god-1', 'the Boss routes it');
  assert.ok(f.description.includes(RESULT));
  assert.ok(f.description.includes('Put teal back.'));
  assert.match(f.description, /audit/);
  assert.match(String(card('audit').notes), new RegExp(`follow-up.*${r.cardId}`));
  const boss = hive.inbox('god-1');
  assert.equal(boss.length, 1);
  assert.ok(boss[0].body.includes(r.cardId));
  const again = hive.followUpFromResult('audit', RESULT_AT, '');
  assert.equal(again.ok, true, again.error);
  assert.notEqual(again.cardId, r.cardId, 'a second follow-up gets its own id');
});

test('question-shaped result text is detected; plain reports are not', () => {
  for (const q of [
    "Shell plate shipped cream; say so if you want teal back.",
    'Want the teal back?',
    'Let me know if you prefer B.',
    'Do you want me to keep the old one?',
    'Should I revert it?',
    'Tell me if this reads wrong.'
  ]) assert.ok(questionShapedResult(q), q);
  for (const ok of [
    RESULT,
    'Merged b; the plate is teal now, as you asked.',
    'See [log](file:///tmp/a.log?x=1) for details.',
    'All 1290 tests pass.'
  ]) assert.equal(questionShapedResult(ok), null, ok);
});

test('resultsAppend refuses a question-shaped result and points at humanQAAppend', () => {
  const tasks = [{ id: 'c', title: 'C', status: 'doing', assignee: 'w1', dependsOn: [], priority: 'medium', project: 'Camp' }];
  const plan = planTaskMessage({ act: 'task-patch', sender: 'god', isBoss: true, tasks, now: RESULT_AT, closingTime: false,
    body: { id: 'c', resultsAppend: { text: 'Plate shipped cream; say so if you want teal back.', label: 'check' } } });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /humanQAAppend/);
  const fine = planTaskMessage({ act: 'task-patch', sender: 'god', isBoss: true, tasks, now: RESULT_AT, closingTime: false,
    body: { id: 'c', resultsAppend: { text: RESULT, label: 'check' } } });
  assert.equal(fine.ok, true, fine.reason);
});

test('ask_human kind result refuses question-shaped text and points at kind decision', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-results-reply-ask-'));
  t.after(() => rmTree(dir));
  const res = askHuman({ hiveRoot: path.join(dir, 'hive'), agentId: 'god', cardId: 'c', outboxDir: dir,
    kind: 'result', label: 'check', questionMd: '**Plate shipped cream.** Say so if you want teal back.' });
  assert.equal(res.ok, false);
  assert.match(res.error, /decision/);
});
