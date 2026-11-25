'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { latestNoteAwaitingMerge } = loadTs('src/main/taskPatch.ts');
const { standupProblems } = loadTs('src/main/standupGate.ts');
const { isHeldByOtherReason } = loadTs('src/main/autoUnblockDependents.ts');
const { notesAwaitingMerge } = loadTs('src/main/approvedMerge.ts');

const fleet = { agents: [{ id: 'w1', breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0 }] };
const SUPERSEDED = '11-20 done, awaiting boss merge\n11-21 06:45 boss standup: nothing to merge (Steamworks-only). Waits on shots.';
const CURRENT = '11-20 started\n11-21 awaiting boss merge, sha abc123';

test('latestNoteAwaitingMerge reads only the last non-empty note line or array entry', () => {
  assert.equal(latestNoteAwaitingMerge(SUPERSEDED), false);
  assert.equal(latestNoteAwaitingMerge(CURRENT), true);
  assert.equal(latestNoteAwaitingMerge(CURRENT + '\n\n  '), true);
  assert.equal(latestNoteAwaitingMerge(['awaiting boss merge', 'nothing to merge here']), false);
  assert.equal(latestNoteAwaitingMerge(['started', 'awaiting boss merge']), true);
  assert.equal(latestNoteAwaitingMerge('03:46 not awaiting boss merge: waits on shots'), false);
  assert.equal(latestNoteAwaitingMerge('no longer awaiting boss merge'), false);
  assert.equal(latestNoteAwaitingMerge(undefined), false);
  assert.equal(latestNoteAwaitingMerge(''), false);
});

test('standup flags a blocked card only when its latest note awaits merge', () => {
  const tasks = { tasks: [
    { id: 'stale', status: 'blocked', assignee: 'w1', notes: SUPERSEDED },
    { id: 'live', status: 'blocked', assignee: 'w1', notes: CURRENT }
  ] };
  const problems = standupProblems(fleet, tasks);
  assert.ok(!problems.some((p) => p.startsWith('stale:')), `superseded merge note must not flag: ${problems.join(' | ')}`);
  assert.ok(problems.includes('live: awaiting boss merge'), `latest merge note must flag: ${problems.join(' | ')}`);
});

test('auto-unblock holds a card on merge only when its latest note awaits merge', () => {
  assert.equal(isHeldByOtherReason({ id: 'stale', status: 'blocked', notes: SUPERSEDED }), false);
  assert.equal(isHeldByOtherReason({ id: 'live', status: 'blocked', notes: CURRENT }), true);
});

test('approvedMerge notesAwaitingMerge is the shared rule', () => {
  assert.equal(notesAwaitingMerge, latestNoteAwaitingMerge);
});
