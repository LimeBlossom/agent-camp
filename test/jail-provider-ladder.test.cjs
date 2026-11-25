'use strict';

// A jailed agent whose ladder starts with an engine the jail cannot run: the pick skips it,
// and when nothing on the ladder is runnable the card is blocked and the Boss mailed once,
// with automatic wakes held so the refusal never turns into a respawn loop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { entryExclusion } = loadTs('src/shared/modelBalance.ts');
const { resolveAgentWalk } = loadTs('src/shared/modelTiers.ts');
const { pickAgentEntry } = loadTs('src/main/tierPick.ts');
const { JAIL_PROVIDERS, jailSupports } = loadTs('src/main/agentJail.ts');
const { JailRefusals, jailRefusalNotice } = loadTs('src/main/jailRefusals.ts');

const NOW = Date.parse('2026-11-25T04:05:00Z');
const OPUS = { provider: 'claude', model: 'claude-opus-5-5' };
const ASTRA = { provider: 'codex', model: 'gpt-6.2-astra' };
const LUNA = { provider: 'codex', model: 'gpt-6-luna' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' };
const CODEX_FOR_ART = [{ provider: 'codex', kinds: ['splat', 'visual-judgment', 'image-making'], until: '2026-11-26T00:00:00Z' }];
const plain = { unity: false, network: false, extraDirs: 0, isGod: false };
const jailed = { ...plain, jailProviders: ['claude', 'antigravity'] };
const cand = (e) => ({ engine: e.model, label: `${e.provider}/${e.model}` });

test('the jail names the providers it can run; one with no state map is not one', () => {
  assert.ok(JAIL_PROVIDERS.includes('claude'));
  assert.equal(jailSupports('claude'), true);
  assert.equal(jailSupports('grok'), false);
});

test('exclusion: a jailed agent cannot run a provider the jail does not support', () => {
  assert.match(entryExclusion(ASTRA, jailed), /agent sandbox cannot run Codex/);
  assert.equal(entryExclusion(OPUS, jailed), null);
  assert.equal(entryExclusion(ASTRA, plain), null, 'an unjailed agent keeps codex');
});

test('a reservation for the card kind does not put an unrunnable engine first for a jailed agent', () => {
  const walk = resolveAgentWalk({
    tiers: { strong: [ASTRA, OPUS], medium: [SONNET], light: [LUNA] },
    agentTier: 'strong', nowMs: NOW, reservations: CODEX_FOR_ART, kind: 'image-making',
    exclusion: (e) => entryExclusion(e, jailed)
  });
  assert.equal(walk.walk.some((w) => w.entry.provider === 'codex'), false);
  assert.ok(walk.excluded.some((x) => x.entry.model === ASTRA.model && /agent sandbox/.test(x.reason)));
  const p = pickAgentEntry({ walk, candidateOf: cand, readings: {}, nowMs: NOW });
  assert.equal(p.entry.model, OPUS.model);
});

test('first permanent refusal for a card notifies; a repeat of the same one does not', () => {
  const r = new JailRefusals();
  assert.equal(r.refused('a', 'no codex', NOW, { permanent: true, card: 'c1' }).notify, true);
  assert.equal(r.refused('a', 'no codex', NOW + 60_000, { permanent: true, card: 'c1' }).notify, false);
  assert.equal(r.refused('a', 'no codex', NOW + 120_000, { permanent: true, card: 'c2' }).notify, true, 'a new card is news');
});

test('a transient refusal neither notifies nor holds wakes', () => {
  const r = new JailRefusals();
  assert.equal(r.refused('a', 'bwrap missing', NOW).notify, false);
  assert.equal(r.held('a', 'c1'), false);
});

test('a permanent refusal holds automatic wakes while its card is still next, or when it had no card', () => {
  const r = new JailRefusals();
  r.refused('a', 'no codex', NOW, { permanent: true, card: 'c1' });
  assert.equal(r.held('a', 'c1'), true);
  assert.equal(r.held('a', 'c2'), false, 'once c1 is blocked the next card may start');
  r.refused('b', 'no codex', NOW, { permanent: true });
  assert.equal(r.held('b', undefined), true);
  assert.equal(r.held('b', 'c9'), true);
});

test('a successful spawn or a Boss wake request releases the hold', () => {
  const r = new JailRefusals();
  r.refused('a', 'no codex', NOW, { permanent: true, card: 'c1' });
  r.spawned('a');
  assert.equal(r.held('a', 'c1'), false);
  r.refused('a', 'no codex', NOW, { permanent: true, card: 'c1' });
  r.release('a');
  assert.equal(r.held('a', 'c1'), false);
  assert.equal(r.refused('a', 'no codex', NOW, { permanent: true, card: 'c1' }).notify, true, 'released, so a later refusal is news again');
});

test('the Boss notice names the agent, the card, the provider and what to do', () => {
  const n = jailRefusalNotice('Birch', 'birch-x', 'the agent sandbox does not support provider "codex" yet', 'alpha-vi028');
  assert.match(n.subject, /Birch/);
  assert.match(n.body, /alpha-vi028/);
  assert.match(n.body, /codex/);
  assert.match(n.body, /blocked/);
  assert.match(n.body, /wake request|ladder/);
  const none = jailRefusalNotice('Birch', 'birch-x', 'no codex', undefined);
  assert.doesNotMatch(none.body, /undefined/);
});

test('main wires the jail into engine choice, the wake mode and the spawn refusal', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i)); };
  assert.match(fn('exclusionFor'), /jailProviders/);
  assert.match(fn('wakeModeFor'), /jailRefusals\.held\(/);
  assert.match(src, /jailRefusals\.refused\([^)]*permanent/);
  assert.match(src, /jailRefusals\.release\(/);
});
