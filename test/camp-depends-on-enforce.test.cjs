'use strict';

/**
 * TDD Contract & Failing Tests: dependsOn enforcement for Camp tasks.
 *
 * Card: camp-depends-on-enforce
 *
 * Requirements:
 * 1. A card whose dependsOn contains any card not done must not wake or start its assignee:
 *    - Dormant wake (dormantWakeReason) suppresses waking on cards with unmet dependencies.
 *    - Next-card dispatch / stop-hook nudge (openCards) excludes cards with unmet dependencies.
 *    - Starting a card (moving to 'doing') via task-patch is refused while dependencies are open.
 * 2. Auto-release: when all dependencies reach 'done', the card dynamically becomes eligible
 *    for todo/doing wake and dispatch without requiring disk mutations.
 * 3. Validation:
 *    - Dependency ID that does not exist is refused in task-create and task-patch.
 *    - Direct self-dependency and circular dependency chains (cycles) are refused.
 * 4. Architectural decision:
 *    Dynamic harness eligibility is chosen over forcing 'blocked' status on disk because:
 *    a) Preserves intended status ('todo') without ambiguous 'blocked' overloading.
 *    b) Zero disk churn / zero migration or complex unblock cascade when dependencies finish.
 *    c) Safe against race conditions and avoids accidentally unblocking cards waiting on human QA.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.HIVE_ROOT; // validate projects against the bundled list, not the ambient hive
const loadTs = require('../test-support/load-ts.cjs');

// Load module contracts
const {
  validateDependencies,
  isBlockedByDeps,
  getUnmetDependencies,
  canStartTask,
  findDependents
} = loadTs('src/shared/taskDeps.ts');

const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { dormantWakeReason } = loadTs('src/shared/dormantWake.ts');
const { openCards } = loadTs('src/main/todoNudge.ts');
const { createCard } = loadTs('src/main/campTools.ts');

const card = (id, status = 'todo', extra = {}) => ({
  id,
  title: `Task ${id}`,
  status,
  assignee: 'willow',
  dependsOn: [],
  ...extra
});

// ── 1. Contract & Exports ───────────────────────────────────────────────────

test('taskDeps contract exports required validation and eligibility functions', () => {
  assert.equal(typeof validateDependencies, 'function');
  assert.equal(typeof isBlockedByDeps, 'function');
  assert.equal(typeof getUnmetDependencies, 'function');
  assert.equal(typeof canStartTask, 'function');
  assert.equal(typeof findDependents, 'function');
});

// ── 2. Dependency Graph Validation (Missing IDs & Cycles) ───────────────────

test('validateDependencies: rejects dependency ID that does not exist', () => {
  const tasks = [card('dep-1', 'done')];
  const res = validateDependencies('card-a', ['dep-1', 'nonexistent-card'], tasks);
  assert.equal(res.valid, false);
  assert.match(res.reason, /nonexistent-card/i);
});

test('validateDependencies: rejects self-dependency', () => {
  const tasks = [card('card-a', 'todo')];
  const res = validateDependencies('card-a', ['card-a'], tasks);
  assert.equal(res.valid, false);
  assert.match(res.reason, /cannot depend on itself|self/i);
});

test('validateDependencies: rejects direct 2-node cycle (A -> B -> A)', () => {
  const tasks = [
    card('card-a', 'todo', { dependsOn: ['card-b'] }),
    card('card-b', 'todo')
  ];
  // Attempting to make card-b depend on card-a forms a cycle: card-b -> card-a -> card-b
  const res = validateDependencies('card-b', ['card-a'], tasks);
  assert.equal(res.valid, false);
  assert.match(res.reason, /cycle|circular/i);
});

test('validateDependencies: rejects transitive multi-node cycle (A -> B -> C -> A)', () => {
  const tasks = [
    card('card-a', 'todo', { dependsOn: ['card-b'] }),
    card('card-b', 'todo', { dependsOn: ['card-c'] }),
    card('card-c', 'todo')
  ];
  // Attempting to make card-c depend on card-a creates a 3-node loop
  const res = validateDependencies('card-c', ['card-a'], tasks);
  assert.equal(res.valid, false);
  assert.match(res.reason, /cycle|circular/i);
});

test('validateDependencies: rejects cycle introduced during new card creation', () => {
  // Existing card-a already has dependsOn ['new-card'] (pre-declared reference)
  const tasks = [
    card('card-a', 'todo', { dependsOn: ['new-card'] })
  ];
  const res = validateDependencies('new-card', ['card-a'], tasks);
  assert.equal(res.valid, false);
  assert.match(res.reason, /cycle|circular/i);
});

test('validateDependencies: accepts valid DAG and empty dependencies', () => {
  const tasks = [
    card('root-1', 'done'),
    card('root-2', 'done'),
    card('mid-1', 'todo', { dependsOn: ['root-1', 'root-2'] }),
    card('mid-2', 'todo', { dependsOn: ['root-1'] })
  ];
  // Diamond graph: leaf depends on mid-1 and mid-2
  const resValid = validateDependencies('leaf', ['mid-1', 'mid-2'], tasks);
  assert.equal(resValid.valid, true);

  // Empty list
  assert.equal(validateDependencies('leaf', [], tasks).valid, true);
  // Undefined
  assert.equal(validateDependencies('leaf', undefined, tasks).valid, true);
});

// ── 3. Status Checking & Eligibility Predicates ─────────────────────────────

test('isBlockedByDeps & getUnmetDependencies: detects open vs done dependencies', () => {
  const tasks = [
    card('dep-done', 'done'),
    card('dep-open-todo', 'todo'),
    card('dep-open-doing', 'doing'),
    card('dep-open-blocked', 'blocked')
  ];

  // No dependencies: never blocked
  const cNoDeps = card('c0', 'todo', { dependsOn: [] });
  assert.equal(isBlockedByDeps(cNoDeps, tasks), false);
  assert.deepEqual(getUnmetDependencies(cNoDeps, tasks), []);

  // All dependencies done: unblocked
  const cAllDone = card('c1', 'todo', { dependsOn: ['dep-done'] });
  assert.equal(isBlockedByDeps(cAllDone, tasks), false);
  assert.deepEqual(getUnmetDependencies(cAllDone, tasks), []);

  // Dependencies in todo, doing, or blocked: blocked
  const cOpen = card('c2', 'todo', { dependsOn: ['dep-done', 'dep-open-todo', 'dep-open-doing'] });
  assert.equal(isBlockedByDeps(cOpen, tasks), true);
  assert.deepEqual(getUnmetDependencies(cOpen, tasks), ['dep-open-todo', 'dep-open-doing']);

  const cBlockedDep = card('c3', 'todo', { dependsOn: ['dep-open-blocked'] });
  assert.equal(isBlockedByDeps(cBlockedDep, tasks), true);
  assert.deepEqual(getUnmetDependencies(cBlockedDep, tasks), ['dep-open-blocked']);
});

test('canStartTask: allows starting only when all dependencies are done', () => {
  const tasks = [
    card('proposal', 'doing'),
    card('mockup', 'todo', { dependsOn: ['proposal'] })
  ];

  const before = canStartTask(tasks[1], tasks);
  assert.equal(before.ok, false);
  assert.match(before.reason, /proposal/i);

  // Transition proposal to done
  tasks[0].status = 'done';

  const after = canStartTask(tasks[1], tasks);
  assert.equal(after.ok, true);
});

// ── 4. Task Creation Enforcement (planTaskMessage task-create) ──────────────

test('task-create: refuses unknown dependency IDs', () => {
  const tasks = [card('existing', 'done')];
  const body = {
    title: 'New card',
    assignee: 'willow',
    dependsOn: ['ghost-task']
  };
  const plan = planTaskMessage({
    act: 'task-create',
    body,
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /ghost-task/i);
});

test('task-create: refuses dependency cycle', () => {
  const tasks = [
    card('task-a', 'todo', { dependsOn: ['task-b'] })
  ];
  const body = {
    id: 'task-b',
    title: 'Task B',
    assignee: 'willow',
    dependsOn: ['task-a']
  };
  const plan = planTaskMessage({
    act: 'task-create',
    body,
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /cycle|circular/i);
});

test('task-create: accepts valid dependencies and preserves todo status for auto-release', () => {
  const tasks = [card('proposal', 'doing')];
  const body = {
    id: 'mockup',
    title: 'Alpha mound mockup',
    assignee: 'willow',
    dependsOn: ['proposal'],
    status: 'todo'
  };
  const plan = planTaskMessage({
    act: 'task-create',
    body,
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.card.id, 'mockup');
  assert.equal(plan.card.status, 'todo', 'status remains todo; harness dynamically treats it as held');
  assert.deepEqual(plan.card.dependsOn, ['proposal']);
});

// ── 5. Task Patch Enforcement (planTaskMessage task-patch) ──────────────────

test('task-patch: refuses invalid dependency changes (missing ID and cycle)', () => {
  const tasks = [
    card('task-1', 'todo'),
    card('task-2', 'todo', { dependsOn: ['task-1'] })
  ];

  // Refuse nonexistent ID
  const p1 = planTaskMessage({
    act: 'task-patch',
    body: { id: 'task-1', dependsOn: ['missing-id'] },
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(p1.ok, false);
  assert.match(p1.reason, /missing-id/i);

  // Refuse cycle
  const p2 = planTaskMessage({
    act: 'task-patch',
    body: { id: 'task-1', dependsOn: ['task-2'] },
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(p2.ok, false);
  assert.match(p2.reason, /cycle|circular/i);
});

test('task-patch: refuses moving to doing while dependencies are not done', () => {
  const tasks = [
    card('proposal', 'todo'),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'] })
  ];

  // Worker attempt refused
  const workerPlan = planTaskMessage({
    act: 'task-patch',
    body: { id: 'mockup', status: 'doing' },
    sender: 'willow',
    isBoss: false,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(workerPlan.ok, false);
  assert.match(workerPlan.reason, /dependencies are not done|proposal/i);

  // Boss attempt also refused while dependency is open
  const bossPlan = planTaskMessage({
    act: 'task-patch',
    body: { id: 'mockup', status: 'doing' },
    sender: 'god',
    isBoss: true,
    tasks,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(bossPlan.ok, false);
  assert.match(bossPlan.reason, /dependencies are not done|proposal/i);

  // When proposal is marked done, worker can move to doing
  const tasksDone = [
    card('proposal', 'done'),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'] })
  ];
  const okPlan = planTaskMessage({
    act: 'task-patch',
    body: { id: 'mockup', status: 'doing' },
    sender: 'willow',
    isBoss: false,
    tasks: tasksDone,
    now: '2026-11-05T12:00:00Z'
  });
  assert.equal(okPlan.ok, true);
  assert.equal(okPlan.patch.status, 'doing');
});

// ── 6. Dormant Wake Suppression (dormantWakeReason) ─────────────────────────

test('dormantWakeReason: suppresses wake when todo card has open dependencies', () => {
  const tasks = [
    card('proposal', 'doing', { assignee: 'hazel' }),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'] })
  ];

  // Willow must NOT wake because mockup depends on unfinished proposal
  const reasonBefore = dormantWakeReason('willow', tasks, []);
  assert.equal(reasonBefore, null, 'dormant agent must stay asleep when dependencies are open');

  // Once proposal is done, Willow auto-wakes on mockup without card status mutation
  const tasksAfter = [
    card('proposal', 'done', { assignee: 'hazel' }),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'] })
  ];
  const reasonAfter = dormantWakeReason('willow', tasksAfter, []);
  assert.deepEqual(reasonAfter, { taskIds: ['mockup'], messageIds: [] }, 'auto-releases to wake once deps reach done');
});

test('dormantWakeReason: wakes only on unblocked cards when agent has multiple cards', () => {
  const tasks = [
    card('dep', 'todo', { assignee: 'hazel' }),
    card('blocked-task', 'todo', { assignee: 'willow', dependsOn: ['dep'] }),
    card('free-task', 'todo', { assignee: 'willow', dependsOn: [] })
  ];

  const reason = dormantWakeReason('willow', tasks, []);
  assert.deepEqual(reason, { taskIds: ['free-task'], messageIds: [] }, 'includes only tasks with satisfied dependencies');
});

// ── 7. Stop Hook & Next-Card Nudge (openCards) ──────────────────────────────

test('openCards: excludes cards with open dependencies from next-card dispatch', () => {
  const tasks = [
    card('proposal', 'doing', { assignee: 'hazel' }),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'], priority: 'high' }),
    card('unrelated', 'todo', { assignee: 'willow', dependsOn: [], priority: 'low' })
  ];

  // mockup is higher priority, but blocked by deps; openCards must skip it and return unrelated
  const openBefore = openCards('willow', tasks);
  assert.deepEqual(openBefore.map((c) => c.id), ['unrelated']);

  // Once proposal is done, mockup is immediately open and takes top priority
  const tasksAfter = [
    card('proposal', 'done', { assignee: 'hazel' }),
    card('mockup', 'todo', { assignee: 'willow', dependsOn: ['proposal'], priority: 'high' }),
    card('unrelated', 'todo', { assignee: 'willow', dependsOn: [], priority: 'low' })
  ];
  const openAfter = openCards('willow', tasksAfter);
  assert.deepEqual(openAfter.map((c) => c.id), ['mockup', 'unrelated']);
});

test('openCards: returns empty list when all assigned cards are waiting on dependencies', () => {
  const tasks = [
    card('upstream', 'doing', { assignee: 'hazel' }),
    card('downstream', 'todo', { assignee: 'willow', dependsOn: ['upstream'] })
  ];
  const open = openCards('willow', tasks);
  assert.deepEqual(open, [], 'agent has no actionable work and should not start downstream');
});

// ── 8. campTools createCard Wiring ──────────────────────────────────────────

test('createCard: forwards dependsOn array in task-create outbox payload', () => {
  const res = createCard({
    title: 'Alpha Mound Mockup',
    assignee: 'willow',
    project: 'General',
    dependsOn: ['proposal-123'],
    outboxDir: '/tmp'
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.createPayload.body.dependsOn, ['proposal-123']);
});
