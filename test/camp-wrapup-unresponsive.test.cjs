'use strict';

/**
 * Camp: wrap-up always finishes when a worker can't answer.
 * Evidence 2026-11-16: wrap-up started 11:17:53Z, Cedar (frozen) and
 * worker-alpha-crystal-bite (no live process) never acked; the Boss WRAP-UP-COMPLETE
 * was rejected ('workers still missing'); the dialog sat at 0/2 for over an hour
 * until the human cancelled at 12:28:46 and closed the app by hand, losing both
 * workers' unsaved state.
 *
 * Work steps:
 * 1) workers that cannot answer (frozen, no live process, or flagged STALLED)
 *    are not waited on: the harness saves what it can (transcript snapshot,
 *    card parked blocked) and counts them done;
 * 2) the dialog names each missing worker with how long it has been silent
 *    and why, not a bare count;
 * 3) while waiting, offer 'close without <names>' to park their cards;
 * 4) Boss WRAP-UP-COMPLETE may override missing acks only for workers known
 *    frozen or dead.
 *
 * Done when a wrap-up with one frozen and one dead worker closes on its own
 * within the bounded wait, both cards parked, nothing from responsive workers lost.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const {
  ClosingTimeController,
  describeMissingWorkers,
  formatMissingWorker
} = loadTs('src/main/closingTime.ts');
const { DEFAULT_TIMINGS } = loadTs('src/main/timings.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function createFloorRig(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-wrapup-unresponsive-'));
  t.after(() => rmTree(dir));

  const hive = new HiveManager(() => dir);
  const bossId = options.bossId ?? 'boss';
  const godMeta = { id: bossId, name: 'Boss', provider: 'claude', cwd: dir, isGod: true };
  const agents = options.agents ?? [
    godMeta,
    { id: 'responsive', name: 'Birch', provider: 'claude', cwd: dir },
    { id: 'cedar', name: 'Cedar', provider: 'claude', cwd: dir },
    { id: 'worker-alpha-crystal-bite', name: 'CrystalBite', provider: 'claude', cwd: dir }
  ];

  for (const a of agents) {
    await hive.ensureAgent(a);
  }

  const initialTasks = options.tasks ?? [
    { id: 'card-responsive', title: 'Responsive work', assignee: 'responsive', status: 'doing', dependsOn: [] },
    { id: 'card-cedar', title: 'Frozen work', assignee: 'cedar', status: 'doing', dependsOn: [] },
    { id: 'card-crystal-bite', title: 'Dead process work', assignee: 'worker-alpha-crystal-bite', status: 'doing', dependsOn: [] }
  ];
  hive.writeTasks(initialTasks);

  const sent = [];
  const events = [];
  let concluded = false;

  const liveAgentIds = options.liveAgentIds ?? (() => ['boss', 'responsive', 'cedar']); // 'worker-alpha-crystal-bite' has no live process
  const workerStatus = options.workerStatus ?? ((id) => {
    if (id === 'worker-alpha-crystal-bite') {
      return { canAnswer: false, reason: 'no live process', dead: true, silentSecAgo: 7200 };
    }
    if (id === 'cedar') {
      return { canAnswer: false, reason: 'frozen', frozen: true, silentSecAgo: 3600 };
    }
    if (id === 'stalled-worker') {
      return { canAnswer: false, reason: 'STALLED', stalled: true, silentSecAgo: 3000 };
    }
    return { canAnswer: true, reason: 'active', silentSecAgo: 10 };
  });

  const webContents = {
    send: (channel, data) => {
      if (channel === 'app:closingTime') events.push(data);
    }
  };

  const onConcluded = () => { concluded = true; };

  const ct = new ClosingTimeController(
    hive,
    typeof liveAgentIds === 'function' ? liveAgentIds : () => liveAgentIds,
    () => webContents,
    onConcluded,
    options.control,
    workerStatus,
    options.deps
  );

  hive.setClosingTimeSource(() => ct.isActive());
  hive.setRoutedObserver((msg, targets) => ct.onRouted(msg, targets));

  t.after(() => ct.cancel());

  return {
    dir,
    hive,
    ct,
    sent,
    events,
    getConcluded: () => concluded,
    cards: () => hive.tasks().tasks
  };
}

// ─── STEP 1: Workers that cannot answer are not waited on ───────────────────

test('Step 1: workers that cannot answer (no live process, frozen, STALLED) are not waited on and counted done', async (t) => {
  const rig = await createFloorRig(t);
  const { ct, cards, events } = rig;

  const result = ct.start();
  assert.equal(result.ok, true, 'closing time must start');

  // CrystalBite has no live process; Cedar is frozen.
  // 1) The harness must park their cards as blocked with parkedFrom recorded
  const currentCards = cards();
  const deadCard = currentCards.find((c) => c.id === 'card-crystal-bite');
  const frozenCard = currentCards.find((c) => c.id === 'card-cedar');
  const responsiveCard = currentCards.find((c) => c.id === 'card-responsive');

  assert.equal(deadCard.status, 'blocked', 'worker with no live process must have card parked blocked');
  assert.equal(deadCard.parkedFrom, 'doing', 'parkedFrom must preserve original status');
  assert.equal(frozenCard.status, 'blocked', 'frozen worker must have card parked blocked');
  assert.equal(frozenCard.parkedFrom, 'doing', 'parkedFrom must preserve original status');
  assert.equal(responsiveCard.status, 'doing', 'responsive worker card remains doing until it packs up');

  // 2) The harness counts unresponsive workers done immediately so wrap-up is not held
  assert.equal(ct.isAcked('worker-alpha-crystal-bite'), true, 'dead worker is counted done');
  assert.equal(ct.isAcked('cedar'), true, 'frozen worker is counted done');
  assert.equal(ct.isAcked('responsive'), false, 'responsive worker still needs to ACK');

  // 3) Progress event reflects that only the responsive worker is pending
  const latestEvent = events.at(-1);
  assert.ok(latestEvent, 'progress event must be emitted');
  assert.equal(latestEvent.acked, 2, '2 unresponsive workers counted done');
  assert.equal(latestEvent.total, 3, 'total 3 workers');
});

test('Step 1: transcript snapshot / handoff is saved for unresponsive workers', async (t) => {
  let snapshotSaved = [];
  const rig = await createFloorRig(t, {
    deps: {
      saveSnapshot: async (id) => { snapshotSaved.push(id); }
    }
  });

  rig.ct.start();
  assert.ok(
    snapshotSaved.includes('worker-alpha-crystal-bite') && snapshotSaved.includes('cedar'),
    'transcript snapshot must be saved for unresponsive workers'
  );
});

// ─── STEP 2: Dialog names missing workers with silence duration and reason ──

test('Step 2: ClosingTimeEvent includes missing worker names, silence duration, and reason', async (t) => {
  const rig = await createFloorRig(t);
  const { ct, events } = rig;
  ct.start();

  const startedEvent = events[0];
  assert.ok(startedEvent, 'started event emitted');
  assert.ok(Array.isArray(startedEvent.missing), 'event must carry missing workers list');

  // Only responsive worker is missing (not yet acked); unresponsive ones were counted done
  const missing = startedEvent.missing;
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, 'responsive');
  assert.equal(missing[0].name, 'Birch');
  assert.equal(typeof missing[0].silentSecAgo, 'number');
  assert.ok(missing[0].reason, 'missing worker must carry reason why it is pending');
});

test('Step 2: formatMissingWorker and describeMissingWorkers format duration and reason', () => {
  assert.equal(typeof formatMissingWorker, 'function', 'formatMissingWorker helper must exist');
  assert.equal(typeof describeMissingWorkers, 'function', 'describeMissingWorkers helper must exist');

  const formatted = formatMissingWorker({
    id: 'cedar',
    name: 'Cedar',
    silentSecAgo: 3600,
    reason: 'frozen'
  });
  assert.match(formatted, /Cedar/, 'names worker');
  assert.match(formatted, /60 min|1 hr|3600s/i, 'names silence duration');
  assert.match(formatted, /frozen/i, 'names reason');

  const deadFormatted = formatMissingWorker({
    id: 'worker-alpha-crystal-bite',
    name: 'CrystalBite',
    silentSecAgo: 7200,
    reason: 'no live process'
  });
  assert.match(deadFormatted, /CrystalBite/);
  assert.match(deadFormatted, /no live process/i);

  const summary = describeMissingWorkers([
    { id: 'cedar', name: 'Cedar', silentSecAgo: 3600, reason: 'frozen' },
    { id: 'worker-alpha-crystal-bite', name: 'CrystalBite', silentSecAgo: 7200, reason: 'no live process' }
  ]);
  assert.match(summary, /Cedar/);
  assert.match(summary, /CrystalBite/);
});

test('Step 2: QuitWarningModal renders missing workers with silence and reason, not bare count', () => {
  const modalSrc = read('src/renderer/src/components/QuitWarningModal.tsx');
  assert.match(modalSrc, /missing/i, 'QuitWarningModal must reference missing workers');
  assert.match(modalSrc, /silent|reason/i, 'QuitWarningModal must display silence duration and reason');
});

// ─── STEP 3: After bounded wait offer "close without <names>" ───────────────

test('Step 3: closeWithout parks missing workers cards and concludes wrap-up', async (t) => {
  const rig = await createFloorRig(t, {
    workerStatus: (id) => ({ canAnswer: true, reason: 'active', silentSecAgo: 10 }) // all alive
  });
  const { ct, cards, getConcluded } = rig;
  ct.start();

  // No one has acked yet
  assert.equal(ct.isAcked('responsive'), false);
  assert.equal(ct.isAcked('cedar'), false);

  // Invoke closeWithout for cedar and worker-alpha-crystal-bite
  ct.closeWithout(['cedar', 'worker-alpha-crystal-bite']);

  const currentCards = cards();
  assert.equal(currentCards.find((c) => c.id === 'card-cedar').status, 'blocked', 'card parked');
  assert.equal(currentCards.find((c) => c.id === 'card-crystal-bite').status, 'blocked', 'card parked');
  assert.equal(ct.isAcked('cedar'), true, 'excused worker counted done');
  assert.equal(ct.isAcked('worker-alpha-crystal-bite'), true, 'excused worker counted done');

  // Responsive worker sends ACK -> wrap up concludes cleanly
  ct.onRouted({ from: 'responsive', subject: 'WRAP-UP-ACK' }, ['boss']);
  ct.onRouted({ from: 'boss', subject: 'WRAP-UP-COMPLETE' }, ['human']);

  assert.equal(getConcluded(), true, 'wrap up concludes without hung workers');
});

test('Step 3: QuitWarningModal offers "close without" while workers are pending', () => {
  const modalSrc = read('src/renderer/src/components/QuitWarningModal.tsx');
  assert.match(modalSrc, /close without/i, 'QuitWarningModal must offer "close without" button');
});

// ─── STEP 4: Boss WRAP-UP-COMPLETE may override missing acks only for frozen or dead ──

test('Step 4: Boss WRAP-UP-COMPLETE overrides missing acks for workers known frozen or dead', async (t) => {
  const rig = await createFloorRig(t, {
    // Both unresponsive workers start in roster but simulate not auto-marked at start
    workerStatus: (id) => {
      if (id === 'cedar') return { canAnswer: false, reason: 'frozen', frozen: true, silentSecAgo: 3600 };
      if (id === 'worker-alpha-crystal-bite') return { canAnswer: false, reason: 'no live process', dead: true, silentSecAgo: 7200 };
      return { canAnswer: true, reason: 'active', silentSecAgo: 0 };
    }
  });
  const { ct, cards, getConcluded } = rig;
  ct.start();

  // Responsive worker acks
  ct.onRouted({ from: 'responsive', subject: 'WRAP-UP-ACK' }, ['boss']);

  // Boss sends WRAP-UP-COMPLETE even though cedar and crystal-bite never sent WRAP-UP-ACK
  ct.onRouted({ from: 'boss', subject: 'WRAP-UP-COMPLETE' }, ['human']);

  // Should NOT be refused; it overrides missing acks for known frozen/dead workers
  assert.equal(getConcluded(), true, 'Boss WRAP-UP-COMPLETE overrides frozen/dead workers');
  const currentCards = cards();
  assert.equal(currentCards.find((c) => c.id === 'card-cedar').status, 'blocked', 'card parked on override');
  assert.equal(currentCards.find((c) => c.id === 'card-crystal-bite').status, 'blocked', 'card parked on override');
});

test('Step 4: Boss WRAP-UP-COMPLETE is REJECTED if any responsive worker has not acked', async (t) => {
  const rig = await createFloorRig(t, {
    workerStatus: (id) => {
      if (id === 'cedar') return { canAnswer: false, reason: 'frozen', frozen: true, silentSecAgo: 3600 };
      return { canAnswer: true, reason: 'active', silentSecAgo: 5 }; // 'responsive' is healthy
    }
  });
  const { ct, hive, getConcluded } = rig;
  ct.start();

  // Boss tries to send WRAP-UP-COMPLETE before responsive worker acks
  ct.onRouted({ from: 'boss', subject: 'WRAP-UP-COMPLETE' }, ['human']);

  assert.equal(getConcluded(), false, 'WRAP-UP-COMPLETE must be rejected while responsive worker has not acked');
  const bossInbox = hive.inbox('boss');
  assert.ok(
    bossInbox.some((m) => m.subject.includes('conclusion rejected') && m.body.includes('Birch')),
    'refusal message must name the responsive worker'
  );
});

// ─── DONE WHEN: Wrap-up with one frozen and one dead worker closes on its own ─────────

test('Done when: wrap-up with one frozen and one dead worker closes on its own within bounded wait, cards parked', async (t) => {
  t.mock?.timers?.enable?.({ apis: ['Date', 'setTimeout'], now: Date.now() });

  const rig = await createFloorRig(t, {
    workerStatus: (id) => {
      if (id === 'cedar') return { canAnswer: false, reason: 'frozen', frozen: true, silentSecAgo: 3600 };
      if (id === 'worker-alpha-crystal-bite') return { canAnswer: false, reason: 'no live process', dead: true, silentSecAgo: 7200 };
      return { canAnswer: true, reason: 'active', silentSecAgo: 0 };
    }
  });

  const { ct, cards, getConcluded } = rig;
  ct.start();

  // Responsive worker saves work and sends ACK
  ct.onRouted({ from: 'responsive', subject: 'WRAP-UP-ACK' }, ['boss']);
  assert.equal(cards().find((c) => c.id === 'card-responsive').status, 'doing', 'responsive card not disrupted');

  // Cedar and CrystalBite cannot answer. Bounded wait timeout elapses.
  if (t.mock?.timers) {
    t.mock.timers.tick(DEFAULT_TIMINGS.closingTimeoutMs + 1000);
  } else {
    ct.handleTimeout?.();
  }

  // Wrap-up closes on its own within the bounded wait
  assert.equal(getConcluded(), true, 'wrap-up must close on its own within bounded wait');
  assert.equal(cards().find((c) => c.id === 'card-cedar').status, 'blocked', 'frozen card parked blocked');
  assert.equal(cards().find((c) => c.id === 'card-crystal-bite').status, 'blocked', 'dead card parked blocked');
  assert.equal(cards().find((c) => c.id === 'card-responsive').status, 'doing', 'nothing from responsive worker lost');
});
