'use strict';

// ASK ME holds only decisions that block work on the human's answer. Answers to the human's own
// questions and passed final checks go to a Results feed that needs no reply.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { askHuman, CAMP_MCP_TOOLS, handleCampMcpCall } = loadTs('src/main/campTools.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { resultsFeed, unseenResultCount } = (() => { try { return loadTs('src/shared/resultsFeed.ts'); } catch { return {}; } })();
const { startPhoneServer } = loadTs('src/main/phone.ts');

const NOW = '2026-11-21T05:00:00.000Z';
const openAsks = (card) => (card.humanQA ?? []).filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);
const card = (id, extra = {}) => ({ id, title: `Title ${id}`, status: 'doing', assignee: 'hazel', dependsOn: [], priority: 'medium', project: 'Camp', ...extra });
const patch = (cards, body, sender = 'god') =>
  planTaskMessage({ act: 'task-patch', body, sender, isBoss: sender === 'god', tasks: cards, now: NOW, closingTime: false });

function ask(t, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-results-ask-'));
  t.after(() => rmTree(dir));
  return askHuman({ hiveRoot: path.join(dir, 'hive'), agentId: 'god', cardId: 'c', outboxDir: dir, resolveHeadFn: () => 'abcdef1234567890', ...opts });
}

// 1. ask_human takes a required kind.

test('ask_human refuses a call with no kind, and the MCP schema requires it', (t) => {
  const res = ask(t, { questionMd: '**Ship it?**', answers: 'yes_no' });
  assert.equal(res.ok, false);
  assert.match(res.error, /kind/);
  for (const name of ['ask_human', 'ask_human']) {
    const tool = CAMP_MCP_TOOLS.find((x) => x.name === name);
    assert.ok(tool.inputSchema.required.includes('kind'), `${name} requires kind`);
    assert.deepEqual([...tool.inputSchema.properties.kind.enum].sort(), ['decision', 'result']);
  }
  const bad = ask(t, { kind: 'notice', questionMd: '**Ship it?**', answers: 'yes_no' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /decision.*result|result.*decision/);
});

test('a decision must be answerable: options named in the question, or yes/no', (t) => {
  const none = ask(t, { kind: 'decision', questionMd: '**FYI the build is merged.**' });
  assert.equal(none.ok, false, 'no answers given');
  assert.match(none.error, /answers/);

  const one = ask(t, { kind: 'decision', questionMd: '**Pick A?**\n- **A.** only one', answers: ['A'] });
  assert.equal(one.ok, false, 'a single option is not a choice');

  const missing = ask(t, { kind: 'decision', questionMd: '**Pick one**\n- **A.** red\n- **B.** blue', answers: ['A', 'C'] });
  assert.equal(missing.ok, false, 'an option the question never offers');
  assert.match(missing.error, /C/);

  const ab = ask(t, { kind: 'decision', questionMd: '**Pick one**\n- **A.** red\n- **B.** blue', answers: ['A', 'B'] });
  assert.equal(ab.ok, true, ab.error);
  assert.equal(ab.patchPayload.body.status, 'blocked', 'a decision blocks the card');
  assert.ok(ab.patchPayload.body.humanQAAppend);
  assert.equal(ab.patchPayload.body.resultsAppend, undefined);

  const yn = ask(t, { kind: 'decision', questionMd: '**Ship it?**', answers: 'yes_no' });
  assert.equal(yn.ok, true, yn.error);
  assert.equal(yn.patchPayload.body.status, 'blocked');
});

test('merge sign-off (on_approve) stays a decision and is answerable as approve/reject', (t) => {
  const onApprove = { type: 'merge', repo: '/r', worktree: '/w', branch: 'b', target: 'main' };
  const ok = ask(t, { kind: 'decision', questionMd: '**Merge b?**', onApprove });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.patchPayload.body.status, 'blocked');
  assert.ok(ok.patchPayload.body.approveAction);

  const asResult = ask(t, { kind: 'result', label: 'check', questionMd: '**Merged b.**', onApprove });
  assert.equal(asResult.ok, false, 'a sign-off cannot be filed as a result');
  assert.match(asResult.error, /on_approve/);
});

test('a result never blocks the card and never lands in humanQA', (t) => {
  const res = ask(t, { kind: 'result', label: 'answer', questionMd: '**Steam takes 30%.** Source: the partner docs.' });
  assert.equal(res.ok, true, res.error);
  const body = res.patchPayload.body;
  assert.equal(body.status, undefined, 'status untouched');
  assert.equal(body.humanQAAppend, undefined);
  assert.equal(body.approveAction, undefined);
  assert.equal(body.resultsAppend.label, 'answer');
  assert.match(body.resultsAppend.text, /Steam takes 30%/);

  const noLabel = ask(t, { kind: 'result', questionMd: '**Merged.**' });
  assert.equal(noLabel.ok, false, 'a result says whether it answers a question or reports a passed check');
  assert.match(noLabel.error, /label/);
  const badLabel = ask(t, { kind: 'result', label: 'fyi', questionMd: '**Merged.**' });
  assert.equal(badLabel.ok, false);
});

test('the MCP handler passes kind, answers and label through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-results-mcp-'));
  try {
    const ctx = { hiveRoot: path.join(dir, 'hive'), agentId: 'god', outboxDir: dir };
    const r = handleCampMcpCall('ask_human', { card_id: 'c', kind: 'result', label: 'check', question_md: '**Passed: try it in the editor.**' }, ctx);
    assert.equal(r.isError, undefined, r.content[0].text);
    const d = handleCampMcpCall('ask_human', { card_id: 'c', kind: 'decision', answers: ['A', 'B'], question_md: '**Pick**\n- **A.** x\n- **B.** y' }, ctx);
    assert.equal(d.isError, undefined, d.content[0].text);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).body);
    assert.equal(files[0].resultsAppend.label, 'check');
    assert.equal(files[1].status, 'blocked');
  } finally { rmTree(dir); }
});

// 2. Ledger: results on the card via resultsAppend; supersede stays decisions-only.

test('resultsAppend appends {text, label, at} newest last and leaves status and asks alone', () => {
  const qa = [{ q: '**Pick A or B?**', askedAt: '2026-11-20T00:00:00.000Z' }];
  const prior = [{ text: 'old', label: 'check', at: '2026-11-19T00:00:00.000Z', seenAt: '2026-11-19T01:00:00.000Z' }];
  const plan = patch([card('c', { status: 'blocked', humanQA: qa, results: prior })], { id: 'c', resultsAppend: { text: 'Merged, try it in the editor.', label: 'check' } });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.patch.status, undefined);
  assert.equal(plan.patch.humanQA, undefined, 'the open decision is not superseded by a result');
  assert.deepEqual(plan.patch.results, [prior[0], { text: 'Merged, try it in the editor.', label: 'check', at: NOW }]);
});

test('resultsAppend is validated and boss-only, like humanQAAppend', () => {
  const cards = [card('c')];
  assert.equal(patch(cards, { id: 'c', resultsAppend: { text: '' , label: 'check' } }).ok, false);
  assert.equal(patch(cards, { id: 'c', resultsAppend: { text: 'x', label: 'note' } }).ok, false);
  assert.equal(patch(cards, { id: 'c', resultsAppend: 'x' }).ok, false);
  assert.equal(patch(cards, { id: 'c', resultsAppend: { text: 'x', label: 'answer' } }, 'hazel').ok, false, 'a worker reports to the boss, not to the human');
});

test('a decision asked after results still supersedes only earlier decisions', () => {
  const qa = [{ q: 'old decision', askedAt: '2026-11-19T00:00:00.000Z' }];
  const results = [{ text: 'a result', label: 'answer', at: '2026-11-20T00:00:00.000Z' }];
  const plan = patch([card('c', { status: 'blocked', humanQA: qa, results })], { id: 'c', status: 'blocked', humanQAAppend: { q: 'new decision' } });
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(openAsks({ humanQA: plan.patch.humanQA }).map((e) => e.q), ['new decision']);
  assert.equal(plan.patch.results, undefined, 'results untouched');
});

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-results-floor-'));
  t.after(() => rmTree(home));
  return new HiveManager(() => home);
}

test('marking results seen stamps every unseen result once and leaves seen ones alone', (t) => {
  const hive = floor(t);
  hive.writeTasks([
    card('a', { results: [{ text: 'r1', label: 'check', at: '2026-11-20T00:00:00.000Z' }, { text: 'r0', label: 'answer', at: '2026-11-19T00:00:00.000Z', seenAt: '2026-11-19T05:00:00.000Z' }] }),
    card('b', { results: [{ text: 'r2', label: 'answer', at: '2026-11-21T00:00:00.000Z' }] }),
    card('c')
  ]);
  assert.equal(hive.markResultsSeen(NOW), 2);
  const [a, b, c] = hive.tasks().tasks;
  assert.equal(a.results[0].seenAt, NOW);
  assert.equal(a.results[1].seenAt, '2026-11-19T05:00:00.000Z');
  assert.equal(b.results[0].seenAt, NOW);
  assert.equal(c.results, undefined);
  assert.equal(hive.markResultsSeen(NOW), 0, 'idempotent');
});

// 3. The feed both the Results tab and the phone list by.

test('resultsFeed lists every result newest first with its card, and counts the unseen', () => {
  const tasks = [
    card('a', { results: [{ text: 'r1', label: 'check', at: '2026-11-20T00:00:00.000Z' }, { text: 'r0', label: 'answer', at: '2026-11-19T00:00:00.000Z', seenAt: '2026-11-19T05:00:00.000Z' }] }),
    card('b', { results: [{ text: 'r2', label: 'answer', at: '2026-11-21T00:00:00.000Z' }], backloggedAt: '2026-11-21T01:00:00.000Z' }),
    card('c', { humanQA: [{ q: 'a decision' }] }),
    { id: 'junk', results: [null, { label: 'check' }, 'x'] }
  ];
  const feed = resultsFeed(tasks);
  assert.deepEqual(feed.map((r) => r.text), ['r2', 'r1', 'r0']);
  assert.deepEqual(feed[0], { cardId: 'b', title: 'Title b', project: 'Camp', text: 'r2', label: 'answer', at: '2026-11-21T00:00:00.000Z', seen: false });
  assert.equal(feed[2].seen, true);
  assert.equal(unseenResultCount(tasks), 2);
  assert.ok(!feed.some((r) => r.text === 'a decision'), 'decisions never appear');
});

test('a result is never listed on ASK ME or as a phone ask; the phone gets the results feed', async () => {
  const tasks = [
    card('dec', { status: 'blocked', humanQA: [{ q: '**Pick?** A or B', askedAt: '2026-11-20T00:00:00.000Z' }] }),
    card('res', { status: 'blocked', results: [{ text: 'Merged.', label: 'check', at: '2026-11-21T00:00:00.000Z' }] })
  ];
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (cb) => { handler = cb; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer({ token: () => 'secret', state: () => ({ agents: [] }), tasks: () => ({ tasks }), patchTask: () => true, sendToGod: () => {}, enqueue: () => false, roots: () => [] }));
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  const state = await new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url: '/api/state', method: 'GET', headers: { authorization: 'Bearer secret' } });
    req.destroy = () => reject(new Error('destroyed'));
    handler(req, { writeHead() {}, setHeader() {}, end(raw) { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } } });
  });
  assert.deepEqual(state.asks.map((a) => a.id), ['dec']);
  assert.deepEqual(state.results.map((r) => [r.cardId, r.text, r.label]), [['res', 'Merged.', 'check']]);
});

// 4. One-time migration: the boss names which open asks are notices.

function seeded(t, tasks, list) {
  const hive = floor(t);
  const root = hive.root();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }));
  if (list !== undefined) fs.writeFileSync(path.join(root, 'results-migration.json'), JSON.stringify(list));
  return { hive, root };
}

test('the migration moves only the boss-listed open asks to results, backs up first, and reports the count', (t) => {
  const tasks = [
    card('notice', { status: 'blocked', humanQA: [{ q: 'answered long ago', a: 'yes', askedAt: '2026-11-01T00:00:00.000Z' }, { q: '**Merged, try it in the editor.**', askedAt: '2026-11-20T00:00:00.000Z' }] }),
    card('answer', { status: 'blocked', humanQA: [{ q: '**Steam takes 30%.**', askedAt: '2026-11-20T02:00:00.000Z' }] }),
    card('decision', { status: 'blocked', humanQA: [{ q: '**Merged? Pick A or B**', askedAt: '2026-11-20T03:00:00.000Z' }] }),
    card('closed', { status: 'blocked', humanQA: [{ q: 'done', a: 'ok' }] })
  ];
  const { hive, root } = seeded(t, tasks, { cards: [{ id: 'notice', label: 'check' }, { id: 'answer', label: 'answer' }, { id: 'closed', label: 'check' }, { id: 'gone', label: 'check' }] });
  const before = fs.readFileSync(path.join(root, 'tasks.json'), 'utf8');

  const res = hive.moveNoticesToResults();
  assert.deepEqual(res.moved, ['notice', 'answer']);
  assert.deepEqual(res.skipped.sort(), ['closed', 'gone'], 'listed cards with no open ask, or no card, are reported, not guessed at');
  assert.ok(res.backup && fs.readFileSync(res.backup, 'utf8') === before, 'backup is the ledger before the change');

  const after = Object.fromEntries(hive.tasks().tasks.map((c) => [c.id, c]));
  assert.deepEqual(openAsks(after.notice), []);
  assert.deepEqual(after.notice.results, [{ text: '**Merged, try it in the editor.**', label: 'check', at: '2026-11-20T00:00:00.000Z' }]);
  assert.equal(after.notice.humanQA.length, 2, 'history kept');
  assert.equal(after.notice.humanQA[1].a, undefined, 'never fabricates an answer');
  assert.ok(after.notice.humanQA[1].movedToResultsAt);
  assert.equal(after.answer.results[0].label, 'answer');
  assert.deepEqual(openAsks(after.decision).map((e) => e.q), ['**Merged? Pick A or B**'], 'an unlisted card is untouched, whatever its wording');

  assert.equal(fs.existsSync(path.join(root, 'results-migration.json')), false, 'the list is consumed so it cannot move a later decision');
  const again = hive.moveNoticesToResults();
  assert.deepEqual(again.moved, []);
  assert.equal(again.backup, undefined, 'no list, no backup, no write');
});

test('the migration refuses a list entry without a valid label and changes nothing', (t) => {
  const tasks = [card('n', { status: 'blocked', humanQA: [{ q: 'notice' }] })];
  const { hive, root } = seeded(t, tasks, { cards: [{ id: 'n' }] });
  const res = hive.moveNoticesToResults();
  assert.deepEqual(res.moved, []);
  assert.match(res.error, /label/);
  assert.equal(res.backup, undefined);
  assert.deepEqual(openAsks(hive.tasks().tasks[0]).map((e) => e.q), ['notice']);
  assert.equal(fs.existsSync(path.join(root, 'results-migration.json')), true, 'a bad list stays for the boss to fix');
});

test('the phone page has a Results tab and opening it posts results/seen', async () => {
  const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
  assert.match(PHONE_PAGE, /data-tab="results"/);
  assert.match(PHONE_PAGE, /\/api\/results\/seen/);
  let handler, seen = 0;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (cb) => { handler = cb; return { on() {}, listen() {} }; };
    startPhoneServer({ token: () => 'secret', state: () => ({ agents: [] }), tasks: () => ({ tasks: [] }), patchTask: () => true, sendToGod: () => {}, enqueue: () => false, roots: () => [], markResultsSeen: () => { seen++; return 3; } });
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  const out = await new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { url: '/api/results/seen', method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' } });
    req.destroy = () => reject(new Error('destroyed'));
    handler(req, { writeHead() {}, setHeader() {}, end(raw) { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } } });
    process.nextTick(() => { req.emit('data', Buffer.from('{}')); req.emit('end'); });
  });
  assert.deepEqual(out, { ok: true, count: 3 });
  assert.equal(seen, 1);
});
