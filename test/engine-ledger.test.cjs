'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { summarizeLedger, ledgerTable, ledgerSummaryMarkdown } = loadTs('src/main/engineLedger.ts');

const DAY = 86_400_000;
const NOW = 100 * DAY;
const ledger = [
  { ts: NOW - DAY, kind: 'start', workerId: 'w1', provider: 'antigravity', chosenBy: 'ladder' },
  { ts: NOW - DAY + 1, kind: 'end', workerId: 'w1', outcome: 'done', durationMs: 10 * 60_000 },
  { ts: NOW - 2 * DAY, kind: 'start', workerId: 'w2', provider: 'antigravity', chosenBy: 'ladder' },
  { ts: NOW - 2 * DAY + 1, kind: 'end', workerId: 'w2', outcome: 'reaped-idle', durationMs: 30 * 60_000 },
  { ts: NOW - 3 * DAY, kind: 'start', workerId: 'w3', provider: 'codex', chosenBy: 'ladder' },
  { ts: NOW - 30 * DAY, kind: 'start', workerId: 'old', provider: 'claude', chosenBy: 'named' },
  { ts: NOW - 30 * DAY + 1, kind: 'end', workerId: 'old', outcome: 'done', durationMs: 5 * 60_000 }
].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';

test('summarizeLedger groups by engine, counts outcomes and still-running workers', () => {
  const rows = summarizeLedger(ledger, NOW - 7 * DAY);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { engine: 'antigravity [ladder]', effort: '-', runs: 2, running: 0, outcomes: { done: 1, 'reaped-idle': 1 }, medianMinutes: 20 });
  assert.deepEqual(rows[1], { engine: 'codex [ladder]', effort: '-', runs: 1, running: 1, outcomes: {}, medianMinutes: null });
});

test('the time window drops older workers; no window keeps them', () => {
  assert.equal(summarizeLedger(ledger, NOW - 7 * DAY).some((r) => r.engine.startsWith('claude')), false);
  assert.equal(summarizeLedger(ledger).some((r) => r.engine === 'claude [named]'), true);
});

test('ledgerTable renders rows and an empty case', () => {
  const t = ledgerTable(summarizeLedger(ledger, NOW - 7 * DAY));
  assert.match(t, /\| antigravity \[ladder\] \| - \| 2 \| done 1, reaped-idle 1 \| 20\.0 \|/);
  assert.match(t, /\| codex \[ladder\] \| - \| 1 \| 1 still running \| - \|/);
  assert.equal(ledgerTable([]), 'No temporary workers.');
});

test('ledgerSummaryMarkdown carries both windows', () => {
  const md = ledgerSummaryMarkdown(ledger, NOW);
  assert.match(md, /## Last 7 days[\s\S]*codex \[ladder\][\s\S]*## All time[\s\S]*claude \[named\]/);
});

test('workers split by effort, and the table shows it', () => {
  const text = [
    { ts: NOW, kind: 'start', workerId: 'a', provider: 'claude', chosenBy: 'ladder', effort: 'medium' },
    { ts: NOW, kind: 'end', workerId: 'a', outcome: 'done', durationMs: 6 * 60_000, effort: 'medium' },
    { ts: NOW, kind: 'start', workerId: 'b', provider: 'claude', chosenBy: 'ladder', effort: 'xhigh' },
    { ts: NOW, kind: 'end', workerId: 'b', outcome: 'done', durationMs: 20 * 60_000, effort: 'xhigh' }
  ].map((e) => JSON.stringify(e)).join('\n');
  const rows = summarizeLedger(text);
  assert.deepEqual(rows.map((r) => [r.effort, r.medianMinutes]).sort(), [['medium', 6], ['xhigh', 20]]);
  assert.match(ledgerTable(rows), /\| claude \[ladder\] \| xhigh \| 1 \| done 1 \| 20\.0 \|/);
});
