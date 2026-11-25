'use strict';

/**
 * my-tasks.md lists an agent's open cards in the order the next-card nudge and the
 * start message use (openCards), shows each card's priority, and marks a card that
 * waits on an undone dependsOn. A numeric priority never reaches tasks.json, where
 * openCards would read it as medium and the card would lose its rank.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { renderTaskView } = loadTs('src/main/taskViews.ts');
const { openCards } = loadTs('src/main/todoNudge.ts');
const { priorityLevel } = loadTs('src/shared/taskPriority.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const card = (id, status = 'todo', extra = {}) => ({ id, title: `Title ${id}`, assignee: 'bulba', status, dependsOn: [], ...extra });
const listed = (body) => [...body.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);

const ledger = [
  card('old-low', 'todo', { priority: 'low', createdAt: '2026-10-01T00:00:00Z' }),
  card('stuck', 'blocked', { priority: 'high', createdAt: '2026-09-01T00:00:00Z' }),
  card('waits', 'todo', { priority: 'high', dependsOn: ['dep-open', 'dep-done'], createdAt: '2026-09-01T00:00:00Z' }),
  card('new-none', 'todo', { createdAt: '2026-10-02T08:00:00Z' }),
  card('high', 'todo', { priority: 'high', createdAt: '2026-10-02T09:00:00Z' }),
  card('live', 'doing', { priority: 'low' }),
  { ...card('dep-open'), assignee: 'pine' },
  { ...card('dep-done', 'done'), assignee: 'pine' },
  card('finished', 'done')
];

test('my-tasks lists the nudge order first, then cards waiting on dependencies, then blocked', () => {
  const body = renderTaskView({ tasks: ledger, agentId: 'bulba', isBoss: false, tasksPath: '/hive/tasks.json' });
  const nudge = openCards('bulba', ledger).map((c) => c.id);
  assert.deepEqual(nudge, ['live', 'high', 'new-none', 'old-low']);
  assert.deepEqual(listed(body), [...nudge, 'waits', 'stuck']);
});

test('each card shows its priority; a card without one reads as medium', () => {
  const body = renderTaskView({ tasks: ledger, agentId: 'bulba', isBoss: false, tasksPath: '/hive/tasks.json' });
  assert.match(body, /^- `high` todo: Title high \[high;/m);
  assert.match(body, /^- `new-none` todo: Title new-none \[medium;/m);
  assert.match(body, /^- `old-low` todo: Title old-low \[low;/m);
});

test('a card waiting on an undone dependency names only the undone ones', () => {
  const body = renderTaskView({ tasks: ledger, agentId: 'bulba', isBoss: false, tasksPath: '/hive/tasks.json' });
  const line = body.split('\n').find((l) => l.startsWith('- `waits`'));
  assert.match(line, /waiting on `dep-open`/);
  assert.doesNotMatch(line, /dep-done/);
  assert.doesNotMatch(body.split('\n').find((l) => l.startsWith('- `high`')), /waiting on/);
});

test('the Boss view lists every open card in the same order, with assignees', () => {
  const body = renderTaskView({ tasks: ledger, agentId: 'god', isBoss: true, tasksPath: '/hive/tasks.json' });
  assert.deepEqual(listed(body), ['live', 'high', 'dep-open', 'new-none', 'old-low', 'waits', 'stuck']);
  assert.match(body, /`dep-open` todo @pine/);
});

test('a numeric priority is read on the kanban 1 to 5 scale', () => {
  assert.equal(priorityLevel(5), 'high');
  assert.equal(priorityLevel(4), 'high');
  assert.equal(priorityLevel(3), 'medium');
  assert.equal(priorityLevel(1), 'low');
  assert.equal(priorityLevel('HIGH'), 'high');
  assert.equal(priorityLevel(undefined), 'medium');
});

test('a task-patch or task-create with a priority outside high, medium, low is refused', () => {
  const tasks = [card('a')];
  const patch = planTaskMessage({ act: 'task-patch', body: { id: 'a', priority: 3 }, sender: 'god', isBoss: true, tasks, now: 'x' });
  assert.equal(patch.ok, false);
  assert.match(patch.reason, /priority must be one of high, medium, low/);
  const create = planTaskMessage({ act: 'task-create', body: { id: 'b', title: 'B', priority: 'urgent' }, sender: 'god', isBoss: true, tasks, now: 'x' });
  assert.equal(create.ok, false);
  assert.equal(planTaskMessage({ act: 'task-patch', body: { id: 'a', priority: 'High' }, sender: 'god', isBoss: true, tasks, now: 'x' }).ok, true);
});

test('writeTasks stores a numeric priority as its level, so it keeps its rank on disk', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-my-tasks-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'bulba', name: 'Bulba', provider: 'claude', cwd: home });
  hive.writeTasks([card('n5', 'todo', { priority: 5 }), card('n1', 'todo', { priority: 1 }), card('s', 'todo', { priority: 'high' })]);
  hive.addTask(card('added', 'todo', { priority: 4 }));
  const disk = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(disk.map((c) => [c.id, c.priority]), [['n5', 'high'], ['n1', 'low'], ['s', 'high'], ['added', 'high']]);
});

test('the harness writes my-tasks.md in nudge order with priorities', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-my-tasks-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'bulba', name: 'Bulba', provider: 'claude', cwd: home });
  hive.writeTasks(ledger);
  hive.refreshTaskViews(true);
  const body = fs.readFileSync(path.join(hive.agentDir('bulba'), 'my-tasks.md'), 'utf8');
  assert.deepEqual(listed(body), ['live', 'high', 'new-none', 'old-low', 'waits', 'stuck']);
  assert.match(body, /\[high;/);
});
