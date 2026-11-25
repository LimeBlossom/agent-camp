'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { runOpsStandup, standupTaskFingerprint, usageRefreshes, usageSnapshot } = loadTs('src/main/standupGate.ts');

const SYSTEM = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);
const T0 = 1_000_000;

function floor() {
  const state = {
    tasks: { tasks: [{ id: 'a', status: 'doing', title: 'A' }, { id: 'b', status: 'todo', humanQA: [{ q: 'ok?' }] }] },
    log: [{ ts: T0 - 10, kind: 'spawn', agentId: 'w1' }],
    mark: null, sent: 0, notes: [], logged: [], now: T0,
    windows: { claude: [], codex: [], agy: [], 'agy-claude': [] }, exhausted: []
  };
  const run = () => runOpsStandup({
    mark: () => state.mark,
    saveMark: (m) => { state.mark = m; },
    tasks: () => state.tasks,
    logTail: (n) => state.log.slice(-n),
    godId: 'god',
    systemSenders: SYSTEM,
    send: (note) => { state.sent++; state.notes.push(note); state.log.push({ ts: state.now, kind: 'message', from: 'scheduler', to: 'god', delivered: ['god'] }); },
    appendLog: (e) => { state.logged.push(e); state.log.push({ ts: state.now, ...e }); },
    now: () => state.now,
    usage: () => state.windows,
    exhausted: () => state.exhausted
  });
  return { state, run, tick: () => { state.now += 3_600_000; } };
}

test('the first standup sends; an unchanged floor then skips and logs it', () => {
  const { state, run, tick } = floor();
  assert.equal(run(), true);
  assert.equal(state.sent, 1);
  tick();
  state.log.push({ ts: state.now - 5, kind: 'message', from: 'heartbeat', to: 'god', delivered: ['god'] });
  state.log.push({ ts: state.now - 4, kind: 'unity-run', agentId: 'w1' });
  state.log.push({ ts: state.now - 3, kind: 'message', from: 'w1', to: 'w2', delivered: ['w2'] });
  state.tasks.tasks[0].notes = 'edited';
  assert.equal(run(), false);
  assert.equal(state.sent, 1);
  assert.deepEqual(state.logged, [{ kind: 'standup-skipped', since: T0 }]);
  tick();
  assert.equal(run(), false, 'a skip does not move the mark, and its own log line is not a change');
  assert.equal(state.logged.length, 2);
});

const CHANGES = {
  'a card added': (s) => { s.tasks.tasks.push({ id: 'c', status: 'todo' }); },
  'a card removed': (s) => { s.tasks.tasks.pop(); },
  'a card moved': (s) => { s.tasks.tasks[0].status = 'done'; },
  'an ASK ME answer': (s) => { s.tasks.tasks[1].humanQA[0].a = 'yes'; },
  'an agent spawn': (s) => { s.log.push({ ts: s.now - 1, kind: 'spawn', agentId: 'w2' }); },
  'an agent going dormant': (s) => { s.log.push({ ts: s.now - 1, kind: 'dormant', agentId: 'w2' }); },
  'a close for a new card': (s) => { s.log.push({ ts: s.now - 1, kind: 'card-close', agentId: 'w2' }); },
  'a limit event': (s) => { s.log.push({ ts: s.now - 1, kind: 'limit-hold', agentId: 'w2' }); },
  'mail to the Boss': (s) => { s.log.push({ ts: s.now - 1, kind: 'message', from: 'w1', to: 'boss', delivered: ['god'] }); },
  'a broadcast the Boss received': (s) => { s.log.push({ ts: s.now - 1, kind: 'message', from: 'human', to: 'broadcast', delivered: ['w1', 'god'] }); }
};

for (const [name, change] of Object.entries(CHANGES)) {
  test(`${name} since the last standup sends the next one`, () => {
    const { state, run, tick } = floor();
    run();
    tick();
    change(state);
    assert.equal(run(), true);
    assert.equal(state.sent, 2);
    assert.deepEqual(state.logged, []);
  });
}

test('a full log tail newer than the mark counts as a change', () => {
  const { state, run, tick } = floor();
  run();
  tick();
  state.log = Array.from({ length: 3000 }, (_, i) => ({ ts: state.now - 3000 + i, kind: 'unity-run' }));
  assert.equal(run(), true);
});

test('the task fingerprint ignores titles and notes', () => {
  const a = standupTaskFingerprint({ tasks: [{ id: 'x', status: 'todo', title: 'one' }] });
  assert.equal(a, standupTaskFingerprint({ tasks: [{ id: 'x', status: 'todo', title: 'two', notes: 'n' }] }));
  assert.notEqual(a, standupTaskFingerprint({ tasks: [{ id: 'x', status: 'doing' }] }));
  assert.equal(standupTaskFingerprint(null), standupTaskFingerprint({ tasks: [] }));
});

const HOUR = 3_600_000;

test('a window over 90% that reset since the last standup sends it with the reason', () => {
  const { state, run, tick } = floor();
  state.windows.codex = [{ percent: 100, resetsAtMs: T0 + HOUR / 2 }, { percent: 40, resetsAtMs: T0 + 100 * HOUR }];
  run();
  tick();
  assert.equal(run(), true);
  assert.equal(state.sent, 2);
  assert.match(state.notes[1], /codex 5h refreshed from 100%/);
  assert.deepEqual(state.logged, [{ kind: 'standup-sent', 'standup-reason': 'codex 5h refreshed from 100%' }]);
  tick();
  assert.equal(run(), false, 'the refresh is reported once; the saved window reads 0% after its reset');
});

test('a window at 85% that reset is no change for this rule', () => {
  const { state, run, tick } = floor();
  state.windows.codex = [{ percent: 85, resetsAtMs: T0 + HOUR / 2 }];
  run();
  tick();
  state.windows.codex = [{ percent: 2, resetsAtMs: T0 + 6 * HOUR }];
  assert.equal(run(), false);
  assert.equal(state.sent, 1);
});

test('no readings then or now are no change', () => {
  const { state, run, tick } = floor();
  run();
  tick();
  assert.equal(run(), false);
  const mark = { at: T0, tasks: '', usage: [{ engine: 'codex', window: '5h', percent: 100, resetsAtMs: T0 + 1 }], exhausted: ['codex'] };
  assert.deepEqual(usageRefreshes(mark, [], new Set(), T0 + HOUR), [], 'a reading gone missing never counts');
  assert.deepEqual(usageRefreshes(null, [{ engine: 'codex', window: '5h', percent: 0 }], new Set(), T0), []);
  assert.deepEqual(usageRefreshes({ at: T0, tasks: '' }, [{ engine: 'codex', window: '5h', percent: 0 }], new Set(), T0), [], 'a mark from before snapshots');
});

test('an agy pool window under 90% with a later reset counts as refreshed', () => {
  const { state, run, tick } = floor();
  state.windows['agy-claude'] = [{ percent: 30, resetsAtMs: T0 + 3 * HOUR }, { percent: 95, resetsAtMs: T0 + 50 * HOUR }];
  run();
  tick();
  state.windows['agy-claude'] = [{ percent: 30, resetsAtMs: T0 + 3 * HOUR }, { percent: 20, resetsAtMs: T0 + 200 * HOUR }];
  assert.equal(run(), true);
  assert.match(state.notes[1], /agy-claude weekly refreshed from 95%/);
});

test('an engine whose hold lifted counts as refreshed; a reading still over 90% with the same reset does not', () => {
  const { state, run, tick } = floor();
  state.windows.claude = [{ percent: 97 }, { percent: 50 }];
  state.exhausted = ['claude'];
  run();
  tick();
  assert.equal(run(), false, 'still held');
  state.exhausted = [];
  assert.equal(run(), true);
  assert.match(state.notes[1], /claude 5h refreshed from 97%/);
});

test('the snapshot names windows by position and saves a past reset at 0%', () => {
  const snap = usageSnapshot({ codex: [{ percent: 99, resetsAtMs: T0 - 1 }, undefined], agy: [undefined, { percent: 92 }] }, T0);
  assert.deepEqual(snap, [
    { engine: 'codex', window: '5h', percent: 0, resetsAtMs: T0 - 1 },
    { engine: 'agy', window: 'weekly', percent: 92 }
  ]);
});

const { standupProblems } = loadTs('src/main/standupGate.ts');

for (const boardChanged of [false, true]) {
  for (const address of ['boss', 'god', 'broadcast']) {
    test(`Boss mail vetoes quiet ack despite stale zero-backlog fleet (${address}, board changed: ${boardChanged})`, () => {
      const { state, run, tick } = floor();
      run();
      tick();
      if (boardChanged) state.tasks.tasks.push({ id: 'c', status: 'done' });
      state.log.push({ ts: state.now - 1, kind: 'message', from: 'w1', to: address, delivered: ['god'] });
      const fleet = { agents: [{ id: 'god', isGod: true, inboxBacklog: 0, lastActiveSecAgo: 60 }] };
      const tasks = { tasks: [] };
      state.tasks = tasks;
      if (!boardChanged) state.mark.tasks = standupTaskFingerprint(tasks);
      const acks = [];
      const sent = [];
      const result = runOpsStandup({
        mark: () => state.mark, saveMark: (m) => { state.mark = m; }, tasks: () => tasks,
        logTail: (n) => state.log.slice(-n), godId: 'god', systemSenders: SYSTEM,
        send: (note) => sent.push(note), appendLog: (e) => state.logged.push(e),
        now: () => state.now, problems: () => standupProblems(fleet, tasks), ack: (note) => acks.push(note)
      });
      assert.deepEqual({ result, sent: sent.length, acked: acks.length }, { result: true, sent: 1, acked: 0 },
        'fresh Boss mail must wake even when a stale snapshot reports a quiet floor or task changes mask the mail reason');
      assert.equal(state.logged.some((e) => e.kind === 'standup-acked'), false);
    });
  }
}

test('pending Boss backlog wakes on a later unchanged floor even when the mail event is behind an ack mark', () => {
  const tasks = { tasks: [] };
  const fleet = { agents: [{ id: 'god', isGod: true, inboxBacklog: 0, lastActiveSecAgo: 60 }] };
  let mark = { at: T0, tasks: 'older task fingerprint' };
  let now = T0 + HOUR;
  const log = [{ ts: T0 - 1, kind: 'message', from: 'w1', to: 'boss', delivered: ['god'] }];
  const sent = [];
  const acks = [];
  const logged = [];
  const go = () => runOpsStandup({
    mark: () => mark, saveMark: (m) => { mark = m; }, tasks: () => tasks,
    logTail: () => log, godId: 'god', systemSenders: SYSTEM,
    send: (note) => sent.push(note), appendLog: (e) => logged.push(e), now: () => now,
    problems: () => standupProblems(fleet, tasks), ack: (note) => acks.push(note)
  });
  assert.equal(go(), false, 'quiet task-board change may be acked before backlog snapshot catches up');
  assert.equal(acks.length, 1);
  assert.equal(mark.at, now);
  now += HOUR;
  fleet.agents[0].inboxBacklog = 1;
  assert.equal(go(), true, 'pending mail must be checked before skipping an unchanged floor');
  assert.equal(sent.length, 1);
  assert.equal(acks.length, 1, 'pending mail must not produce another quiet ack');
  assert.match(sent[0], /Needs you:[\s\S]*god: 1 unread/);
  assert.equal(logged.some((e) => e.kind === 'standup-skipped'), false);
});

test('standupProblems: a quiet floor is empty; stalls, stuck and unowned cards are named', () => {
  const fleet = { agents: [
    { id: 'god', isGod: true, breaker: 'healthy', lastActiveSecAgo: 99999 },
    { id: 'w1', breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0 },
    { id: 'w2', dormant: true, breaker: 'healthy' }
  ] };
  const quiet = { tasks: [
    { id: 'a', status: 'doing', assignee: 'w1' },
    { id: 'b', status: 'blocked', assignee: 'w2' },
    { id: 'c', status: 'todo', assignee: 'w2' },
    { id: 'd', status: 'doing', assignee: 'god' },
    { id: 'e', status: 'done' }
  ] };
  assert.deepEqual(standupProblems(fleet, quiet), []);
  const busy = { tasks: [...quiet.tasks, { id: 'f', status: 'doing', assignee: 'w2' }, { id: 'g', status: 'todo' }, { id: 'h', status: 'doing', assignee: 'gone' }] };
  fleet.agents[1] = { id: 'w1', breaker: 'healthy', lastActiveSecAgo: 3600, inboxBacklog: 2 };
  assert.deepEqual(standupProblems(fleet, busy), [
    'w1: 2 unread, quiet 60 min',
    'a: STALLED, doing, w1 quiet 60 min (restart_agent)',
    'f: doing, assignee w2 dormant',
    'g: todo with no assignee',
    'h: doing, assignee gone not on the floor'
  ]);
  fleet.agents[1].breaker = 'steering';
  assert.equal(standupProblems(fleet, quiet)[0], 'w1: breaker steering');
});

test('a changed floor with no problems is filed, not sent; a problem sends with a Needs you list', () => {
  const { state, run, tick } = floor();
  run();
  const acks = [];
  let problems = [];
  const go = () => runOpsStandup({
    mark: () => state.mark, saveMark: (m) => { state.mark = m; }, tasks: () => state.tasks,
    logTail: (n) => state.log.slice(-n), godId: 'god', systemSenders: SYSTEM,
    send: (note) => { state.sent++; state.notes.push(note); }, appendLog: (e) => { state.logged.push(e); state.log.push({ ts: state.now, ...e }); },
    now: () => state.now, problems: () => problems, ack: (n) => acks.push(n)
  });
  tick();
  state.tasks.tasks.push({ id: 'c', status: 'todo' });
  assert.equal(go(), false);
  assert.equal(state.sent, 1, 'the Boss is not woken');
  assert.equal(acks.length, 1);
  assert.match(acks[0], /task board/);
  assert.equal(state.logged.at(-1).kind, 'standup-acked');
  tick();
  assert.equal(go(), false, 'the ack moved the mark, so the same floor skips next hour');
  assert.equal(state.logged.at(-1).kind, 'standup-skipped');
  tick();
  state.tasks.tasks.push({ id: 'd', status: 'todo' });
  problems = ['d: todo with no assignee'];
  assert.equal(go(), true);
  assert.match(state.notes.at(-1), /Needs you:\n- d: todo with no assignee/);
});

test('standupProblems detects todo assignee missing from fleet, Boss pending mail, and awaiting-boss-merge cards', () => {
  const fleet = { agents: [
    { id: 'god', isGod: true, breaker: 'healthy', lastActiveSecAgo: 3600, inboxBacklog: 2 },
    { id: 'w1', breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0 }
  ] };
  const tasks = { tasks: [
    { id: 't1', status: 'todo', assignee: 'ghost' },
    { id: 't2', status: 'blocked', notes: 'awaiting boss merge', assignee: 'w1' }
  ] };
  const problems = standupProblems(fleet, tasks);
  assert.ok(problems.some((p) => p.includes('t1') && (p.includes('ghost') || p.includes('not on the floor'))), 'todo assignee missing from fleet must be named');
  assert.ok(problems.some((p) => (p.includes('god') || p.includes('Boss')) && p.includes('unread')), 'Boss pending mail must be named');
  assert.ok(problems.some((p) => p.includes('t2') && p.includes('awaiting boss merge')), 'awaiting-boss-merge card must be named');
});

test('runOpsStandup wakes Boss when todo assignee is missing, Boss has pending mail, or cards await merge', () => {
  const fleetWith = (agentOverrides = []) => ({
    agents: [
      { id: 'god', isGod: true, breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0, ...agentOverrides.find((a) => a.id === 'god') },
      { id: 'w1', breaker: 'healthy', lastActiveSecAgo: 60, inboxBacklog: 0, ...agentOverrides.find((a) => a.id === 'w1') }
    ]
  });

  // Test 1: todo assignee missing from fleet wakes Boss
  {
    let sent = false;
    let acked = false;
    const run = () => runOpsStandup({
      mark: () => ({ at: T0 - 3600000, tasks: '' }),
      saveMark: () => {},
      tasks: () => ({ tasks: [{ id: 't1', status: 'todo', assignee: 'missing-worker' }] }),
      logTail: () => [{ ts: T0, kind: 'task-patch' }],
      godId: 'god',
      systemSenders: SYSTEM,
      send: () => { sent = true; },
      appendLog: () => {},
      now: () => T0,
      problems: () => standupProblems(fleetWith(), { tasks: [{ id: 't1', status: 'todo', assignee: 'missing-worker' }] }),
      ack: () => { acked = true; }
    });
    assert.equal(run(), true, 'todo assignee missing from fleet must wake Boss');
    assert.equal(sent, true);
    assert.equal(acked, false);
  }

  // Test 2: Boss pending mail wakes Boss
  {
    let sent = false;
    let acked = false;
    const fleet = fleetWith([{ id: 'god', inboxBacklog: 3, lastActiveSecAgo: 3600 }]);
    const run = () => runOpsStandup({
      mark: () => ({ at: T0 - 3600000, tasks: '' }),
      saveMark: () => {},
      tasks: () => ({ tasks: [] }),
      logTail: () => [{ ts: T0, kind: 'message', to: 'god' }],
      godId: 'god',
      systemSenders: SYSTEM,
      send: () => { sent = true; },
      appendLog: () => {},
      now: () => T0,
      problems: () => standupProblems(fleet, { tasks: [] }),
      ack: () => { acked = true; }
    });
    assert.equal(run(), true, 'Boss pending mail must wake Boss');
    assert.equal(sent, true);
    assert.equal(acked, false);
  }

  // Test 3: awaiting-boss-merge cards wake Boss
  {
    let sent = false;
    let acked = false;
    const tasks = { tasks: [{ id: 'm1', status: 'blocked', notes: 'awaiting boss merge', assignee: 'w1' }] };
    const run = () => runOpsStandup({
      mark: () => ({ at: T0 - 3600000, tasks: '' }),
      saveMark: () => {},
      tasks: () => tasks,
      logTail: () => [{ ts: T0, kind: 'task-patch' }],
      godId: 'god',
      systemSenders: SYSTEM,
      send: () => { sent = true; },
      appendLog: () => {},
      now: () => T0,
      problems: () => standupProblems(fleetWith(), tasks),
      ack: () => { acked = true; }
    });
    assert.equal(run(), true, 'awaiting-boss-merge cards must wake Boss');
    assert.equal(sent, true);
    assert.equal(acked, false);
  }
});
