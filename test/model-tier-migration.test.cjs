'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { planTierMigration, needsTierMigration, resolveAgentWalk } = loadTs('src/shared/modelTiers.ts');

const c = (model) => ({ provider: 'claude', model });
const agy = (model) => ({ provider: 'antigravity', model });
const codex = (model) => ({ provider: 'codex', model });
const OPUS = c('claude-opus-5-5');
const SONNET = c('claude-sonnet-5-5');
const FABLE = c('claude-fable-5-2');

/** The camp's roster ladders and current engines as fleet.json showed them on 2026-11-20. */
const LIVE = {
  god: { provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, SONNET, agy('claude-opus-5-5-high'), codex('gpt-6.2-sol')] },
  agents: [
    { id: 'pine', provider: 'antigravity', model: 'Gemini 3.8 Flash (Medium)', models: [SONNET, codex('gpt-6-luna'), agy('Gemini 3.8 Flash (Medium)')] },
    { id: 'spruce', provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, SONNET, agy('Gemini 4 Argon (Medium)'), codex('gpt-6.2-sol')] },
    { id: 'birch', provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, agy('claude-opus-5-5-medium')] },
    { id: 'hazel', provider: 'claude', model: 'claude-sonnet-5-5', models: [SONNET, agy('claude-sonnet-5-5-medium')] },
    { id: 'fir', provider: 'claude', model: 'claude-sonnet-5-5', models: [agy('claude-sonnet-5-5-medium'), SONNET] },
    { id: 'cypress', provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, SONNET] },
    { id: 'quince', provider: 'antigravity', model: 'Gemini 3.8 Flash (High)', models: [agy('Gemini 3.8 Flash (High)'), codex('gpt-6-luna')] },
    { id: 'willow', provider: 'claude', model: 'claude-opus-5-5', models: [agy('Gemini 4 Argon (Medium)'), OPUS] },
    { id: 'cedar', provider: 'claude', model: 'claude-opus-5-5', models: [OPUS, agy('claude-opus-5-5-medium'), agy('Gemini 4 Argon (Medium)')] },
    { id: 'elm', provider: 'antigravity', model: 'Gemini 3.8 Flash (Medium)', models: [SONNET, codex('gpt-6.2-sol'), agy('Gemini 3.8 Flash (Medium)')] }
  ]
};

const label = (e) => `${e.provider}/${e.model ?? 'default'}`;

test('a config with no modelTiers needs the migration; one with them does not', () => {
  assert.equal(needsTierMigration({}), true);
  assert.equal(needsTierMigration({ godModels: [OPUS] }), true);
  assert.equal(needsTierMigration({ modelTiers: { strong: [], medium: [], light: [] } }), false);
});

test('the live fleet migrates to one list per tier, ordered by how agents ranked each model', () => {
  const { tiers } = planTierMigration(LIVE);
  assert.deepEqual(tiers.strong.map(label), [
    'claude/claude-opus-5-5', 'antigravity/Gemini 4 Argon (Medium)', 'codex/gpt-6.2-sol',
    'antigravity/claude-opus-5-5-medium', 'antigravity/claude-opus-5-5-high'
  ]);
  assert.deepEqual(tiers.top.map(label), ['claude/claude-fable-5-2']);
  assert.deepEqual(tiers.medium.map(label), ['claude/claude-sonnet-5-5', 'antigravity/claude-sonnet-5-5-medium']);
  assert.deepEqual(tiers.light.map(label), ['antigravity/Gemini 3.8 Flash (High)', 'codex/gpt-6-luna', 'antigravity/Gemini 3.8 Flash (Medium)']);
});

test('each agent takes the tier of its ladder\'s first entry; the Boss gets godTier', () => {
  const { agentTiers, godTier } = planTierMigration(LIVE);
  assert.deepEqual(agentTiers, {
    pine: 'medium', spruce: 'strong', birch: 'strong', hazel: 'medium', fir: 'medium',
    cypress: 'strong', quince: 'light', willow: 'strong', cedar: 'strong', elm: 'medium'
  });
  assert.equal(godTier, 'strong');
});

test('no agent loses its working engine: the current engine is on its own normal-card walk', () => {
  const { tiers, agentTiers, godTier } = planTierMigration(LIVE);
  const check = (id, a, tier) => {
    const walk = resolveAgentWalk({ tiers, agentTier: tier, nowMs: 0 });
    assert.ok(walk.walk.some((w) => w.entry.provider === a.provider && w.entry.model === a.model), `${id} keeps ${label(a)}`);
  };
  for (const a of LIVE.agents) check(a.id, a, agentTiers[a.id]);
  check('god', LIVE.god, godTier);
});

test('every entry on any old ladder is on exactly one tier list', () => {
  const { tiers } = planTierMigration(LIVE);
  const all = [...tiers.top, ...tiers.strong, ...tiers.medium, ...tiers.light].map(label);
  assert.equal(new Set(all).size, all.length);
  for (const a of [LIVE.god, ...LIVE.agents]) for (const e of a.models) assert.ok(all.includes(label(e)), label(e));
});

test('an agent with no ladder takes the tier of its current model, which joins the lists', () => {
  const { tiers, agentTiers } = planTierMigration({ agents: [{ id: 'solo', provider: 'codex', model: 'gpt-6-luna' }] });
  assert.equal(agentTiers.solo, 'light');
  assert.deepEqual(tiers.light, [codex('gpt-6-luna')]);
});

test('a neutral model lands in medium', () => {
  const { tiers, agentTiers } = planTierMigration({ agents: [{ id: 't', provider: 'codex', model: 'gpt-6.1-terra', models: [codex('gpt-6.1-terra')] }] });
  assert.deepEqual(tiers.medium, [codex('gpt-6.1-terra')]);
  assert.equal(agentTiers.t, 'medium');
});

test('Fable 5.2 goes on the top tier, once, whether or not a ladder lists it; its agent sits on strong', () => {
  const noOpus = planTierMigration({ agents: [{ id: 'a', provider: 'codex', model: 'gpt-6.2-sol', models: [codex('gpt-6.2-sol')] }] });
  assert.deepEqual(noOpus.tiers.top.map(label), ['claude/claude-fable-5-2']);
  assert.deepEqual(noOpus.tiers.strong.map(label), ['codex/gpt-6.2-sol']);
  const has = planTierMigration({ agents: [{ id: 'a', provider: 'claude', model: 'claude-fable-5-2', models: [FABLE, OPUS] }] });
  assert.deepEqual(has.tiers.top.map(label), ['claude/claude-fable-5-2']);
  assert.deepEqual(has.tiers.strong.map(label), ['claude/claude-opus-5-5']);
  assert.equal(has.agentTiers.a, 'strong');
});

test('two caps on one model merge to the lower; an uncapped listing keeps the cap', () => {
  const { tiers } = planTierMigration({
    agents: [
      { id: 'a', provider: 'codex', model: 'gpt-6.2-sol', models: [{ ...codex('gpt-6.2-sol'), maxPercent: 70 }] },
      { id: 'b', provider: 'codex', model: 'gpt-6.2-sol', models: [{ ...codex('gpt-6.2-sol'), maxPercent: 50 }] },
      { id: 'c', provider: 'codex', model: 'gpt-6.2-sol', models: [codex('gpt-6.2-sol')] }
    ]
  });
  assert.deepEqual(tiers.strong[0], { ...codex('gpt-6.2-sol'), maxPercent: 50 });
});

test('archived agents do not shape the lists', () => {
  const { tiers, agentTiers } = planTierMigration({
    agents: [{ id: 'old', archived: true, provider: 'codex', model: 'gpt-6-luna', models: [codex('gpt-6-luna')] }, { id: 'a', provider: 'claude', model: 'claude-sonnet-5-5' }]
  });
  assert.deepEqual(tiers.light, []);
  assert.equal(agentTiers.old, undefined);
  assert.equal(agentTiers.a, 'medium');
});
