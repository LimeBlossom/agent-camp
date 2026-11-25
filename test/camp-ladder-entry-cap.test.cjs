'use strict';

/**
 * Camp: per-entry usage cap on ladders and spawn requests (camp-ladder-entry-cap).
 *
 * the human ruling 10-31 (ruling-codex-first): Codex is our best visual judge and image
 * generator, so for CODE it should be used first but only until its weekly meter
 * reaches 50%; above that it must stay free for visual work.
 *
 * Feature contracts:
 * 1. Balancer per-entry cap: Candidate with maxPercent is skipped when percent >= maxPercent,
 *    picked when percent < maxPercent.
 * 2. Uncapped entries unchanged: continue using the global fullPercent (ENGINE_FULL_PERCENT = 85%).
 * 3. Fallback when all entries are over cap: falls back to soonest-reset (balanceEngines)
 *    or least-used (chooseEngine) exactly as today.
 * 4. Spawn engines item "codex@50" (or { engine, maxPercent }): parsed by parseEngineList and
 *    skipped by chooseEngine when usage reaches or exceeds the per-entry cap.
 * 5. Validation: parseModelEntry and validateModelTiers accept maxPercent (1-100) and reject
 *    invalid values; cleanModelList preserves maxPercent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  chooseEngine,
  balanceEngines,
  parseEngineList,
  ENGINE_FULL_PERCENT
} = loadTs('src/main/engineChoice.ts');

const {
  parseModelEntry,
  cleanModelList
} = loadTs('src/shared/modelBalance.ts');

const all = () => true;
const NOW = 1_800_000_000_000;
const cand = (engine, label = engine, maxPercent = undefined) => ({
  engine,
  label,
  ...(maxPercent !== undefined ? { maxPercent } : {})
});

// ---------------------------------------------------------------------------
// 1. Balancer Candidate per-entry cap
// ---------------------------------------------------------------------------

test('balance: candidate with maxPercent is skipped at or above cap but picked below', () => {
  // At 50% usage (>= 50% cap), codex must be skipped; claude is picked
  const atCap = balanceEngines(
    [cand('codex', 'codex', 50), cand('claude', 'claude')],
    { codex: { percent: 50 }, claude: { percent: 40 } },
    NOW
  );
  assert.equal(atCap.index, 1, 'codex at 50% must be skipped for claude');
  assert.match(atCap.reason, /skipped codex 50% used/);

  // At 60% usage (> 50% cap), codex is also skipped
  const overCap = balanceEngines(
    [cand('codex', 'codex', 50), cand('claude', 'claude')],
    { codex: { percent: 60 }, claude: { percent: 40 } },
    NOW
  );
  assert.equal(overCap.index, 1, 'codex at 60% must be skipped for claude');

  // At 49% usage (< 50% cap), codex has room and wins as preferred first entry
  const belowCap = balanceEngines(
    [cand('codex', 'codex', 50), cand('claude', 'claude')],
    { codex: { percent: 49 }, claude: { percent: 40 } },
    NOW
  );
  assert.equal(belowCap.index, 0, 'codex at 49% (< 50% cap) must be picked');

  // Different cap value (e.g. 70%)
  const capped70 = balanceEngines(
    [cand('codex', 'codex', 70), cand('claude', 'claude')],
    { codex: { percent: 70 }, claude: { percent: 30 } },
    NOW
  );
  assert.equal(capped70.index, 1, 'codex at 70% with maxPercent 70 must be skipped');

  const under70 = balanceEngines(
    [cand('codex', 'codex', 70), cand('claude', 'claude')],
    { codex: { percent: 69 }, claude: { percent: 30 } },
    NOW
  );
  assert.equal(under70.index, 0, 'codex at 69% with maxPercent 70 must be picked');
});

// ---------------------------------------------------------------------------
// 2. Uncapped entries unchanged & fallback when all over cap
// ---------------------------------------------------------------------------

test('balance: uncapped entries keep global ENGINE_FULL_PERCENT and pick over capped entry', () => {
  // Uncapped claude is NOT skipped at 84% (< 85% ENGINE_FULL_PERCENT)
  const uncappedBelow = balanceEngines(
    [cand('claude', 'claude')],
    { claude: { percent: 84 } },
    NOW
  );
  assert.equal(uncappedBelow.index, 0, 'uncapped claude at 84% must have room');

  // Uncapped claude IS skipped at 85% (= ENGINE_FULL_PERCENT)
  const uncappedAtFull = balanceEngines(
    [cand('claude', 'claude'), cand('codex', 'codex')],
    { claude: { percent: ENGINE_FULL_PERCENT }, codex: { percent: 10 } },
    NOW
  );
  assert.equal(uncappedAtFull.index, 1, 'uncapped claude at 85% must be skipped');

  // Mixed: codex capped at 50% is at 55% (over cap); uncapped claude is at 75% (< 85%)
  // Uncapped claude must be chosen even though its percent (75%) > codex percent (55%)
  const mixed = balanceEngines(
    [cand('codex', 'codex', 50), cand('claude', 'claude')],
    { codex: { percent: 55 }, claude: { percent: 75 } },
    NOW
  );
  assert.equal(mixed.index, 1, 'uncapped claude at 75% wins over codex exceeding its 50% cap');
});

test('balance: when every entry is over its cap, falls back to soonest reset', () => {
  // codex capped at 50% is at 60% (over cap), room in 30m
  // claude uncapped (85%) is at 90% (over cap), room in 2h
  const r = balanceEngines(
    [cand('codex', 'codex', 50), cand('claude', 'claude')],
    {
      codex: { percent: 60, roomAtMs: NOW + 30 * 60_000 },
      claude: { percent: 90, roomAtMs: NOW + 120 * 60_000 }
    },
    NOW
  );
  assert.equal(r.index, 0, 'when all over cap, soonest reset wins');
  assert.match(r.reason, /resets soonest \(room in 30m\)/);
});

// ---------------------------------------------------------------------------
// 3. Spawn engines "codex@50" parse and skip in chooseEngine
// ---------------------------------------------------------------------------

test('parseEngineList: parses codex@50 string and { engine, maxPercent } objects', () => {
  // Shorthand string "codex@50"
  const parsedStrings = parseEngineList(['codex@50', 'claude']);
  assert.equal(parsedStrings.length, 2);
  const codexEntry = parsedStrings[0];
  const codexId = typeof codexEntry === 'object' ? codexEntry.engine || codexEntry.id : codexEntry;
  assert.equal(codexId, 'codex');
  assert.equal(typeof codexEntry === 'object' ? codexEntry.maxPercent : undefined, 50);

  // Object entry { engine: 'codex', maxPercent: 50 }
  const parsedObjects = parseEngineList([{ engine: 'codex', maxPercent: 50 }, 'claude']);
  assert.equal(parsedObjects.length, 2);
  const objEntry = parsedObjects[0];
  assert.equal(typeof objEntry === 'object' ? (objEntry.engine || objEntry.id) : objEntry, 'codex');
  assert.equal(typeof objEntry === 'object' ? objEntry.maxPercent : undefined, 50);

  // Invalid cap syntax or out of range in spawn list handled safely
  const invalidCaps = parseEngineList(['codex@0', 'codex@105', 'codex@bad']);
  for (const entry of invalidCaps) {
    if (typeof entry === 'object' && entry.maxPercent !== undefined) {
      assert.ok(entry.maxPercent >= 1 && entry.maxPercent <= 100, 'maxPercent must be within 1-100');
    }
  }
});

test('chooseEngine: respects per-entry cap with codex@50 string and object syntax', () => {
  // codex at 50% usage with codex@50 cap is skipped; claude at 30% picked
  const pickCapped = chooseEngine(['codex@50', 'claude'], { codex: 50, claude: 30 }, all);
  assert.ok(pickCapped, 'chooseEngine must return a choice');
  assert.equal(pickCapped.engine.id, 'claude', 'codex at 50% cap must be skipped');
  assert.match(pickCapped.reason, /skipped codex 50% used/);

  // codex at 49% usage with codex@50 cap is picked
  const pickUnder = chooseEngine(['codex@50', 'claude'], { codex: 49, claude: 30 }, all);
  assert.ok(pickUnder);
  assert.equal(pickUnder.engine.id, 'codex', 'codex at 49% (< 50% cap) must be chosen');

  // Object syntax { engine: 'codex', maxPercent: 50 }
  const pickObjCapped = chooseEngine(
    [{ engine: 'codex', maxPercent: 50 }, 'claude'],
    { codex: 55, claude: 30 },
    all
  );
  assert.ok(pickObjCapped);
  assert.equal(pickObjCapped.engine.id, 'claude');

  // When every engine is over cap, fallback to least-used engine
  const allOver = chooseEngine(['codex@50', 'claude'], { codex: 60, claude: 90 }, all);
  assert.ok(allOver);
  assert.equal(allOver.engine.id, 'codex', 'least-used engine wins when all over cap (60% vs 90%)');
  assert.match(allOver.reason, /least used/);
});

// ---------------------------------------------------------------------------
// 4. Agent-config validation accepts/rejects maxPercent (1-100)
// ---------------------------------------------------------------------------

test('parseModelEntry: accepts maxPercent integers 1-100 on object entries', () => {
  // Valid maxPercent values
  const valid50 = parseModelEntry({ provider: 'codex', model: 'gpt-5.4', maxPercent: 50 });
  assert.deepEqual(valid50, {
    ok: true,
    entry: { provider: 'codex', model: 'gpt-5.4', maxPercent: 50 }
  });

  const valid1 = parseModelEntry({ provider: 'codex', maxPercent: 1 });
  assert.deepEqual(valid1, {
    ok: true,
    entry: { provider: 'codex', maxPercent: 1 }
  });

  const valid100 = parseModelEntry({ provider: 'antigravity', model: 'gemini-3-flash', maxPercent: 100 });
  assert.deepEqual(valid100, {
    ok: true,
    entry: { provider: 'antigravity', model: 'gemini-3-flash', maxPercent: 100 }
  });
});

test('parseModelEntry: rejects invalid maxPercent values (0, >100, non-integer, non-number)', () => {
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: 0 }).ok, false, '0 must be rejected');
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: 101 }).ok, false, '101 must be rejected');
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: -5 }).ok, false, 'negative must be rejected');
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: '50' }).ok, false, 'string must be rejected');
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: NaN }).ok, false, 'NaN must be rejected');
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: 50.5 }).ok, false, 'floating point must be rejected');
  // Unknown fields must still be rejected
  assert.equal(parseModelEntry({ provider: 'codex', maxPercent: 50, extraneous: 1 }).ok, false);
});

test('cleanModelList: preserves maxPercent on clean model entries', () => {
  const cleaned = cleanModelList([
    { provider: 'codex', model: 'gpt-5.4', maxPercent: 50 },
    { provider: 'claude', model: 'claude-sonnet-4-6' }
  ]);
  assert.deepEqual(cleaned, [
    { provider: 'codex', model: 'gpt-5.4', maxPercent: 50 },
    { provider: 'claude', model: 'claude-sonnet-4-6' }
  ]);
});

test('a cap lives on a camp tier entry and survives tier validation', () => {
  const { validateModelTiers } = loadTs('src/shared/modelTiers.ts');
  const v = validateModelTiers({
    strong: [{ provider: 'codex', model: 'gpt-5.4', maxPercent: 50 }, { provider: 'claude', model: 'claude-opus-4-7' }],
    medium: [], light: []
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.tiers.strong, [
    { provider: 'codex', model: 'gpt-5.4', maxPercent: 50 },
    { provider: 'claude', model: 'claude-opus-4-7' }
  ]);
  const bad = validateModelTiers({ strong: [{ provider: 'codex', model: 'gpt-5.4', maxPercent: 0 }], medium: [], light: [] });
  assert.equal(bad.ok, false);
});
