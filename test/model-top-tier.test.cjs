'use strict';

// camp-model-top-tier: a "top" tier above strong that only a hard card
// reaches, after a quality send-back or when its assignee escalates. Fable effort caps at high.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  TIERS, AGENT_TIERS, TIER_LABEL, isTier, emptyTiers, tierWalk, parseModelTiers, validateModelTiers,
  resolveAgentWalk, agentTierOf, planTierMigration, withTopTier, cardEscalation
} = loadTs('src/shared/modelTiers.ts');
const { pickAgentEntry, escalationLedger } = loadTs('src/main/tierPick.ts');
const { difficultyEffort, ledgerEffort } = loadTs('src/shared/difficulty.ts');
const { FABLE_MAX_EFFORT } = loadTs('src/shared/effort.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

const NOW = Date.parse('2026-11-21T12:00:00Z');
const OPUS = { provider: 'claude', model: 'claude-opus-5-5' };
const FABLE = { provider: 'claude', model: 'claude-fable-5-2' };
const ASTRA = { provider: 'codex', model: 'gpt-6.2-astra' };
const SOL = { provider: 'codex', model: 'gpt-6.2-sol' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' };
const FLASH = { provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' };

const LISTS = { top: [FABLE, ASTRA], strong: [OPUS, SOL], medium: [SONNET], light: [FLASH] };
const cand = (e) => ({ engine: e.model, label: `${e.provider}/${e.model}` });
const models = (walk) => walk.walk.map((w) => w.entry.model);
const SEND_BACK = { reason: 'send-back', detail: '1 send-back' };
const SELF = { reason: 'self', detail: 'needs a proof Opus keeps fumbling' };

// Step 1: the tier list and its config surface.

test('four tiers, top first; agents are placed on strong, medium or light only', () => {
  assert.deepEqual([...TIERS], ['top', 'strong', 'medium', 'light']);
  assert.deepEqual([...AGENT_TIERS], ['strong', 'medium', 'light']);
  assert.equal(isTier('top'), true);
  assert.equal(TIER_LABEL.top, 'Top');
  assert.deepEqual(emptyTiers(), { top: [], strong: [], medium: [], light: [] });
});

test('a stored config without top parses and validates with an empty top list', () => {
  const old = { strong: [OPUS], medium: [SONNET], light: [FLASH] };
  assert.deepEqual(parseModelTiers(old).top, []);
  const v = validateModelTiers(old);
  assert.equal(v.ok, true);
  assert.deepEqual(v.tiers.top, []);
  const both = validateModelTiers({ top: [FABLE], strong: [FABLE] });
  assert.equal(both.ok, false);
  assert.match(both.reason, /in both top and strong/);
  assert.deepEqual(parseModelTiers({ top: [FABLE], strong: [FABLE, OPUS] }).strong, [OPUS], 'a model in top and strong keeps top');
});

test('the config migration gives an existing modelTiers an empty top list and leaves the rest alone', () => {
  const old = { strong: [OPUS, FABLE], medium: [SONNET], light: [FLASH] };
  const migrated = withTopTier(old);
  assert.deepEqual(migrated, { top: [], strong: [OPUS, FABLE], medium: [SONNET], light: [FLASH] });
  assert.equal(withTopTier({ ...old, top: [ASTRA] }), null, 'already has top: nothing to write');
  assert.equal(withTopTier(undefined), null, 'no tiers yet: the ladder migration owns that');
});

test('the ladder migration puts Fable 5.2 on top, not strong', () => {
  const { tiers } = planTierMigration({ agents: [{ id: 'a', provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, FABLE] }] });
  assert.deepEqual(tiers.top, [FABLE]);
  assert.ok(!tiers.strong.some((e) => e.model === FABLE.model));
});

test('an agent never sits on top: a stored top or a top engine reads as strong', () => {
  assert.equal(agentTierOf('top', LISTS, OPUS), 'strong');
  assert.equal(agentTierOf(undefined, LISTS, FABLE), 'strong');
  assert.equal(agentTierOf(undefined, LISTS, SONNET), 'medium');
});

// Step 2: the escalation walk.

test('a hard card walks strong down without top; escalated, it starts on top', () => {
  assert.deepEqual(tierWalk('medium', 'hard'), ['strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('strong', 'hard'), ['strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('medium', 'hard', SEND_BACK), ['top', 'strong', 'medium', 'light']);
  assert.deepEqual(tierWalk('light', 'hard', SELF), ['top', 'strong', 'medium', 'light']);
});

test('no walk without escalation ever includes top, whatever the difficulty or agent tier', () => {
  for (const agent of ['strong', 'medium', 'light']) {
    for (const d of [undefined, 'easy', 'normal', 'hard']) {
      assert.ok(!tierWalk(agent, d).includes('top'), `${agent} ${d}`);
    }
  }
  assert.deepEqual(tierWalk('strong', 'easy'), ['light', 'medium', 'strong']);
});

test('cardEscalation: only a hard card escalates, by send-back or by its assignee', () => {
  assert.equal(cardEscalation({ difficulty: 'hard' }), undefined);
  assert.equal(cardEscalation({ difficulty: 'hard', sendBacks: 0 }), undefined);
  assert.deepEqual(cardEscalation({ difficulty: 'hard', sendBacks: 2 }), { reason: 'send-back', detail: '2 send-backs' });
  assert.deepEqual(cardEscalation({ difficulty: 'hard', sendBacks: 1 }), { reason: 'send-back', detail: '1 send-back' });
  assert.deepEqual(
    cardEscalation({ difficulty: 'hard', escalation: { reason: 'needs a proof Opus keeps fumbling', by: 'birch', at: 'x' } }),
    { reason: 'self', detail: 'needs a proof Opus keeps fumbling' }
  );
  assert.equal(cardEscalation({ difficulty: 'hard', sendBacks: 1, escalation: { reason: 'r', by: 'b', at: 'x' } }).reason, 'send-back', 'a send-back is named first');
  assert.equal(cardEscalation({ difficulty: 'normal', sendBacks: 3 }), undefined);
  assert.equal(cardEscalation({ sendBacks: 3, escalation: { reason: 'r' } }), undefined);
});

test('an escalated hard card picks Fable first, then Astra, then falls to strong', () => {
  const walk = resolveAgentWalk({ tiers: LISTS, agentTier: 'medium', difficulty: 'hard', escalation: SEND_BACK, nowMs: NOW });
  assert.deepEqual(models(walk), ['claude-fable-5-2', 'gpt-6.2-astra', 'claude-opus-5-5', 'gpt-6.2-sol', 'claude-sonnet-5-5', 'Gemini 3.8 Flash (High)']);
  assert.deepEqual(walk.escalated, SEND_BACK);
  const p = pickAgentEntry({ walk, candidateOf: cand, readings: {}, nowMs: NOW });
  assert.equal(p.entry.model, 'claude-fable-5-2');
  assert.equal(p.tier, 'top');
  assert.match(p.reason, /escalated to top \(send-back: 1 send-back\)/);
  const full = pickAgentEntry({ walk, candidateOf: cand, readings: { 'claude-fable-5-2': { percent: 99 }, 'gpt-6.2-astra': { percent: 99 } }, nowMs: NOW });
  assert.equal(full.tier, 'strong', 'top full: falls back to strong');
});

test('an unescalated hard card never reaches top, not even when strong is full', () => {
  const walk = resolveAgentWalk({ tiers: LISTS, agentTier: 'strong', difficulty: 'hard', nowMs: NOW });
  assert.ok(!walk.tiers.includes('top'));
  assert.ok(!models(walk).includes('claude-fable-5-2'));
  assert.equal(walk.escalated, undefined);
  const p = pickAgentEntry({ walk, candidateOf: cand, readings: { 'claude-opus-5-5': { percent: 99 }, 'gpt-6.2-sol': { percent: 99 } }, nowMs: NOW });
  assert.notEqual(p.tier, 'top');
  assert.notEqual(p.entry?.model, 'claude-fable-5-2');
});

test('widening for an agent that can run nothing on its walk never adds top', () => {
  const walk = resolveAgentWalk({
    tiers: LISTS, agentTier: 'light', difficulty: 'easy', nowMs: NOW,
    exclusion: (e) => (e.provider === 'antigravity' ? 'no agy' : null)
  });
  assert.ok(walk.widened);
  assert.ok(!walk.tiers.includes('top'));
  assert.ok(!models(walk).some((m) => m === 'claude-fable-5-2' || m === 'gpt-6.2-astra'));
});

test('escalation passed for a non-hard card is ignored by the walk', () => {
  const walk = resolveAgentWalk({ tiers: LISTS, agentTier: 'medium', difficulty: 'normal', escalation: SEND_BACK, nowMs: NOW });
  assert.ok(!walk.tiers.includes('top'));
  assert.equal(walk.escalated, undefined);
});

// Step 5: the agent-pick ledger row says when top was used because of escalation, and why.

test('escalationLedger names the reason only when the pick landed on top', () => {
  const walk = resolveAgentWalk({ tiers: LISTS, agentTier: 'medium', difficulty: 'hard', escalation: SELF, nowMs: NOW });
  const onTop = pickAgentEntry({ walk, candidateOf: cand, readings: {}, nowMs: NOW });
  assert.deepEqual(escalationLedger(walk, onTop), { escalation: 'self', escalationDetail: 'needs a proof Opus keeps fumbling' });
  const fellBack = pickAgentEntry({ walk, candidateOf: cand, readings: { 'claude-fable-5-2': { percent: 99 }, 'gpt-6.2-astra': { percent: 99 } }, nowMs: NOW });
  assert.deepEqual(escalationLedger(walk, fellBack), { escalatedFellBack: 'self' });
  const plain = resolveAgentWalk({ tiers: LISTS, agentTier: 'medium', difficulty: 'hard', nowMs: NOW });
  assert.deepEqual(escalationLedger(plain, pickAgentEntry({ walk: plain, candidateOf: cand, readings: {}, nowMs: NOW })), {});
});

// Step 4: Fable runs at high at most.

test('Fable is capped at high effort; other Claude models keep xhigh on hard cards', () => {
  assert.equal(FABLE_MAX_EFFORT, 'high');
  assert.equal(difficultyEffort('hard', 'claude', 'claude-fable-5-2', undefined), 'high');
  assert.equal(difficultyEffort('hard', 'claude', 'claude-fable-5-2', 'max'), 'high');
  assert.equal(difficultyEffort(undefined, 'claude', 'claude-fable-5-2', 'xhigh'), 'high');
  assert.equal(difficultyEffort('normal', 'claude', 'claude-fable-5-2', 'low'), 'low');
  assert.equal(difficultyEffort('easy', 'claude', 'claude-fable-5-2', 'max'), 'medium');
  assert.equal(difficultyEffort('hard', 'claude', 'claude-opus-5-5', undefined), 'xhigh');
  assert.equal(ledgerEffort('hard', 'claude', 'claude-fable-5-2', 'max'), 'high');
});

// Step 3: a worker escalates its own hard card, with a reason the Boss sees.

const card = (extra = {}) => ({ id: 'c', title: 'T', status: 'doing', assignee: 'birch', dependsOn: [], difficulty: 'hard', ...extra });
const worker = (tasks, body) => planTaskMessage({ act: 'task-patch', body, sender: 'birch', isBoss: false, tasks, now: '2026-11-21T12:00:00Z' });

test('a worker escalates its hard card: the card records who, when and why, and the notes say so', () => {
  const p = worker([card({ notes: 'earlier' })], { id: 'c', escalate: { reason: 'the solver needs a proof Opus keeps fumbling' } });
  assert.equal(p.ok, true, p.reason);
  assert.deepEqual(p.patch.escalation, { reason: 'the solver needs a proof Opus keeps fumbling', by: 'birch', at: '2026-11-21T12:00:00Z' });
  assert.deepEqual(p.patch.escalationHistory, [{ who: 'birch', when: '2026-11-21T12:00:00Z', reason: 'the solver needs a proof Opus keeps fumbling' }]);
  assert.match(p.patch.notes, /^earlier\n.*escalated to top.*the solver needs a proof Opus keeps fumbling/);
  assert.equal('escalate' in p.patch, false, 'the request field is not stored raw');
  assert.deepEqual(cardEscalation({ ...card(), ...p.patch }), { reason: 'self', detail: 'the solver needs a proof Opus keeps fumbling' });
});

test('escalation needs a reason and a hard card', () => {
  const none = worker([card()], { id: 'c', escalate: { reason: '  ' } });
  assert.equal(none.ok, false);
  assert.match(none.reason, /escalate needs a reason/);
  const bare = worker([card()], { id: 'c', escalate: true });
  assert.equal(bare.ok, false);
  const normal = worker([card({ difficulty: 'normal' })], { id: 'c', escalate: { reason: 'hard' } });
  assert.equal(normal.ok, false);
  assert.match(normal.reason, /only a hard card escalates/);
});

test('a second escalation appends to the history', () => {
  const prior = { reason: 'first', by: 'birch', at: 'a' };
  const p = worker([card({ escalation: prior, escalationHistory: [{ who: 'birch', when: 'a', reason: 'first' }] })], { id: 'c', escalate: { reason: 'second' } });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.patch.escalationHistory.length, 2);
  assert.equal(p.patch.escalation.reason, 'second');
});
