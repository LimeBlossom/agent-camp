'use strict';

process.env.TZ = 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const loadTs = require('../test-support/load-ts.cjs');

const providerLimits = loadTs('src/main/providerLimits.ts');
const limitHold = loadTs('src/shared/limitHold.ts');

const {
  isLimitText,
  parseResetTime,
  hitUntil,
  spentUntil,
  noteExhaustion,
  isExhausted,
  applyExhaustion,
  UNKNOWN_RESET_MS,
  RESUME_GRACE_MS,
  isCapacityRestored,
  clearExhaustion,
  createCapacityRestoredEvent
} = providerLimits;

const {
  deliveryHeldByLimit,
  limitResumeText,
  canResumeLimitWait
} = limitHold;

// --- Control tests (baseline sanity tests that verify existing behavior) ---

test('control: UNKNOWN_RESET_MS defaults to 1 hour (60 minutes)', () => {
  assert.equal(UNKNOWN_RESET_MS, 60 * 60_000);
});

test('control: hitUntil falls back to atMs + UNKNOWN_RESET_MS when resetAtMs is undefined', () => {
  const atMs = 1_000_000;
  assert.equal(hitUntil({ atMs, message: 'You have hit your limit' }), atMs + UNKNOWN_RESET_MS);
});

test('control: deliveryHeldByLimit holds queued messages unless released manually', () => {
  const waits = { 'elm': { provider: 'codex', resetAtMs: 2_000_000 } };
  assert.equal(deliveryHeldByLimit(waits, 'elm', false), true);
  assert.equal(deliveryHeldByLimit(waits, 'elm', undefined), true);
  assert.equal(deliveryHeldByLimit(waits, 'elm', true), false);
  assert.equal(deliveryHeldByLimit(waits, 'maple', false), false);
});

test('control: spentUntil returns undefined when all windows are under 100%', () => {
  const nowMs = 1_000_000;
  const windows = [{ percent: 45, resetsAtMs: nowMs + 10_000 }, { percent: 12, resetsAtMs: nowMs + 50_000 }];
  assert.equal(spentUntil(windows, nowMs), undefined);
});

// --- Intentional failing tests: Codex capacity restored contract ---

test('codex: capacity restored when previously exhausted window drops under 100% AND ordinaryUsageAllowed is true', () => {
  assert.equal(typeof isCapacityRestored, 'function', 'isCapacityRestored should be exported by providerLimits.ts');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 28, resetsAtMs: nowMs + 3_600_000, lengthMs: 300 * 60_000 },
    { percent: 4, resetsAtMs: nowMs + 86_400_000, lengthMs: 10080 * 60_000 }
  ];
  const restored = isCapacityRestored('codex', windows, {
    ordinaryUsageAllowed: true,
    wasExhausted: true
  });
  assert.equal(restored, true);
});

test('codex: capacity restored is rejected when ordinaryUsageAllowed is false despite window under 100%', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [{ percent: 20, resetsAtMs: nowMs + 3_600_000 }];
  const restored = isCapacityRestored('codex', windows, {
    ordinaryUsageAllowed: false,
    wasExhausted: true
  });
  assert.equal(restored, false, 'ordinaryUsageAllowed=false must block capacity restored');
});

test('codex: capacity restored is rejected when ordinaryUsageAllowed is undefined (unknown)', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [{ percent: 20, resetsAtMs: nowMs + 3_600_000 }];
  const restored = isCapacityRestored('codex', windows, {
    ordinaryUsageAllowed: undefined,
    wasExhausted: true
  });
  assert.equal(restored, false, 'an unknown value never counts as restored');
});

test('codex: capacity restored is rejected when any window is still at 100% even if ordinaryUsageAllowed is true', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 100, resetsAtMs: nowMs + 3_600_000 },
    { percent: 20, resetsAtMs: nowMs + 86_400_000 }
  ];
  const restored = isCapacityRestored('codex', windows, {
    ordinaryUsageAllowed: true,
    wasExhausted: true
  });
  assert.equal(restored, false, 'window at 100% is still spent');
});

test('codex: capacity restored is rejected when windows are missing or empty', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  assert.equal(isCapacityRestored('codex', [], { ordinaryUsageAllowed: true, wasExhausted: true }), false);
  assert.equal(isCapacityRestored('codex', undefined, { ordinaryUsageAllowed: true, wasExhausted: true }), false);
  assert.equal(isCapacityRestored('codex', [undefined], { ordinaryUsageAllowed: true, wasExhausted: true }), false);
});

// --- Intentional failing tests: Claude capacity restored contract ---

test('claude: capacity restored when previously exhausted window drops under 100%', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 45, resetsAtMs: nowMs + 1_800_000 },
    { percent: 60, resetsAtMs: nowMs + 86_400_000 }
  ];
  const restored = isCapacityRestored('claude', windows, { wasExhausted: true });
  assert.equal(restored, true);
});

test('claude: capacity restored is rejected when any window is still at 100%', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 100, resetsAtMs: nowMs + 1_800_000 },
    { percent: 40, resetsAtMs: nowMs + 86_400_000 }
  ];
  assert.equal(isCapacityRestored('claude', windows, { wasExhausted: true }), false);
});

test('claude: capacity restored is rejected when windows are unknown or empty', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  assert.equal(isCapacityRestored('claude', [], { wasExhausted: true }), false);
  assert.equal(isCapacityRestored('claude', undefined, { wasExhausted: true }), false);
});

// --- Intentional failing tests: Antigravity (agy, agy-claude, agy-argon) capacity restored ---

test('agy: capacity restored when pool shows remaining quota > 0% (percent under 100%)', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 12, resetsAtMs: nowMs + 1_200_000, lengthMs: 5 * 3_600_000 },
    { percent: 14, resetsAtMs: nowMs + 72 * 3_600_000, lengthMs: 7 * 86_400_000 }
  ];
  assert.equal(isCapacityRestored('agy-claude', windows, { wasExhausted: true }), true);
});

test('agy: capacity restored is rejected when pool is at 0% remaining (100% used)', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  const windows = [
    { percent: 100, resetsAtMs: nowMs + 4 * 3_600_000, lengthMs: 5 * 3_600_000 },
    { percent: 39, resetsAtMs: nowMs + 158 * 3_600_000, lengthMs: 7 * 86_400_000 }
  ];
  assert.equal(isCapacityRestored('agy-claude', windows, { wasExhausted: true }), false);
});

test('agy: capacity restored is rejected when pool data is missing or empty', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  assert.equal(isCapacityRestored('agy', [], { wasExhausted: true }), false);
  assert.equal(isCapacityRestored('agy-argon', undefined, { wasExhausted: true }), false);
});

// --- Intentional failing tests: Reset time edge cases & guardrails ---

test('guardrail: a passed reset time alone is NOT proof of restoration', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const nowMs = 1_700_000_000_000;
  // Window whose reset time is in the past, but window still indicates 100% spent
  const windowsStillSpent = [{ percent: 100, resetsAtMs: nowMs - 60_000 }];
  assert.equal(isCapacityRestored('codex', windowsStillSpent, { ordinaryUsageAllowed: true, wasExhausted: true }), false);

  // Window whose reset time is in the past, but provider confirmation is missing/false
  const windowsFree = [{ percent: 0, resetsAtMs: nowMs - 60_000 }];
  assert.equal(isCapacityRestored('codex', windowsFree, { ordinaryUsageAllowed: false, wasExhausted: true }), false);
  assert.equal(isCapacityRestored('codex', windowsFree, { ordinaryUsageAllowed: undefined, wasExhausted: true }), false);

  // Stated reset time passed, but agy pool stayed out past reset (e.g. board entry Cedar stall)
  const agyStillZero = [{ percent: 100, resetsAtMs: nowMs - 5000 }];
  assert.equal(isCapacityRestored('agy-argon', agyStillZero, { wasExhausted: true }), false);
});

test('early reset: restoration fires before UNKNOWN_RESET_MS (1h) expires when capacity returns', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const hitMs = 1_700_000_000_000;
  const nowMs = hitMs + 10 * 60_000; // Only 10 mins passed, 50 mins left on UNKNOWN_RESET_MS
  const windows = [{ percent: 30, resetsAtMs: hitMs + 3_600_000 }];
  const restored = isCapacityRestored('codex', windows, {
    ordinaryUsageAllowed: true,
    wasExhausted: true
  });
  assert.equal(restored, true, 'capacity returned early within unknown reset window');
});

test('early reset: restoration fires before guessed reset time expires when capacity returns', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const hitMs = 1_700_000_000_000;
  const guessedResetMs = hitMs + 5 * 3_600_000;
  const nowMs = hitMs + 1 * 3_600_000; // 4 hours left before guessed reset
  const windows = [{ percent: 50, resetsAtMs: guessedResetMs }];
  const restored = isCapacityRestored('claude', windows, { wasExhausted: true });
  assert.equal(restored, true, 'capacity returned early before guessed reset time');
});

test('guardrail: engine was not exhausted (wasExhausted=false) does not trigger capacity restored', () => {
  assert.equal(typeof isCapacityRestored, 'function');
  const windows = [{ percent: 20 }];
  const restored = isCapacityRestored('codex', windows, { ordinaryUsageAllowed: true, wasExhausted: false });
  assert.equal(restored, false, 'an engine that was not exhausted cannot restore capacity');
});

// --- Intentional failing tests: clearExhaustion contract ---

test('clearExhaustion: removes engine from ExhaustionMap and returns true if present', () => {
  assert.equal(typeof clearExhaustion, 'function', 'clearExhaustion should be exported by providerLimits.ts');
  const nowMs = 1_000_000;
  const map = {};
  noteExhaustion(map, 'codex', nowMs + 3_600_000, 'refusal', nowMs);
  assert.equal(isExhausted(map, 'codex', nowMs), true);

  const cleared = clearExhaustion(map, 'codex');
  assert.equal(cleared, true);
  assert.equal(isExhausted(map, 'codex', nowMs), false);
  assert.equal(map.codex, undefined);
});

test('clearExhaustion: returns false when engine was not in map', () => {
  assert.equal(typeof clearExhaustion, 'function');
  const map = {};
  assert.equal(clearExhaustion(map, 'claude'), false);
});

test('clearExhaustion: applyExhaustion reflects cleared engine immediately without forcing 100%', () => {
  assert.equal(typeof clearExhaustion, 'function');
  const nowMs = 1_000_000;
  const map = {};
  noteExhaustion(map, 'codex', nowMs + 3_600_000, 'refusal', nowMs);
  clearExhaustion(map, 'codex');

  const readings = applyExhaustion({ codex: { percent: 25 } }, map, nowMs);
  assert.deepEqual(readings.codex, { percent: 25 }, 'cleared exhaustion does not force 100%');
});

// --- Intentional failing tests: Limit hold resume bypass (limitHold.ts) ---

test('limitHold: canResumeLimitWait returns true immediately on capacityRestored=true while nowMs < resetAtMs', () => {
  assert.equal(typeof canResumeLimitWait, 'function', 'canResumeLimitWait should be exported by limitHold.ts');
  const nowMs = 1_000_000;
  const wait = { provider: 'codex', resetAtMs: nowMs + 3_600_000 };
  const canResume = canResumeLimitWait(wait, {
    capacityRestored: true,
    nowMs
  });
  assert.equal(canResume, true, 'capacityRestored=true bypasses the resetAtMs hold timer');
});

test('limitHold: canResumeLimitWait returns true immediately on capacityRestored=true while nowMs < resumeAtMs', () => {
  assert.equal(typeof canResumeLimitWait, 'function');
  const nowMs = 1_000_000;
  const wait = { provider: 'claude', resetAtMs: nowMs + 5000, resumeAtMs: nowMs + 65_000 };
  const canResume = canResumeLimitWait(wait, {
    capacityRestored: true,
    nowMs,
    resumeAtMs: wait.resumeAtMs
  });
  assert.equal(canResume, true, 'capacityRestored=true bypasses resumeAtMs grace timer');
});

test('limitHold: canResumeLimitWait returns false when capacityRestored is false even if nowMs >= resetAtMs', () => {
  assert.equal(typeof canResumeLimitWait, 'function');
  const nowMs = 1_000_000;
  const wait = { provider: 'codex', resetAtMs: nowMs - 5000 };
  const canResume = canResumeLimitWait(wait, {
    capacityRestored: false,
    nowMs
  });
  assert.equal(canResume, false, 'passed reset time alone without capacity restoration must not resume');
});

test('limitHold: canResumeLimitWait returns false when capacityRestored is undefined (unknown)', () => {
  assert.equal(typeof canResumeLimitWait, 'function');
  const nowMs = 1_000_000;
  const wait = { provider: 'codex', resetAtMs: nowMs - 5000 };
  const canResume = canResumeLimitWait(wait, {
    capacityRestored: undefined,
    nowMs
  });
  assert.equal(canResume, false, 'unknown capacity state must not resume');
});

// --- Intentional failing tests: Resume prompt text & capacity-restored event structure ---

test('limitResumeText: supports capacity-restored notification format', () => {
  const resetText = limitResumeText('codex');
  assert.match(resetText, /usage limit has reset/);

  const restoredText = limitResumeText('codex', 'capacity-restored');
  assert.match(restoredText, /capacity has been restored|capacity is restored|usage limit has reset/);
});

test('event structure: createCapacityRestoredEvent formats valid telemetry/log record', () => {
  assert.equal(typeof createCapacityRestoredEvent, 'function', 'createCapacityRestoredEvent should be exported by providerLimits.ts');
  const atMs = 1_700_000_000_000;
  const evt = createCapacityRestoredEvent('codex', atMs, {
    ordinaryUsageAllowed: true,
    wokenAgents: ['elm-mvnvoaig', 'cedar-mv1d931e']
  });
  assert.equal(evt.kind, 'capacity-restored');
  assert.equal(evt.engine, 'codex');
  assert.equal(evt.atMs, atMs);
  assert.equal(evt.ordinaryUsageAllowed, true);
  assert.deepEqual(evt.wokenAgents, ['elm-mvnvoaig', 'cedar-mv1d931e']);
});

// --- Boss QA gap tests: non-finite percent, freshness proof, and actual limitBeat wiring ---

test('guardrail: isCapacityRestored rejects non-finite percent (NaN, Infinity) while retaining legitimate optional windows', () => {
  assert.equal(isCapacityRestored('codex', [{ percent: NaN }], { ordinaryUsageAllowed: true, wasExhausted: true }), false);
  assert.equal(isCapacityRestored('claude', [{ percent: Infinity }], { wasExhausted: true }), false);
  assert.equal(isCapacityRestored('claude', [{ percent: -Infinity }], { wasExhausted: true }), false);
  assert.equal(isCapacityRestored('claude', [{ percent: 25 }, { percent: NaN }], { wasExhausted: true }), false);
  assert.equal(isCapacityRestored('claude', [undefined, { percent: 25 }], { wasExhausted: true }), true);
  assert.equal(isCapacityRestored('agy-argon', [undefined, { percent: 14 }], { wasExhausted: true }), true);
});

test('freshness: isCapacityRestored requires sample newer than exhaustion/refusal and rejects stale or unknown samples', () => {
  const exhaustedAtMs = 1_700_000_050_000;
  const windows = [{ percent: 22, resetsAtMs: exhaustedAtMs + 3_600_000 }];

  // Pre-refusal sample (older than exhaustion) must be rejected
  assert.equal(
    isCapacityRestored('codex', windows, { ordinaryUsageAllowed: true, wasExhausted: true, exhaustedAtMs, sampleAtMs: exhaustedAtMs - 10_000 }),
    false
  );
  // Sample at exact same ms as exhaustion must be rejected (must be strictly newer)
  assert.equal(
    isCapacityRestored('claude', windows, { wasExhausted: true, exhaustedAtMs, sampleAtMs: exhaustedAtMs }),
    false
  );
  // Unknown sample timestamp must be rejected when freshness against exhaustion is checked
  assert.equal(
    isCapacityRestored('claude', windows, { wasExhausted: true, exhaustedAtMs, sampleAtMs: undefined }),
    false
  );
  assert.equal(
    isCapacityRestored('claude', windows, { wasExhausted: true, exhaustedAtMs }),
    false
  );
  // Window carrying pre-refusal sampleAtMs must be rejected
  assert.equal(
    isCapacityRestored('codex', [{ percent: 22, sampleAtMs: exhaustedAtMs - 5_000 }], {
      ordinaryUsageAllowed: true,
      wasExhausted: true,
      exhaustedAtMs
    }),
    false
  );
  // Newer sample after exhaustion is accepted
  assert.equal(
    isCapacityRestored('codex', [{ percent: 22, sampleAtMs: exhaustedAtMs + 5_000 }], {
      ordinaryUsageAllowed: true,
      wasExhausted: true,
      exhaustedAtMs
    }),
    true
  );
});

function createLimitBeatHarness(overrides = {}) {
  const ts = require('typescript');
  const engineChoice = loadTs('src/main/engineChoice.ts');
  const agyQuotaParse = loadTs('src/main/agyQuotaParse.ts');
  const tierPick = loadTs('src/main/tierPick.ts');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const fnNames = ['engineWindows', 'exhaustedEngines', 'engineReadings', 'refusedEntry', 'candidateFor', 'pushLimitWaits', 'limitBeat'];
  const bodies = fnNames.map((name) => {
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `production function ${name} exists in src/main/index.ts`);
    return node.getText(ast);
  }).join('\n');

  let now = overrides.now ?? 1_700_000_060_000;
  let claudeSample = overrides.claudeSample ?? null;
  let codexSample = overrides.codexSample ?? null;
  let agySample = overrides.agySample ?? null;
  let closingActive = overrides.closingActive ?? false;
  const agentHits = new Map(Object.entries(overrides.agentHits ?? {}));
  const logged = [];
  const ipcSent = [];

  const limitHits = new Map();
  const previouslyExhausted = new Map();
  // Support both Set (old) and Map (new) in case unpatched code calls .add/.has
  if (typeof previouslyExhausted.add !== 'function') {
    previouslyExhausted.add = (k) => previouslyExhausted.set(k, now);
  }
  const restoredAt = new Map();
  const limitWaits = new Map();
  const pendingSwitches = new Map();
  const ptyToAgent = new Map([['pty-elm', 'elm']]);
  const liveSessions = new Map([['elm', { atMs: 1_700_000_000_000, provider: 'codex', cwd: '/tmp' }]]);
  const liveWorkers = new Set();

  class MockDate extends Date {
    static now() { return now; }
  }

  const bindings = {
    Date: MockDate,
    AGY_POOL: { agy: 'gem', 'agy-claude': 'claude', 'agy-argon': 'argon' },
    FIVE_HOURS_MS: engineChoice.FIVE_HOURS_MS,
    SEVEN_DAYS_MS: engineChoice.SEVEN_DAYS_MS,
    readEngine: engineChoice.readEngine,
    engineFor: engineChoice.engineFor,
    limitSwitchPick: engineChoice.limitSwitchPick,
    getEngineThresholds: engineChoice.getEngineThresholds,
    agyPoolWindows: agyQuotaParse.agyPoolWindows,
    hitUntil: providerLimits.hitUntil,
    spentUntil: providerLimits.spentUntil,
    noteExhaustion: providerLimits.noteExhaustion,
    isExhausted: providerLimits.isExhausted,
    applyExhaustion: providerLimits.applyExhaustion,
    limitDecision: providerLimits.limitDecision,
    isCapacityRestored: providerLimits.isCapacityRestored,
    createCapacityRestoredEvent: providerLimits.createCapacityRestoredEvent,
    RESUME_GRACE_MS: providerLimits.RESUME_GRACE_MS,
    UNKNOWN_RESET_MS: providerLimits.UNKNOWN_RESET_MS,
    canResumeLimitWait: limitHold.canResumeLimitWait,
    limitResumeText: limitHold.limitResumeText,
    readClaudeLimits: () => claudeSample,
    readCodexLimits: () => codexSample,
    readAgyQuota: () => agySample,
    limitHits,
    previouslyExhausted,
    restoredAt,
    limitWaits,
    pendingSwitches,
    ptyToAgent,
    liveSessions,
    liveWorkers,
    ensureRefusalsLoaded: () => {},
    refreshAgyRefusals: () => {},
    agyRefusals: {
      active: () => undefined,
      forAgent: () => undefined,
      pendingNotices: () => [],
      markNotified: () => {}
    },
    agentLimitHitAsync: async (id) => agentHits.get(id) ?? null,
    liveModelOf: () => 'gpt-5',
    hive: {
      registry: () => ({ godId: 'god', agents: { elm: { name: 'Elm', provider: 'codex' } } }),
      tasks: () => ({ tasks: [{ id: 'card-1', assignee: 'elm', status: 'doing' }] }),
      inbox: () => [],
      appendLog: (evt) => logged.push(evt),
      root: () => null,
      send: () => {}
    },
    tasksOf: (t) => t.tasks ?? [],
    dormantWakeReason: () => 'doing-card',
    closingTime: { isActive: () => closingActive },
    ptyForAgent: (id) => (id === 'elm' ? 'pty-elm' : null),
    ptyManager: { lastOutputAt: () => 0 },
    WORKER_WAKE_IDLE_MS: 1000,
    SWITCH_REPROPOSE_MS: 60_000,
    liveWebContents: () => ({ send: (channel, payload) => ipcSent.push({ channel, payload }) }),
    limitRosterAgents: () => ({
      live: [{
        id: 'elm',
        name: 'Elm',
        isGod: false,
        pinned: false,
        current: { provider: 'codex', model: 'gpt-5' },
        tier: 'medium',
        walk: [{ provider: 'codex', model: 'gpt-5' }]
      }],
      dormant: []
    }),
    agentWalk: (a) => ({ tiers: [a.tier], walk: a.walk.map((entry) => ({ entry, tier: a.tier })), excluded: [], notes: [] }),
    pickByTier: tierPick.pickByTier,
    entryLabel: (e) => `${e.provider}/${e.model ?? 'default'}`,
    writeHandoff: async () => {},
    limitLockNotices: new providerLimits.LimitLockNotices(() => false, () => {}),
    codexResetCreditNotices: { check: () => {} },
    reservationExpiryNotices: { check: () => {} },
    parseReservations: () => [],
    offTranscriptUsage: () => undefined,
    readClaudeResetGrants: () => undefined,
    claudeResetGrantNotices: { check: () => {} },
    readConfig: () => ({}),
    noticeKey: () => 'k',
    existsSync: () => false,
    join: (...parts) => parts.join('/'),
    noProgressWatch: { check: () => false },
    telemetry: { snapshot: () => ({ usage: [] }) },
    agyUsageSample: () => undefined,
    lastWorkAt: () => now,
    modelActivityAt: () => now,
    limitHeld: (id) => limitWaits.has(id) || pendingSwitches.has(id),
    console: { log: () => {}, error: () => {}, warn: () => {} }
  };

  const compiled = ts.transpileModule(bodies, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const fns = new Function(...Object.keys(bindings), `${compiled}\nreturn { ${fnNames.join(',')} };`)(...Object.values(bindings));

  return {
    ...fns,
    limitHits,
    previouslyExhausted,
    restoredAt,
    limitWaits,
    logged,
    ipcSent,
    setNow: (ms) => { now = ms; },
    setCodexSample: (s) => { codexSample = s; },
    setClaudeSample: (s) => { claudeSample = s; },
    setAgySample: (s) => { agySample = s; },
    setAgentHit: (id, h) => { if (h) agentHits.set(id, h); else agentHits.delete(id); },
    setClosingActive: (active) => { closingActive = active; }
  };
}

test('limitBeat wiring: pre-refusal cached sample under 100% is rejected and cannot delete limitHits or wake held agent', async () => {
  const refusalAtMs = 1_700_000_050_000;
  const resetAtMs = refusalAtMs + 3_600_000;
  const h = createLimitBeatHarness({
    now: refusalAtMs + 10_000,
    // Cached sample was taken 40s BEFORE the refusal
    codexSample: {
      updatedAt: refusalAtMs - 40_000,
      fiveHour: { percent: 25, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
      weekly: { percent: 10, windowMinutes: 10080, resetsAt: Math.floor((refusalAtMs + 86_400_000) / 1000) },
      ordinaryUsageAllowed: true
    },
    agentHits: {
      elm: { atMs: refusalAtMs, resetAtMs, message: "You've hit your usage limit." }
    }
  });

  await h.limitBeat();
  assert.equal(h.limitHits.has('codex'), true, 'pre-refusal cached sample must not delete limitHits on first beat');
  assert.equal(h.limitWaits.has('elm'), true, 'agent must be placed in limitWaits');
  assert.equal(h.logged.some((e) => e.kind === 'capacity-restored'), false, 'must not emit capacity-restored from stale sample');

  // Second beat with same stale pre-refusal sample must also keep limitHits and limitWaits intact
  h.setNow(refusalAtMs + 20_000);
  await h.limitBeat();
  assert.equal(h.limitHits.has('codex'), true, 'pre-refusal cached sample must not delete limitHits on second beat');
  assert.equal(h.limitWaits.has('elm'), true, 'agent must remain in limitWaits');
  assert.equal(h.logged.some((e) => e.kind === 'capacity-restored'), false);
  assert.equal(h.ipcSent.some((m) => m.channel === 'hive:limitResume'), false);
});

test('limitBeat wiring: newer post-refusal sample is accepted once and not re-emitted on subsequent beats', async () => {
  const refusalAtMs = 1_700_000_050_000;
  const resetAtMs = refusalAtMs + 3_600_000;
  const h = createLimitBeatHarness({
    now: refusalAtMs + 10_000,
    codexSample: {
      updatedAt: refusalAtMs - 40_000,
      fiveHour: { percent: 25, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
      ordinaryUsageAllowed: true
    },
    agentHits: {
      elm: { atMs: refusalAtMs, resetAtMs, message: "You've hit your usage limit." }
    }
  });

  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), true);

  // Fresh provider sample arrives 30s AFTER the refusal, before resetAtMs
  h.setNow(refusalAtMs + 35_000);
  h.setCodexSample({
    updatedAt: refusalAtMs + 30_000,
    fiveHour: { percent: 18, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
    weekly: { percent: 10, windowMinutes: 10080, resetsAt: Math.floor((refusalAtMs + 86_400_000) / 1000) },
    ordinaryUsageAllowed: true
  });

  await h.limitBeat();
  assert.equal(h.limitHits.has('codex'), false, 'fresh sample clears limitHits');
  assert.equal(h.limitWaits.has('elm'), false, 'fresh sample wakes held agent immediately');
  const restoredEvents = h.logged.filter((e) => e.kind === 'capacity-restored');
  assert.equal(restoredEvents.length, 1);
  assert.deepEqual(restoredEvents[0].wokenAgents, ['elm']);
  const resumes = h.ipcSent.filter((m) => m.channel === 'hive:limitResume');
  assert.equal(resumes.length, 1);
  assert.match(resumes[0].payload.text, /capacity has been restored/);

  // Next beat while transcript still has the old refusal and sample is unchanged: must NOT re-trigger
  h.setNow(refusalAtMs + 50_000);
  await h.limitBeat();
  assert.equal(h.limitHits.has('codex'), false, 'superseded refusal must not re-add limitHits');
  assert.equal(h.limitWaits.has('elm'), false);
  assert.equal(h.logged.filter((e) => e.kind === 'capacity-restored').length, 1, 'capacity-restored emitted only once');
  assert.equal(h.ipcSent.filter((m) => m.channel === 'hive:limitResume').length, 1, 'hive:limitResume sent only once');
});

test('limitBeat wiring: hold and grace timers passing alone without fresh restored sample are rejected', async () => {
  const refusalAtMs = 1_700_000_050_000;
  const resetAtMs = refusalAtMs + 60_000;
  const h = createLimitBeatHarness({
    now: refusalAtMs + 5_000,
    codexSample: {
      updatedAt: refusalAtMs - 10_000,
      fiveHour: { percent: 30, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
      ordinaryUsageAllowed: true
    },
    agentHits: {
      elm: { atMs: refusalAtMs, resetAtMs, message: "You've hit your usage limit." }
    }
  });

  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), true);

  // Advance clock past both resetAtMs AND resumeAtMs (resetAtMs + RESUME_GRACE_MS), with no fresh confirmed sample
  h.setNow(resetAtMs + RESUME_GRACE_MS + 30_000);
  // Even if withResets synthetically zeroes the bucket (reset: true) on the old sample timestamp, it is not a fresh sample
  h.setCodexSample({
    updatedAt: refusalAtMs,
    fiveHour: { percent: 0, windowMinutes: 300, reset: true },
    ordinaryUsageAllowed: true
  });
  await h.limitBeat();
  assert.equal(h.limitHits.has('codex'), true, 'timers expiring alone must not delete limitHits');
  assert.equal(h.limitWaits.has('elm'), true, 'timers expiring alone must not release limitWaits without capacity restoration');
  assert.equal(h.logged.some((e) => e.kind === 'capacity-restored'), false);
  assert.equal(h.logged.some((e) => e.kind === 'limit-resume'), false);
  assert.equal(h.ipcSent.some((m) => m.channel === 'hive:limitResume'), false);
});

test('limitBeat wiring: closing-time retains limit hold when capacity restores until closing time ends', async () => {
  const refusalAtMs = 1_700_000_050_000;
  const resetAtMs = refusalAtMs + 3_600_000;
  const h = createLimitBeatHarness({
    now: refusalAtMs + 5_000,
    closingActive: true,
    codexSample: {
      updatedAt: refusalAtMs - 10_000,
      fiveHour: { percent: 40, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
      ordinaryUsageAllowed: true
    },
    agentHits: {
      elm: { atMs: refusalAtMs, resetAtMs, message: "You've hit your usage limit." }
    }
  });

  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), true);

  // Fresh sample arrives while closingTime is active
  h.setNow(refusalAtMs + 20_000);
  h.setCodexSample({
    updatedAt: refusalAtMs + 15_000,
    fiveHour: { percent: 10, windowMinutes: 300, resetsAt: Math.floor(resetAtMs / 1000) },
    ordinaryUsageAllowed: true
  });
  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), true, 'agent must stay held in limitWaits during closing time');
  assert.equal(h.ipcSent.some((m) => m.channel === 'hive:limitResume'), false, 'must not resume during closing time');
  assert.equal(h.logged.filter((e) => e.kind === 'capacity-restored').length, 1);

  // Subsequent beat during closing time must not re-emit capacity-restored
  h.setNow(refusalAtMs + 30_000);
  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), true);
  assert.equal(h.logged.filter((e) => e.kind === 'capacity-restored').length, 1, 'no duplicate event during closing time');

  // Once closing time is cancelled/ended, next beat resumes the held agent immediately (before resetAtMs)
  h.setClosingActive(false);
  h.setNow(refusalAtMs + 40_000);
  await h.limitBeat();
  assert.equal(h.limitWaits.has('elm'), false, 'agent released once closing time ends');
  const resumes = h.ipcSent.filter((m) => m.channel === 'hive:limitResume');
  assert.equal(resumes.length, 1);
  assert.match(resumes[0].payload.text, /capacity has been restored/);
});
