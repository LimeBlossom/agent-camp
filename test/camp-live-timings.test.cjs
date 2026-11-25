'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts tests
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-timings-userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userDataDir } }
};

const { DEFAULT_TIMINGS, getTimings, syncTimers, armLive, stopLive, LiveTimer } = loadTs('src/main/timings.ts');
const { writeConfig, readConfig, startConfigWatcher } = loadTs('src/main/config.ts');
const { CrashTracker } = loadTs('src/main/crashRevive.ts');
const { ClosingTimeController } = loadTs('src/main/closingTime.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');
const { runOpsStandup, standupTaskFingerprint } = loadTs('src/main/standupGate.ts');

test.after(() => rmTree(userDataDir));

function resetConfig(overrides = {}) {
  const p = path.join(userDataDir, 'config.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ harnessHome: userDataDir, ...overrides }, null, 2), 'utf8');
}

// ─── Requirement 1: Defaults apply when key is absent ─────────────────────────

test('Item 1: DEFAULT_TIMINGS defines default cadences and caps for all camp intervals', () => {
  // Index.ts timer cadences
  assert.equal(DEFAULT_TIMINGS.workerTickMs, 1_500, 'workerTickMs default must be 1.5s');
  assert.equal(DEFAULT_TIMINGS.gcSweepMs, 60_000, 'gcSweepMs default must be 60s');
  assert.equal(DEFAULT_TIMINGS.limitPollMs, 20_000, 'limitPollMs default must be 20s');
  assert.equal(DEFAULT_TIMINGS.fleetSnapshotMs, 8_000, 'fleetSnapshotMs default must be 8s');
  assert.equal(DEFAULT_TIMINGS.breakerBeatMs, 30_000, 'breakerBeatMs default must be 30s');
  assert.equal(DEFAULT_TIMINGS.phoneServerMs, 30_000, 'phoneServerMs default must be 30s');

  // Guardrail caps & thresholds
  assert.equal(DEFAULT_TIMINGS.crashMaxInWindow, 3, 'crashMaxInWindow default must be 3');
  assert.equal(DEFAULT_TIMINGS.crashWindowMs, 1_800_000, 'crashWindowMs default must be 30m');
  assert.equal(DEFAULT_TIMINGS.crashBackoffBaseMs, 30_000, 'crashBackoffBaseMs default must be 30s');
  assert.equal(DEFAULT_TIMINGS.closingTimeoutMs, 360_000, 'closingTimeoutMs default must be 6m');
  assert.equal(DEFAULT_TIMINGS.closingTeardownGraceMs, 2_500, 'closingTeardownGraceMs default must be 2.5s');
  assert.equal(DEFAULT_TIMINGS.standupRefreshPercent, 90, 'standupRefreshPercent default must be 90%');
  assert.equal(DEFAULT_TIMINGS.standupLogTail, 3000, 'standupLogTail default must be 3000 lines');
  assert.equal(DEFAULT_TIMINGS.repeatedToolLimit, 8, 'repeatedToolLimit default must be 8');
  assert.equal(DEFAULT_TIMINGS.errorStormLimit, 5, 'errorStormLimit default must be 5');
  assert.equal(DEFAULT_TIMINGS.tokenVelocityPerMin, 60_000, 'tokenVelocityPerMin default must be 60_000');
  assert.equal(DEFAULT_TIMINGS.breakerProgressToolWindowMs, 300_000, 'breakerProgressToolWindowMs default must be 5m');
  assert.equal(DEFAULT_TIMINGS.breakerNoProgressBeats, 2, 'breakerNoProgressBeats default must be 2');
});

test('Item 2: getTimings falls back to DEFAULT_TIMINGS when config has no timings key', () => {
  resetConfig({});
  const cfg = readConfig();
  assert.equal(cfg.timings, undefined, 'fresh config must not have timings set');

  const resolved = getTimings(cfg);
  assert.deepEqual(resolved, DEFAULT_TIMINGS, 'getTimings with absent key must return DEFAULT_TIMINGS');

  const emptyResolved = getTimings({});
  assert.deepEqual(emptyResolved, DEFAULT_TIMINGS, 'getTimings with empty object must return DEFAULT_TIMINGS');

  const nullResolved = getTimings(null);
  assert.deepEqual(nullResolved, DEFAULT_TIMINGS, 'getTimings with null must return DEFAULT_TIMINGS');
});

test('Item 3: getTimings merges custom timings overrides preserving defaults for unset keys', () => {
  const customConfig = {
    timings: {
      workerTickMs: 2500,
      crashMaxInWindow: 5,
      closingTimeoutMs: 120_000
    }
  };
  const resolved = getTimings(customConfig);
  assert.equal(resolved.workerTickMs, 2500, 'custom workerTickMs must override default');
  assert.equal(resolved.crashMaxInWindow, 5, 'custom crashMaxInWindow must override default');
  assert.equal(resolved.closingTimeoutMs, 120_000, 'custom closingTimeoutMs must override default');
  assert.equal(resolved.standupRefreshPercent, 90, 'unset standupRefreshPercent must retain default');
  assert.equal(resolved.fleetSnapshotMs, 8_000, 'unset fleetSnapshotMs must retain default');
});

// ─── Requirement 2: Changed timing takes effect without restart ────────────────

test('Item 4: LiveTimer reschedules next tick when timings cadence changes without process restart', (t) => {
  t.mock.timers.enable();
  let ticks = 0;
  let interval = 1500;
  const timer = new LiveTimer(() => { ticks++; }, () => interval);

  timer.start();
  t.after(() => timer.stop());

  t.mock.timers.tick(1500);
  assert.equal(ticks, 1, 'timer must fire after initial 1500ms');

  // Change interval live without restart
  interval = 500;
  t.mock.timers.tick(500);
  assert.equal(ticks, 2, 'timer must fire after new 500ms interval without restart');

  t.mock.timers.tick(500);
  assert.equal(ticks, 3, 'timer must continue firing at new 500ms cadence');
});

test('Item 5: syncTimers clears and re-arms active timers with updated cadences from config', (t) => {
  t.mock.timers.enable();
  let fleetTicks = 0;
  let breakerTicks = 0;

  const timers = {
    fleetTimer: setInterval(() => { fleetTicks++; }, 8_000),
    breakerBeatTimer: setInterval(() => { breakerTicks++; }, 30_000)
  };
  t.after(() => {
    if (timers.fleetTimer) clearInterval(timers.fleetTimer);
    if (timers.breakerBeatTimer) clearInterval(timers.breakerBeatTimer);
  });

  t.mock.timers.tick(8_000);
  assert.equal(fleetTicks, 1);
  assert.equal(breakerTicks, 0);

  // Sync timers with new configuration: fleet 2s, breaker 5s
  syncTimers(timers, {
    timings: {
      fleetSnapshotMs: 2_000,
      breakerBeatMs: 5_000
    }
  });

  t.mock.timers.tick(2_000);
  assert.equal(fleetTicks, 2, 'fleet timer must tick at updated 2000ms period');
  assert.equal(breakerTicks, 0);

  t.mock.timers.tick(3_000); // 5000ms mark
  assert.equal(breakerTicks, 1, 'breaker beat must tick at updated 5000ms period');
});

test('Item 5b: armLive records its own callback and period, so syncTimers re-arms without timer internals', (t) => {
  t.mock.timers.enable();
  let ticks = 0;
  const timers = {};
  armLive(timers, 'fleetTimer', () => { ticks++; }, { timings: { fleetSnapshotMs: 4_000 } });
  t.after(() => stopLive(timers, 'fleetTimer'));
  assert.equal(timers.fleetTimer.periodMs, 4_000);

  t.mock.timers.tick(4_000);
  assert.equal(ticks, 1);

  // Same period: the armed handle (and its phase) is kept.
  const before = timers.fleetTimer.handle;
  syncTimers(timers, { timings: { fleetSnapshotMs: 4_000 } });
  assert.equal(timers.fleetTimer.handle, before, 'unchanged period must not re-arm');

  // Changed period: re-armed from the record alone.
  syncTimers(timers, { timings: { fleetSnapshotMs: 1_000 } });
  assert.equal(timers.fleetTimer.periodMs, 1_000);
  t.mock.timers.tick(1_000);
  assert.equal(ticks, 2, 'timer must tick at the new 1000ms period');

  stopLive(timers, 'fleetTimer');
  assert.equal(timers.fleetTimer, null);
  t.mock.timers.tick(5_000);
  assert.equal(ticks, 2, 'a stopped timer must not tick');
});

test('Item 6: config watcher reload applies updated timings to active timers without restart', async (t) => {
  resetConfig({ timings: { workerTickMs: 1500 } });
  let activeInterval = readConfig().timings?.workerTickMs ?? 1500;

  const watcher = startConfigWatcher({
    debounceMs: 20,
    onReload: (next) => {
      // In Step 2, watcher reload triggers timer sync
      syncTimers({}, next);
      activeInterval = getTimings(next).workerTickMs;
    }
  });
  t.after(() => watcher.close());

  assert.equal(activeInterval, 1500);

  // Write new timing to config.json
  writeConfig({ timings: { workerTickMs: 400 } });
  for (const end = Date.now() + 10000; activeInterval !== 400 && Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(activeInterval, 400, 'active workerTickMs must update to 400ms via config reload');
});

// ─── Requirement 3: Cap change is honoured on next use ─────────────────────────

test('Item 7: CrashTracker honours crashMaxInWindow from live config on next crash', () => {
  resetConfig({ timings: { crashMaxInWindow: 1 } });
  const tracker = new CrashTracker();
  const t0 = 1_000_000;

  // With crashMaxInWindow=1, the very first crash must exceed the cap and not revive
  const first = tracker.record('worker-a', t0);
  assert.equal(
    first.revive,
    false,
    'with crashMaxInWindow=1 from config, first crash must NOT revive'
  );

  // Update cap dynamically to 5
  writeConfig({ timings: { crashMaxInWindow: 5 } });
  const second = tracker.record('worker-b', t0);
  assert.equal(second.revive, true, 'worker-b crash 1 with cap=5 must revive');
  const third = tracker.record('worker-b', t0 + 60_000);
  assert.equal(third.revive, true, 'worker-b crash 2 with cap=5 must revive');
  const fourth = tracker.record('worker-b', t0 + 120_000);
  assert.equal(fourth.revive, true, 'worker-b crash 3 with cap=5 must revive');
  const fifth = tracker.record('worker-b', t0 + 180_000);
  assert.equal(fifth.revive, true, 'worker-b crash 4 with cap=5 must revive');
  const sixth = tracker.record('worker-b', t0 + 240_000);
  assert.equal(sixth.revive, false, 'worker-b crash 5 with cap=5 must halt');
});

test('Item 8: CrashTracker honours crashBackoffBaseMs and crashWindowMs from live config on next crash', () => {
  resetConfig({
    timings: {
      crashBackoffBaseMs: 10_000,
      crashWindowMs: 300_000 // 5 minutes
    }
  });
  const tracker = new CrashTracker();
  const t0 = 1_000_000;

  const first = tracker.record('worker-c', t0);
  assert.equal(
    first.backoffMs,
    10_000,
    'crash backoff must honour custom crashBackoffBaseMs (10s instead of default 30s)'
  );

  // Record a crash at t0 + 60s, then jump 6 minutes ahead (> 5m window)
  tracker.record('worker-c', t0 + 60_000);
  const afterWindow = tracker.record('worker-c', t0 + 400_000);
  assert.equal(
    afterWindow.crashesInWindow,
    1,
    'older crashes outside custom crashWindowMs (5m) must be pruned on next crash'
  );
});

test('Item 9: ClosingTimeController honours closingTimeoutMs from live config on next start', (t) => {
  t.mock.timers.enable();
  resetConfig({ timings: { closingTimeoutMs: 10_000 } }); // 10s instead of default 6m

  const events = [];
  const fakeWebContents = { send: (_channel, ev) => events.push(ev) };
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: { isGod: true }, dev1: {} } }),
    send: () => {}
  };

  const ct = new ClosingTimeController(
    hive,
    () => ['god', 'dev1'],
    () => fakeWebContents,
    () => {}
  );
  t.after(() => ct.cancel());

  ct.start();
  assert.equal(events.at(-1)?.phase, 'started');

  // Advance time by 10s (the custom timeout)
  t.mock.timers.tick(10_000);

  assert.equal(
    events.some((e) => e.phase === 'timeout'),
    true,
    'closing time must emit timeout event after 10s when closingTimeoutMs=10000'
  );
});

test('Item 10: CircuitBreaker honours repeatedToolLimit from live config on next beat', () => {
  resetConfig({ timings: { repeatedToolLimit: 3 } }); // 3 identical calls trip (under default 8, 3 calls do not trip)
  // Mirroring the production CircuitBreaker factory in index.ts:186
  const breaker = new CircuitBreaker(() => {
    const c = readConfig();
    return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
  });

  const toolInput = { file: 'foo.txt' };
  breaker.recordToolUse('w1', 'read', toolInput);
  breaker.recordToolUse('w1', 'read', toolInput);

  let decisions = breaker.tick([{ agentId: 'w1', sample: null, progressing: true }]);
  assert.equal(decisions[0]?.state?.level, 'healthy');

  // 3rd consecutive identical tool call: must trip steering when timings.repeatedToolLimit=3 is honoured
  breaker.recordToolUse('w1', 'read', toolInput);
  decisions = breaker.tick([{ agentId: 'w1', sample: null, progressing: true }]);
  const trip = decisions[0];
  assert.equal(
    trip?.state?.level,
    'steering',
    '3rd identical tool must trip steering when timings.repeatedToolLimit=3 is honoured'
  );
  assert.match(trip?.state?.reason ?? '', /looping/);
});

test('Item 11: CircuitBreaker honours breakerProgressToolWindowMs from live config on next beat', () => {
  resetConfig({ timings: { breakerProgressToolWindowMs: 60_000 } }); // 1 minute instead of 5m
  const breaker = new CircuitBreaker(() => {
    const c = readConfig();
    return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
  });

  const T0 = 1_000_000_000_000;
  breaker.recordUserPrompt('w2', T0); // prompt at T0

  // Baseline beat: the no-progress arm needs a previous sample to diff against.
  breaker.tick([{
    agentId: 'w2',
    sample: { agentId: 'w2', sessionId: 's1', ts: T0 + 30_000, input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 },
    progressing: false
  }], T0 + 30_000);

  // Beat 1 at T0 + 90s: under default 300s, prompt is active (healthy).
  // Under custom 60s, prompt has expired, so beat 1 counts as no-progress beat 1.
  breaker.tick([{
    agentId: 'w2',
    sample: { agentId: 'w2', sessionId: 's1', ts: T0 + 90_000, input: 1000, output: 500, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 },
    progressing: false
  }], T0 + 90_000);

  // Beat 2 at T0 + 120s: under custom 60s, this is second consecutive no-progress beat -> trips steering (needs a baseline beat first, see above).
  const decisions = breaker.tick([{
    agentId: 'w2',
    sample: { agentId: 'w2', sessionId: 's1', ts: T0 + 120_000, input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 },
    progressing: false
  }], T0 + 120_000);

  const decision = decisions[0];
  assert.equal(
    decision?.state?.level,
    'steering',
    'prompt from 90s ago must have expired under 60s breakerProgressToolWindowMs, tripping no-progress on 2nd beat'
  );
  assert.match(decision?.state?.reason ?? '', /no-progress/);
});

test('Item 12: runOpsStandup honours standupRefreshPercent from live config on next run', () => {
  resetConfig({ timings: { standupRefreshPercent: 75 } }); // 75% threshold
  const SYSTEM = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);
  const T0 = 1_000_000;

  const tasksData = { tasks: [] };
  let mark = {
    at: T0,
    tasks: standupTaskFingerprint(tasksData),
    usage: [{ engine: 'codex', window: '5h', percent: 80, resetsAtMs: T0 + 1000 }],
    exhausted: []
  };

  let sent = false;
  let sentNote = null;
  const ran = runOpsStandup({
    mark: () => mark,
    saveMark: (m) => { mark = m; },
    tasks: () => tasksData,
    logTail: () => [],
    godId: 'god',
    systemSenders: SYSTEM,
    send: (note) => { sent = true; sentNote = note; },
    appendLog: () => {},
    now: () => T0 + 5000,
    usage: () => ({ codex: [{ percent: 20, resetsAtMs: T0 + 20_000 }] }),
    exhausted: () => []
  });

  // Under default 90%, 80% was not above threshold, so refresh is ignored and standup skips.
  // Under configured 75%, 80% > 75%, so refresh is detected and standup sends!
  assert.equal(
    ran,
    true,
    'standup must send when 80% used window refreshed and standupRefreshPercent is 75%'
  );
  assert.equal(sent, true);
  assert.match(sentNote ?? '', /codex 5h refreshed from 80%/);
});

test('Item 13: runOpsStandup honours standupLogTail from live config on next run', () => {
  resetConfig({ timings: { standupLogTail: 5 } }); // inspect only last 5 lines instead of 3000
  const SYSTEM = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);
  const T0 = 1_000_000;

  const tasksData = { tasks: [] };
  const mark = { at: T0, tasks: standupTaskFingerprint(tasksData) };

  // Log with 10 entries: the change happened at entry index 0 (outside tail 5)
  const log = [];
  log.push({ ts: T0 + 10, kind: 'spawn', agentId: 'dev-old' }); // change at index 0
  for (let i = 1; i < 10; i++) {
    log.push({ ts: T0 + 100 + i, kind: 'other-untracked' });
  }

  let sent = false;
  let requested = 0;
  const ran = runOpsStandup({
    mark: () => mark,
    saveMark: () => {},
    tasks: () => tasksData,
    logTail: (n) => { requested = n; return log.slice(-n); },
    godId: 'god',
    systemSenders: SYSTEM,
    send: () => { sent = true; },
    appendLog: () => {},
    now: () => T0 + 5000
  });

  // The tail read honours the live value. A tail that is full and newer than the mark may
  // have truncated a change, so the overflow guard still runs the standup.
  assert.equal(requested, 5, 'logTail must be asked for the live standupLogTail (5), not 3000');
  assert.equal(ran, true, 'a full tail newer than the mark must still run (overflow guard)');
  assert.equal(sent, true);
});
