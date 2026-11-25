'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { ASK_ANSWERS_DIR, RELAY_VIA, listOpenAsks, writeAskAnswer, applyAskAnswers } = loadTs('src/main/askRelay.ts');
const { PROPOSE_MCP_TOOLS, handleProposeMcpCall } = loadTs('src/main/cardProposals.ts');

const OPEN_Q = 'Did the earlyoom sudo changes land?';

function cards() {
  return [
    {
      id: 'host-earlyoom-tune', title: 'Tune earlyoom', status: 'blocked', assignee: 'cedar-x',
      humanQA: [
        { q: 'Old question', a: 'old answer', askedAt: '2026-11-20T00:00:00.000Z', answeredAt: '2026-11-20T01:00:00.000Z' },
        { q: OPEN_Q, askedAt: '2026-11-24T10:00:00.000Z' }
      ]
    },
    { id: 'answered-only', title: 'Answered', status: 'todo', humanQA: [{ q: 'Q', a: 'A' }] },
    { id: 'dismissed-only', title: 'Dismissed', status: 'blocked', humanQA: [{ q: 'Q', dismissedAt: '2026-11-24T00:00:00.000Z' }] },
    { id: 'no-qa', title: 'Plain', status: 'todo' }
  ];
}

function tmpHive(tasks = cards()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-relay-'));
  const hiveRoot = path.join(dir, 'hive');
  fs.mkdirSync(hiveRoot, { recursive: true });
  fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify({ tasks }));
  return { dir, hiveRoot };
}

const readTasks = (hiveRoot) => JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'));
const pending = (hiveRoot) => {
  const d = path.join(hiveRoot, ASK_ANSWERS_DIR);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : [];
};

/** A harness stand-in that applies patches to the temp tasks.json, as HiveManager.patchTask does. */
function harness(hiveRoot) {
  const calls = { patches: [], routed: [], rejected: [] };
  return {
    calls,
    deps: {
      tasks: () => readTasks(hiveRoot),
      patchTask: (id, patch) => {
        calls.patches.push({ id, patch });
        const ledger = readTasks(hiveRoot);
        const i = ledger.tasks.findIndex((t) => t.id === id);
        if (i < 0) return false;
        ledger.tasks[i] = { ...ledger.tasks[i], ...patch, id };
        fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify(ledger));
        return true;
      },
      routeAnswer: (id, q, a) => calls.routed.push({ id, q, a }),
      reject: (relay, reason) => calls.rejected.push({ relay, reason })
    }
  };
}

test('listOpenAsks returns each card with an open ASK ME and its question, skipping answered and dismissed ones', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const before = fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8');
    const asks = listOpenAsks(hiveRoot);
    assert.deepEqual(asks.map((a) => a.cardId), ['host-earlyoom-tune']);
    assert.equal(asks[0].question, OPEN_Q);
    assert.equal(asks[0].title, 'Tune earlyoom');
    assert.equal(asks[0].askedAt, '2026-11-24T10:00:00.000Z');
    assert.equal(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'), before, 'list_open_asks is read-only');
  } finally { rmTree(dir); }
});

test('writeAskAnswer refuses an unknown card id and writes nothing', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const r = writeAskAnswer(hiveRoot, { cardId: 'no-such-card', answer: 'done' }, '/src/a');
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown card/i);
    assert.deepEqual(pending(hiveRoot), []);
  } finally { rmTree(dir); }
});

test('writeAskAnswer refuses a card with no open ASK ME (none, answered or dismissed)', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    for (const id of ['no-qa', 'answered-only', 'dismissed-only']) {
      const r = writeAskAnswer(hiveRoot, { cardId: id, answer: 'done' }, '/src/a');
      assert.equal(r.ok, false, id);
      assert.match(r.error, /no open ask/i, id);
    }
    assert.deepEqual(pending(hiveRoot), []);
  } finally { rmTree(dir); }
});

test('writeAskAnswer refuses an empty answer', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    assert.match(writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: '  ' }, '/src/a').error, /answer/i);
    assert.deepEqual(pending(hiveRoot), []);
  } finally { rmTree(dir); }
});

test('writeAskAnswer queues the answer for the harness without touching tasks.json, and returns the card id and question', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const before = fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8');
    const r = writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: ' done ' }, '/media/vault');
    assert.equal(r.ok, true);
    assert.equal(r.cardId, 'host-earlyoom-tune');
    assert.equal(r.question, OPEN_Q);
    assert.equal(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8'), before, 'the harness stays the only writer of tasks.json');
    const files = pending(hiveRoot);
    assert.equal(files.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(hiveRoot, ASK_ANSWERS_DIR, files[0]), 'utf8'));
    assert.equal(saved.cardId, 'host-earlyoom-tune');
    assert.equal(saved.q, OPEN_Q);
    assert.equal(saved.answer, 'done');
    assert.equal(saved.via, 'camp-propose');
    assert.equal(saved.source, '/media/vault');
  } finally { rmTree(dir); }
});

test('applyAskAnswers records the answer on the open humanQA entry with via camp-propose and routes it like a UI answer', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: 'done' }, '/media/vault');
    const h = harness(hiveRoot);
    assert.equal(applyAskAnswers(hiveRoot, h.deps), 1);
    const card = readTasks(hiveRoot).tasks.find((t) => t.id === 'host-earlyoom-tune');
    const entry = card.humanQA.find((e) => e.q === OPEN_Q);
    assert.equal(entry.a, 'done');
    assert.ok(entry.answeredAt);
    assert.equal(entry.via, RELAY_VIA);
    assert.equal(RELAY_VIA, 'camp-propose');
    assert.equal(entry.relayedFrom, '/media/vault');
    assert.equal(card.humanQA[0].a, 'old answer', 'earlier entries are untouched');
    assert.equal(card.humanQA[0].via, undefined);
    assert.equal(card.status, 'blocked', 'applying never sets card status itself; routeAnswer does what the UI path does');
    assert.deepEqual(h.calls.routed, [{ id: 'host-earlyoom-tune', q: OPEN_Q, a: 'done' }]);
    assert.deepEqual(pending(hiveRoot), [], 'an applied answer leaves the queue');
    assert.equal(fs.readdirSync(path.join(hiveRoot, ASK_ANSWERS_DIR, '.done')).length, 1);
    assert.equal(applyAskAnswers(hiveRoot, h.deps), 0, 'an applied answer is never applied twice');
    assert.equal(h.calls.routed.length, 1);
  } finally { rmTree(dir); }
});

test('applyAskAnswers sets no status and closes nothing: the patch carries only humanQA', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: 'done' }, '/x');
    const h = harness(hiveRoot);
    applyAskAnswers(hiveRoot, h.deps);
    assert.deepEqual(h.calls.patches.map((p) => Object.keys(p.patch)), [['humanQA']]);
  } finally { rmTree(dir); }
});

test('applyAskAnswers rejects an answer whose question changed since it was queued, and tells the caller why', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: 'done' }, '/x');
    const ledger = readTasks(hiveRoot);
    ledger.tasks[0].humanQA[1].a = 'answered in the UI first';
    fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify(ledger));
    const h = harness(hiveRoot);
    assert.equal(applyAskAnswers(hiveRoot, h.deps), 0);
    assert.equal(h.calls.patches.length, 0);
    assert.equal(h.calls.routed.length, 0);
    assert.equal(h.calls.rejected.length, 1);
    assert.equal(h.calls.rejected[0].relay.cardId, 'host-earlyoom-tune');
    assert.match(h.calls.rejected[0].reason, /no longer open|changed/i);
    assert.deepEqual(pending(hiveRoot), []);
    assert.equal(fs.readdirSync(path.join(hiveRoot, ASK_ANSWERS_DIR, '.failed')).length, 1);
  } finally { rmTree(dir); }
});

test('applyAskAnswers leaves the file queued when the ledger write fails, so it retries', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    writeAskAnswer(hiveRoot, { cardId: 'host-earlyoom-tune', answer: 'done' }, '/x');
    const h = harness(hiveRoot);
    assert.equal(applyAskAnswers(hiveRoot, { ...h.deps, patchTask: () => false }), 0);
    assert.equal(pending(hiveRoot).length, 1);
    assert.equal(h.calls.routed.length, 0);
  } finally { rmTree(dir); }
});

test('the camp-propose MCP exposes propose_card, answer_ask and list_open_asks, and nothing that sets status or closes a card', () => {
  assert.deepEqual(PROPOSE_MCP_TOOLS.map((t) => t.name).sort(), ['answer_ask', 'list_open_asks', 'propose_card']);
  const answer = PROPOSE_MCP_TOOLS.find((t) => t.name === 'answer_ask');
  assert.deepEqual([...answer.inputSchema.required].sort(), ['answer', 'cardId']);
  assert.equal(answer.inputSchema.properties.status, undefined);
});

test('answer_ask over MCP returns the card id and question on success, and isError on both rejections', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const ok = handleProposeMcpCall('answer_ask', { cardId: 'host-earlyoom-tune', answer: 'done' }, { hiveRoot, cwd: '/src/a' });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0].text, /host-earlyoom-tune/);
    assert.ok(ok.content[0].text.includes(OPEN_Q));
    const unknown = handleProposeMcpCall('answer_ask', { cardId: 'nope', answer: 'done' }, { hiveRoot, cwd: '/src/a' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown card/i);
    const none = handleProposeMcpCall('answer_ask', { cardId: 'no-qa', answer: 'done' }, { hiveRoot, cwd: '/src/a' });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /no open ask/i);
  } finally { rmTree(dir); }
});

test('list_open_asks over MCP lists card ids and questions', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const r = handleProposeMcpCall('list_open_asks', {}, { hiveRoot, cwd: '/src/a' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /host-earlyoom-tune/);
    assert.ok(r.content[0].text.includes(OPEN_Q));
    assert.doesNotMatch(r.content[0].text, /no-qa|answered-only|dismissed-only/);
  } finally { rmTree(dir); }
});
