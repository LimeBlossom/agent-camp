'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  TIERS, isTier, tierWalk, parseModelTiers, validateModelTiers, resolveAgentWalk, tierOfEntry, defaultTierFor
} = loadTs('src/shared/modelTiers.ts');
const { pickAgentEntry, pickByTier } = loadTs('src/main/tierPick.ts');
const { limitSwitchPick } = loadTs('src/main/engineChoice.ts');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const OPUS = { provider: 'claude', model: 'claude-opus-5-5' };
const FABLE = { provider: 'claude', model: 'claude-fable-5-2' };
const ARGON = { provider: 'antigravity', model: 'Gemini 4 Argon (Medium)' };
const ASTRA = { provider: 'codex', model: 'gpt-6.2-astra' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' };
const AGY_SONNET = { provider: 'antigravity', model: 'claude-sonnet-5-5-medium' };
const FLASH = { provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' };
const LUNA = { provider: 'codex', model: 'gpt-6-luna' };

const TIER_LISTS = {
  strong: [OPUS, ARGON, ASTRA],
  medium: [SONNET, AGY_SONNET],
  light: [FLASH, LUNA]
};
const CODEX_FOR_VISUAL = [{ provider: 'codex', kinds: ['splat', 'visual-judgment', 'image-making'], until: '2026-11-26T00:00:00Z' }];

// One meter per entry, keyed by model, so each entry reads independently.
const cand = (e) => ({ engine: e.model, label: `${e.provider}/${e.model}` });
const models = (walk) => walk.walk.map((w) => w.entry.model);
const pick = (walk, readings = {}, extra = {}) =>
  pickAgentEntry({ walk, candidateOf: extra.candidateOf ?? cand, readings, nowMs: NOW, ...extra });

test('four tiers, strongest first', () => {
  assert.deepEqual([...TIERS], ['top', 'strong', 'medium', 'light']);
  assert.equal(isTier('medium'), true);
  assert.equal(isTier('ultra'), false);
});

test('card difficulty sets the start tier; the walk goes down, then up only to the agent tier', () => {
  assert.deepEqual(tierWalk('medium', undefined), ['medium', 'light']);
  assert.deepEqual(tierWalk('medium', 'normal'), ['medium', 'light']);
  assert.deepEqual(tierWalk('light', 'normal'), ['light']);
  assert.deepEqual(tierWalk('strong', 'normal'), ['strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('light', 'hard'), ['strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('medium', 'hard'), ['strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('strong', 'easy'), ['light', 'medium', 'strong']);
  assert.deepEqual(tierWalk('medium', 'easy'), ['light', 'medium']);
  assert.deepEqual(tierWalk('light', 'easy'), ['light']);
});

test('the walk lists each tier list in order, tagged with its tier', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'medium', nowMs: NOW });
  assert.deepEqual(models(walk), ['claude-sonnet-5-5', 'claude-sonnet-5-5-medium', 'Gemini 3.8 Flash (High)', 'gpt-6-luna']);
  assert.deepEqual(walk.walk.map((w) => w.tier), ['medium', 'medium', 'light', 'light']);
  const hard = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'light', difficulty: 'hard', nowMs: NOW });
  assert.deepEqual(models(hard).slice(0, 3), ['claude-opus-5-5', 'Gemini 4 Argon (Medium)', 'gpt-6.2-astra']);
});

test('hard card lands on the strong tier even for a light agent', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'light', difficulty: 'hard', nowMs: NOW });
  const p = pick(walk, { 'Gemini 3.8 Flash (High)': { percent: 1 } });
  assert.equal(p.entry.model, 'claude-opus-5-5');
  assert.equal(p.tier, 'strong');
});

test('easy card lands on the light tier even for a strong agent', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', difficulty: 'easy', nowMs: NOW });
  const p = pick(walk);
  assert.equal(p.entry.model, 'Gemini 3.8 Flash (High)');
  assert.equal(p.tier, 'light');
});

test('headroom falls through inside a tier before leaving it', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW });
  const p = pick(walk, { 'claude-opus-5-5': { percent: 91 }, 'claude-sonnet-5-5': { percent: 1 } });
  assert.equal(p.entry.model, 'Gemini 4 Argon (Medium)');
  assert.equal(p.tier, 'strong');
  assert.match(p.reason, /tier strong/);
  assert.match(p.reason, /skipped claude\/claude-opus-5-5 91%/);
});

test('a full tier falls to the next tier down and the reason names the tier it left', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW });
  const p = pick(walk, {
    'claude-opus-5-5': { percent: 91 }, 'Gemini 4 Argon (Medium)': { percent: 99 }, 'gpt-6.2-astra': { percent: 88 },
    'claude-sonnet-5-5': { percent: 20 }
  });
  assert.equal(p.entry.model, 'claude-sonnet-5-5');
  assert.equal(p.tier, 'medium');
  assert.match(p.reason, /tier strong: no entry has room/);
  assert.match(p.reason, /tier medium: claude\/claude-sonnet-5-5 20%/);
});

test('a lower tier with more room never beats an upper tier that still has room', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW });
  const p = pick(walk, { 'claude-opus-5-5': { percent: 80, pace: 140 }, 'claude-sonnet-5-5': { percent: 0, pace: 0 } });
  assert.equal(p.entry.model, 'claude-opus-5-5');
});

test('a normal card never climbs above the agent tier while a lower tier has room', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'medium', nowMs: NOW });
  assert.equal(walk.walk.some((w) => w.tier === 'strong'), false);
  const p = pick(walk, { 'claude-sonnet-5-5': { percent: 95 }, 'claude-sonnet-5-5-medium': { percent: 95 } });
  assert.equal(p.tier, 'light');
});

test('a per-entry maxPercent cap still skips that entry inside its tier', () => {
  const capped = { ...TIER_LISTS, strong: [{ ...OPUS, maxPercent: 50 }, ARGON] };
  const walk = resolveAgentWalk({ tiers: capped, agentTier: 'strong', nowMs: NOW });
  const p = pick(walk, { 'claude-opus-5-5': { percent: 60 } });
  assert.equal(p.entry.model, 'Gemini 4 Argon (Medium)');
});

test('every walked entry full: the one whose room comes back first, flagged full', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'medium', nowMs: NOW });
  const p = pick(walk, {
    'claude-sonnet-5-5': { percent: 95, roomAtMs: NOW + 5 * 3_600_000 },
    'claude-sonnet-5-5-medium': { percent: 95, roomAtMs: NOW + 4 * 3_600_000 },
    'Gemini 3.8 Flash (High)': { percent: 95, roomAtMs: NOW + 3_600_000 },
    'gpt-6-luna': { percent: 95, roomAtMs: NOW + 2 * 3_600_000 }
  });
  assert.equal(p.entry.model, 'Gemini 3.8 Flash (High)');
  assert.equal(p.quotaBlocked, false);
  assert.match(p.reason, /every tier is full/);
});

test('every walked entry capped, spent or refused: the agent waits, naming tiers, meters and the next room', () => {
  const capped = { strong: [OPUS], medium: [{ ...SONNET, maxPercent: 50 }], light: [{ ...FLASH, maxPercent: 40 }, LUNA] };
  const walk = resolveAgentWalk({ tiers: capped, agentTier: 'medium', nowMs: NOW });
  const p = pick(walk, {
    'claude-sonnet-5-5': { percent: 60 },
    'Gemini 3.8 Flash (High)': { percent: 45 },
    'gpt-6-luna': { percent: 100, roomAtMs: NOW + 2 * 3_600_000 }
  });
  assert.equal(p.entry, null);
  assert.equal(p.quotaBlocked, true);
  assert.match(p.reason, /waiting/);
  assert.match(p.reason, /tier medium: .*claude\/claude-sonnet-5-5 60%/);
  assert.match(p.reason, /tier light: .*gpt-6-luna 100%/);
  assert.match(p.reason, /next room in 2h \(codex\/gpt-6-luna\)/);
  const refused = pick(walk, { 'claude-sonnet-5-5': { percent: 60 }, 'Gemini 3.8 Flash (High)': { percent: 45 } }, { candidateOf: (e) => ({ ...cand(e), blocked: e === LUNA }) });
  assert.equal(refused.quotaBlocked, true);
  assert.match(refused.reason, /next room: reset time unknown/);
});

test('a refused entry is skipped like a full one', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW });
  const p = pick(walk, {}, { candidateOf: (e) => ({ ...cand(e), blocked: e === OPUS }) });
  assert.equal(p.entry.model, 'Gemini 4 Argon (Medium)');
});

test('placement exclusions drop entries and are listed', () => {
  const walk = resolveAgentWalk({
    tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW,
    exclusion: (e) => (e.provider === 'antigravity' ? 'Antigravity runs without a sandbox' : null)
  });
  assert.equal(walk.walk.some((w) => w.entry.provider === 'antigravity'), false);
  assert.deepEqual(walk.excluded.map((x) => x.entry.model), ['Gemini 4 Argon (Medium)', 'claude-sonnet-5-5-medium', 'Gemini 3.8 Flash (High)']);
  assert.match(walk.excluded[0].reason, /without a sandbox/);
});

test('a walk nothing in can run the agent widens to the nearest tiers above and says so', () => {
  const walk = resolveAgentWalk({
    tiers: TIER_LISTS, agentTier: 'light', nowMs: NOW,
    exclusion: (e) => (e.provider === 'claude' ? null : 'needs Claude')
  });
  assert.deepEqual(models(walk), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.match(walk.widened, /light/);
  assert.match(pick(walk).reason, /widened/);
});

test('a reservation drops its engine from every tier for other kinds and for no kind', () => {
  for (const kind of ['code', undefined]) {
    const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW, reservations: CODEX_FOR_VISUAL, kind });
    assert.equal(walk.walk.some((w) => w.entry.provider === 'codex'), false, `kind ${kind}`);
    assert.ok(walk.notes.some((n) => /codex reserved until 2026-11-26 for splat, visual-judgment, image-making: excluded/.test(n)));
  }
});

test('reserved-for-kind entries go first, from whatever tier holds them', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'medium', nowMs: NOW, reservations: CODEX_FOR_VISUAL, kind: 'visual-judgment' });
  assert.deepEqual(models(walk).slice(0, 2), ['gpt-6.2-astra', 'gpt-6-luna']);
  assert.equal(walk.walk[0].preferred, true);
  const p = pick(walk, { 'claude-sonnet-5-5': { percent: 0 } });
  assert.equal(p.entry.model, 'gpt-6.2-astra');
  assert.match(p.reason, /reserved/);
});

test('an expired reservation no longer drops anything', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: Date.parse('2026-11-27T00:00:00Z'), reservations: CODEX_FOR_VISUAL, kind: 'code' });
  assert.ok(models(walk).includes('gpt-6.2-astra'));
});

test('everything reserved away blocks the pick and names the reservation', () => {
  const codexOnly = { strong: [ASTRA], medium: [], light: [LUNA] };
  const walk = resolveAgentWalk({ tiers: codexOnly, agentTier: 'strong', nowMs: NOW, reservations: CODEX_FOR_VISUAL, kind: 'code' });
  assert.match(walk.blocked, /every engine is reserved/);
  const p = pick(walk);
  assert.equal(p.entry, null);
  assert.equal(p.quotaBlocked, true);
  assert.match(p.reason, /every engine is reserved/);
});

test('a pin wins over tier, difficulty and reservation', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'light', difficulty: 'easy', nowMs: NOW, reservations: CODEX_FOR_VISUAL, kind: 'code' });
  const p = pick(walk, {}, { pin: ASTRA });
  assert.deepEqual(p.entry, ASTRA);
  assert.match(p.reason, /pinned to codex\/gpt-6.2-astra/);
  const blocked = resolveAgentWalk({ tiers: { strong: [ASTRA], medium: [], light: [] }, agentTier: 'strong', nowMs: NOW, reservations: CODEX_FOR_VISUAL, kind: 'code' });
  assert.deepEqual(pick(blocked, {}, { pin: OPUS }).entry, OPUS);
});

test('the live limit switch walks tiers too: least used only when every tier is full', () => {
  const walk = resolveAgentWalk({ tiers: TIER_LISTS, agentTier: 'strong', nowMs: NOW });
  const cands = walk.walk.map((w) => cand(w.entry));
  const groups = walk.walk.map((w) => (w.preferred ? 'reserved' : w.tier));
  const limit = (list) => limitSwitchPick(list, readings, NOW);
  let readings = { 'claude-opus-5-5': { percent: 100 }, 'Gemini 4 Argon (Medium)': { percent: 90 }, 'gpt-6.2-astra': { percent: 95 }, 'claude-sonnet-5-5': { percent: 10 } };
  assert.equal(walk.walk[pickByTier(groups, cands, limit).index].entry.model, 'claude-sonnet-5-5');
  readings = Object.fromEntries(walk.walk.map((w, i) => [w.entry.model, { percent: 90 + i }]));
  const p = pickByTier(groups, cands, limit);
  assert.equal(walk.walk[p.index].entry.model, 'claude-opus-5-5');
  assert.equal(p.full, true);
});

test('parseModelTiers keeps valid entries, caps, and the first tier a model appears in', () => {
  const t = parseModelTiers({
    strong: [OPUS, { provider: 'nope' }, { ...ASTRA, maxPercent: 50 }],
    medium: [SONNET, OPUS],
    light: 'not a list'
  });
  assert.deepEqual(t.strong, [OPUS, { ...ASTRA, maxPercent: 50 }]);
  assert.deepEqual(t.medium, [SONNET]);
  assert.deepEqual(t.light, []);
  assert.deepEqual(parseModelTiers(undefined), { top: [], strong: [], medium: [], light: [] });
});

test('validateModelTiers refuses a model in two tiers and a bad cap', () => {
  assert.equal(validateModelTiers(TIER_LISTS).ok, true);
  const dup = validateModelTiers({ ...TIER_LISTS, light: [OPUS] });
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /claude\/claude-opus-5-5 is in both strong and light/);
  const cap = validateModelTiers({ ...TIER_LISTS, strong: [{ ...OPUS, maxPercent: 0 }] });
  assert.equal(cap.ok, false);
  assert.match(cap.reason, /maxPercent/);
});

test('tierOfEntry finds the tier holding an entry; defaultTierFor follows modelStrength', () => {
  assert.equal(tierOfEntry(TIER_LISTS, SONNET), 'medium');
  assert.equal(tierOfEntry(TIER_LISTS, FABLE), undefined);
  assert.equal(defaultTierFor('claude-fable-5-2'), 'strong');
  assert.equal(defaultTierFor('claude-sonnet-5-5'), 'medium');
  assert.equal(defaultTierFor('gpt-6-luna'), 'light');
  assert.equal(defaultTierFor('gpt-6.1-terra'), 'medium');
  assert.equal(defaultTierFor(undefined), 'medium');
});
