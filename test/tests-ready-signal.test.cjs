'use strict';

/**
 * The "red tests committed" signal: a worker's task-patch carries
 * testsReady {branch, worktree, head, then?}. The head must exist on the branch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const card = (extra = {}) => ({ id: 'c1', title: 'T', status: 'doing', assignee: 'cedar', dependsOn: [], ...extra });
const ready = (over = {}) => ({ branch: 'cedar/red', worktree: '/tmp/wt', head: HEAD.slice(0, 10), then: 'implement', uncovered: 'none', ...over });
const send = (testsReady, over = {}) => planTaskMessage({
  act: 'task-patch', sender: 'cedar', isBoss: false, tasks: [card()], now: '2026-11-12T10:00:00Z',
  body: { id: 'c1', testsReady }, headOnBranch: () => HEAD, ...over
});

test('a worker declares red tests committed; the card stores the full head and when', () => {
  const p = send(ready());
  assert.equal(p.ok, true, p.reason);
  assert.deepEqual(p.patch.testsReady, { branch: 'cedar/red', worktree: '/tmp/wt', head: HEAD, then: 'implement', uncovered: 'none', declaredAt: '2026-11-12T10:00:00Z' });
});

test('then defaults to handoff, the shape a test-only agent uses', () => {
  const p = send(ready({ then: undefined }));
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.patch.testsReady.then, 'handoff');
});

test('a head that is not on the branch is refused with the reason', () => {
  const p = send(ready(), { headOnBranch: () => null });
  assert.equal(p.ok, false);
  assert.match(p.reason, /testsReady head a1b2c3d4e5 is not a commit on cedar\/red/);
});

test('the head check is asked for the worktree, branch and head given', () => {
  const seen = [];
  send(ready(), { headOnBranch: (wt, br, h) => { seen.push([wt, br, h]); return HEAD; } });
  assert.deepEqual(seen, [['/tmp/wt', 'cedar/red', HEAD.slice(0, 10)]]);
});

test('malformed signals are refused before git is asked', () => {
  const never = () => { throw new Error('git must not be asked'); };
  for (const bad of [
    'text', null, ready({ branch: '' }), ready({ branch: '--x' }), ready({ worktree: 'rel/path' }),
    ready({ head: 'zzz' }), ready({ then: 'maybe' }), { ...ready(), extra: 1 }
  ]) {
    const p = send(bad, { headOnBranch: never });
    assert.equal(p.ok, false, JSON.stringify(bad));
    assert.match(p.reason, /testsReady/);
  }
});

test('only the assignee declares it, and the Boss may not create a card with one', () => {
  const other = planTaskMessage({ act: 'task-patch', sender: 'elm', isBoss: false, tasks: [card()], now: 'x', body: { id: 'c1', testsReady: ready() }, headOnBranch: () => HEAD });
  assert.equal(other.ok, false);
  const created = planTaskMessage({ act: 'task-create', sender: 'god', isBoss: true, tasks: [], now: 'x', body: { id: 'n', title: 'N', testsReady: ready() }, headOnBranch: () => HEAD });
  assert.equal(created.ok, false);
  assert.match(created.reason, /testsReady/);
});

test('the how-to teaches workers the field', () => {
  const { taskPatchHowTo } = loadTs('src/main/taskPatch.ts');
  assert.match(taskPatchHowTo('/o'), /testsReady/);
});

// ─── Proposal-step coverage: the handoff states what its tests leave out ────

test('testsReady must state the steps its tests do not cover, "none" included', () => {
  const never = () => { throw new Error('git must not be asked'); };
  for (const bad of [undefined, '', '   ', 7]) {
    const p = send(ready({ uncovered: bad }), { headOnBranch: never });
    assert.equal(p.ok, false, String(bad));
    assert.match(p.reason, /uncovered/);
  }
});

test('the stated uncovered steps are kept on the card', () => {
  const p = send(ready({ uncovered: 'Step 2: expiry alert and chip' }));
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.patch.testsReady.uncovered, 'Step 2: expiry alert and chip');
});

test('the worker how-to teaches the uncovered field', () => {
  const { taskPatchHowTo } = loadTs('src/main/taskPatch.ts');
  assert.match(taskPatchHowTo('/o'), /uncovered/);
});

const closeBy = (tasks, body, sender = 'god') => planTaskMessage({ act: 'task-patch', sender, isBoss: true, tasks, now: 'x', body: { id: 'c1', status: 'done', ...body } });
const withReady = (uncovered, extra = {}) => card({ testsReady: { branch: 'b', worktree: '/w', head: HEAD, then: 'handoff', uncovered, declaredAt: 'x' }, ...extra });

test('the Boss cannot close a card whose tests left steps uncovered, with no follow-up and no coverage line', () => {
  const p = closeBy([withReady('Step 2: reset UI')], { result: 'Merged ff-only' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /uncovered/);
  assert.match(p.reason, /Step 2: reset UI/);
});

test('closing is allowed once a follow-up card depends on it or names it', () => {
  const base = withReady('Step 2: reset UI');
  const dep = { id: 'f1', title: 'F', status: 'todo', dependsOn: ['c1'] };
  const named = { id: 'f2', title: 'F', status: 'todo', dependsOn: [], description: 'Follow-up of c1: reset UI' };
  assert.equal(closeBy([base, dep], {}).ok, true);
  assert.equal(closeBy([base, named], {}).ok, true);
});

test('closing is allowed when the Boss records a Coverage line for the original steps', () => {
  const base = withReady('Step 2: reset UI');
  assert.equal(closeBy([base], { result: 'Coverage: 1 abc123 test t1; 2 def456 test t2; 3 abc123 test t3' }).ok, true);
  assert.equal(closeBy([base], { notesAppend: 'Coverage: 1 a; 2 b' }).ok, true);
});

test('"none" uncovered, cards without testsReady, and harness closes are not gated', () => {
  assert.equal(closeBy([withReady('none')], {}).ok, true);
  assert.equal(closeBy([withReady('None.')], {}).ok, true);
  assert.equal(closeBy([card()], {}).ok, true);
  assert.equal(closeBy([withReady('Step 2')], {}, 'harness').ok, true);
});

test('the Boss prompt demands a step-to-commit coverage map before closing', (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  const root = hive.root();
  const prompt = hive.injectedPrompt({ id: 'god', name: 'Boss', provider: 'claude', cwd: root, isGod: true }, path.join(root, 'agents', 'god'), root, false, false, undefined, '');
  assert.match(prompt, /CLOSING A CARD/);
  assert.match(prompt, /numbered Work step/);
  const bossProto = fs.readFileSync(path.join(root, 'PROTOCOL-BOSS.md'), 'utf8');
  assert.match(bossProto, /## Closing a card/);
  assert.match(bossProto, /Steps not covered/);
});
