'use strict';

// camp-unit-art-fable-fallback: any unit art effort (splat,
// visual-judgment, image-making) runs on Codex (Astra) first and falls back to Fable
// (claude-fable-5-2, top tier) when Codex is maxed out, with no manual escalation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { tierWalk, resolveAgentWalk } = loadTs('src/shared/modelTiers.ts');
const { pickAgentEntry, escalationLedger } = loadTs('src/main/tierPick.ts');
const { ENGINE_FULL_PERCENT } = loadTs('src/main/engineChoice.ts');
const { WORK_KIND_GUIDE } = loadTs('src/shared/workKind.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { createCard, patchCard, dispatchTask } = loadTs('src/main/campTools.ts');

const ART_PROJECTS = ['Alpha', 'GammaGame', 'DeltaGame'];
const ART_SET = new Set(ART_PROJECTS);

const NOW = Date.parse('2026-11-22T12:00:00Z');
const ART_KINDS = ['splat', 'visual-judgment', 'image-making'];
const NON_ART_KINDS = ['code', 'research', 'video', undefined];

const FABLE = { provider: 'claude', model: 'claude-fable-5-2' };
const ASTRA = { provider: 'codex', model: 'gpt-6.2-astra' };
const OPUS = { provider: 'claude', model: 'claude-opus-5-5' };
const NEON = { provider: 'antigravity', model: 'gemini-4-neon-medium' };
const SOL = { provider: 'codex', model: 'gpt-6.2-sol' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-5-5' };
const FLASH = { provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' };
const LUNA = { provider: 'codex', model: 'gpt-6-luna' };

const LIVE_TIERS = {
  top: [FABLE, ASTRA],
  strong: [OPUS, NEON, SOL],
  medium: [SONNET],
  light: [FLASH, LUNA]
};

const CODEX_ART_RES = [{
  provider: 'codex',
  kinds: ['splat', 'visual-judgment', 'image-making'],
  until: '2026-11-26T00:00:00Z',
  note: 'Astra splat work'
}];

// Provider-level meter (matches Camp's engineFor: all Codex models share 'codex', all Claude models share 'claude').
const providerCand = (e) => ({ engine: e.provider, label: `${e.provider}/${e.model}` });
// Per-model meter for testing fallback inside top/strong when Fable specifically is full.
const modelCand = (e) => ({ engine: e.model, label: `${e.provider}/${e.model}` });
const models = (walk) => walk.walk.map((w) => w.entry.model);

test('art kinds imply top in tierWalk without manual escalation across difficulties and agent tiers', () => {
  for (const kind of ART_KINDS) {
    for (const agentTier of ['strong', 'medium', 'light']) {
      for (const difficulty of [undefined, 'easy', 'normal', 'hard']) {
        const walk = tierWalk(agentTier, difficulty, undefined, kind);
        assert.equal(walk[0], 'top', `${kind} / ${agentTier} / ${difficulty} should start on top`);
      }
    }
  }
});

test('art kind with Codex free picks Codex (Astra) first from top via reservation, with no manual escalation', () => {
  for (const kind of ART_KINDS) {
    const walk = resolveAgentWalk({
      tiers: LIVE_TIERS,
      agentTier: 'medium',
      difficulty: 'hard',
      nowMs: NOW,
      reservations: CODEX_ART_RES,
      kind
    });
    assert.equal(walk.escalated, undefined, `${kind}: no manual escalation`);
    assert.equal(walk.walk[0].entry.model, 'gpt-6.2-astra', `${kind}: Astra first`);
    assert.equal(walk.walk[0].tier, 'top');
    assert.equal(walk.walk[0].preferred, true);

    const pick = pickAgentEntry({
      walk,
      candidateOf: providerCand,
      readings: { codex: { percent: 10 }, claude: { percent: 10 }, antigravity: { percent: 10 } },
      nowMs: NOW
    });
    assert.equal(pick.entry.model, 'gpt-6.2-astra', `${kind}: picks Astra when Codex is free`);
    assert.equal(pick.tier, 'top');
    assert.deepEqual(escalationLedger(walk, pick), {}, `${kind}: unescalated art pick records no escalation`);
  }
});

test('art kind with Codex at ENGINE_FULL_PERCENT walks to claude-fable-5-2 next, not Opus 5.5, with no manual escalation', () => {
  for (const kind of ART_KINDS) {
    for (const difficulty of [undefined, 'normal', 'hard']) {
      const walk = resolveAgentWalk({
        tiers: LIVE_TIERS,
        agentTier: 'strong',
        difficulty,
        nowMs: NOW,
        reservations: CODEX_ART_RES,
        kind
      });
      assert.equal(walk.escalated, undefined);
      const pick = pickAgentEntry({
        walk,
        candidateOf: providerCand,
        readings: { codex: { percent: ENGINE_FULL_PERCENT }, claude: { percent: 10 }, antigravity: { percent: 10 } },
        nowMs: NOW
      });
      assert.equal(pick.entry.model, 'claude-fable-5-2', `${kind} (${difficulty}): falls back to Fable when Codex is at ${ENGINE_FULL_PERCENT}%`);
      assert.equal(pick.tier, 'top');
      assert.notEqual(pick.entry.model, 'claude-opus-5-5');
    }
  }
});

test('art kind falls back to strong only after both Codex and Fable are full', () => {
  const walk = resolveAgentWalk({
    tiers: LIVE_TIERS,
    agentTier: 'strong',
    difficulty: 'hard',
    nowMs: NOW,
    reservations: CODEX_ART_RES,
    kind: 'splat'
  });
  const pick = pickAgentEntry({
    walk,
    candidateOf: modelCand,
    readings: {
      'gpt-6.2-astra': { percent: ENGINE_FULL_PERCENT },
      'gpt-6.2-sol': { percent: ENGINE_FULL_PERCENT },
      'gpt-6-luna': { percent: ENGINE_FULL_PERCENT },
      'claude-fable-5-2': { percent: ENGINE_FULL_PERCENT },
      'claude-opus-5-5': { percent: 10 }
    },
    nowMs: NOW
  });
  assert.equal(pick.entry.model, 'claude-opus-5-5');
  assert.equal(pick.tier, 'strong');
});

test('reservation preferred list includes top entries for its reserved kind even without escalation', () => {
  const videoRes = [{ provider: 'codex', model: 'gpt-6.2-astra', kinds: ['video'], until: '2026-11-26T00:00:00Z' }];
  const walk = resolveAgentWalk({
    tiers: LIVE_TIERS,
    agentTier: 'medium',
    difficulty: 'normal',
    nowMs: NOW,
    reservations: videoRes,
    kind: 'video'
  });
  assert.equal(walk.walk[0].entry.model, 'gpt-6.2-astra');
  assert.equal(walk.walk[0].tier, 'top');
  assert.equal(walk.walk[0].preferred, true);
  assert.ok(!models(walk).includes('claude-fable-5-2'), 'unreserved top entry stays off non-art walk');
});

test('boundary: non-art kinds never walk top without a hard-card escalation', () => {
  for (const kind of NON_ART_KINDS) {
    for (const agentTier of ['strong', 'medium', 'light']) {
      for (const difficulty of [undefined, 'easy', 'normal', 'hard']) {
        assert.ok(!tierWalk(agentTier, difficulty, undefined, kind).includes('top'), `${kind} / ${agentTier} / ${difficulty}`);
      }
    }
    const walk = resolveAgentWalk({
      tiers: LIVE_TIERS,
      agentTier: 'strong',
      difficulty: 'hard',
      nowMs: NOW,
      reservations: CODEX_ART_RES,
      kind
    });
    assert.ok(!walk.tiers.includes('top'), `${kind}: no top in tiers`);
    assert.ok(!models(walk).includes('claude-fable-5-2'), `${kind}: no Fable on walk`);
    assert.ok(!models(walk).includes('gpt-6.2-astra'), `${kind}: reserved Astra excluded`);
    const pick = pickAgentEntry({
      walk,
      candidateOf: modelCand,
      readings: { 'claude-opus-5-5': { percent: 99 }, 'gemini-4-neon-medium': { percent: 99 }, 'claude-sonnet-5-5': { percent: 10 } },
      nowMs: NOW
    });
    assert.equal(pick.entry.model, 'claude-sonnet-5-5', `${kind}: strong full falls to medium, not top`);
    assert.equal(pick.tier, 'medium');
  }
});

// ─── Step 3: art-kind rule, Boss-only kind, and code-kind refusal guard ──────

test('WORK_KIND_GUIDE states unit-art deliverables take an art kind even when Python/Blender', () => {
  assert.match(WORK_KIND_GUIDE, /unit-art deliverables/i);
  assert.match(WORK_KIND_GUIDE, /Python\/Blender/i);
  assert.match(WORK_KIND_GUIDE, /splat, visual-judgment, image-making/);
});

test('kind and kindReason remain Boss-only in task-patch', () => {
  const existing = [{ id: 'c1', title: 'Regular task', project: 'Alpha', assignee: 'birch', status: 'todo' }];
  const r1 = planTaskMessage({ act: 'task-patch', body: { id: 'c1', kind: 'splat' }, sender: 'birch', isBoss: false, tasks: existing, now: '2026-11-22T23:00:00Z' });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /not allowed.*kind/);
  const r2 = planTaskMessage({ act: 'task-patch', body: { id: 'c1', kindReason: 'override' }, sender: 'birch', isBoss: false, tasks: existing, now: '2026-11-22T23:00:00Z' });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not allowed.*kindReason/);
});

test('task-create and task-patch refuse kind "code" on Alpha/GammaGame/DeltaGame art cards unless kindReason is set', () => {
  for (const project of ART_PROJECTS) {
    for (const kw of ['splat', 'felt', 'sprite', 'strip', 'export']) {
      // Title match on task-create
      const cTitle = planTaskMessage({
        act: 'task-create',
        body: { id: `c-${project}-${kw}`, title: `Fix ${kw} pipeline`, project, assignee: 'birch', kind: 'code' },
        sender: 'god', isBoss: true, tasks: [], now: '2026-11-22T23:00:00Z', artProjects: ART_SET
      });
      assert.equal(cTitle.ok, false, `task-create ${project} title "${kw}" should refuse kind code`);
      assert.match(cTitle.reason, /kind "code" refused/);
      assert.match(cTitle.reason, /kindReason/);

      // Description match on task-create
      const cDesc = planTaskMessage({
        act: 'task-create',
        body: { id: `d-${project}-${kw}`, title: 'Adjust pipeline', description: `Re-run ${kw} pass`, project, assignee: 'birch', kind: 'code' },
        sender: 'god', isBoss: true, tasks: [], now: '2026-11-22T23:00:00Z', artProjects: ART_SET
      });
      assert.equal(cDesc.ok, false, `task-create ${project} description "${kw}" should refuse kind code`);

      // Override with kindReason succeeds
      const cOverride = planTaskMessage({
        act: 'task-create',
        body: { id: `o-${project}-${kw}`, title: `Fix ${kw} parser`, project, assignee: 'birch', kind: 'code', kindReason: 'pure CLI arg parsing, no art output' },
        sender: 'god', isBoss: true, tasks: [], now: '2026-11-22T23:00:00Z', artProjects: ART_SET
      });
      assert.equal(cOverride.ok, true, `task-create ${project} with kindReason should pass`);
      assert.equal(cOverride.card.kind, 'code');
      assert.equal(cOverride.card.kindReason, 'pure CLI arg parsing, no art output');

      // Art kind succeeds without kindReason
      const cArt = planTaskMessage({
        act: 'task-create',
        body: { id: `a-${project}-${kw}`, title: `Fix ${kw} output`, project, assignee: 'birch', kind: 'splat' },
        sender: 'god', isBoss: true, tasks: [], now: '2026-11-22T23:00:00Z', artProjects: ART_SET
      });
      assert.equal(cArt.ok, true, `task-create ${project} with kind splat should pass`);
    }
  }

  // task-patch setting kind: 'code' on existing Alpha felt card refused without kindReason
  const existing = [{ id: 'alpha-felt-1', title: 'Felt export parity', project: 'Alpha', assignee: 'birch', status: 'todo' }];
  const pRefused = planTaskMessage({
    act: 'task-patch',
    body: { id: 'alpha-felt-1', kind: 'code' },
    sender: 'god', isBoss: true, tasks: existing, now: '2026-11-22T23:00:00Z', artProjects: ART_SET
  });
  assert.equal(pRefused.ok, false);
  assert.match(pRefused.reason, /kind "code" refused/);

  // task-patch with kindReason passes
  const pOk = planTaskMessage({
    act: 'task-patch',
    body: { id: 'alpha-felt-1', kind: 'code', kindReason: 'unit test harness only' },
    sender: 'god', isBoss: true, tasks: existing, now: '2026-11-22T23:00:00Z', artProjects: ART_SET
  });
  assert.equal(pOk.ok, true);

  // Non-game projects (e.g. Camp) are NOT refused
  const campOk = planTaskMessage({
    act: 'task-create',
    body: { id: 'camp-export-1', title: 'Export metrics', project: 'Camp', assignee: 'birch', kind: 'code' },
    sender: 'god', isBoss: true, tasks: [], now: '2026-11-22T23:00:00Z', artProjects: ART_SET
  });
  assert.equal(campOk.ok, true);

  // Worker status patch on an already-code card is NOT blocked
  const legacyCode = [{ id: 'alpha-old', title: 'Old felt card', project: 'Alpha', assignee: 'birch', status: 'todo', kind: 'code' }];
  const workerStart = planTaskMessage({
    act: 'task-patch',
    body: { id: 'alpha-old', status: 'doing' },
    sender: 'birch', isBoss: false, tasks: legacyCode, now: '2026-11-22T23:00:00Z', artProjects: ART_SET
  });
  assert.equal(workerStart.ok, true);
});

test('campTools createCard, patchCard, and dispatchTask enforce artCodeKindError and forward kindReason', () => {
  const hiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-art-projects-'));
  const hiveFile = ART_PROJECTS.map((name) => ({ name, artPipeline: true }));
  fs.writeFileSync(path.join(hiveRoot, 'projects.json'), JSON.stringify([...hiveFile, { name: 'Camp' }]));
  try {
  const writes = [];
  const writeFileFn = (p, c) => writes.push({ p, c: JSON.parse(c) });

  const cBad = createCard({ title: 'Splat holdout fix', project: 'Alpha', assignee: 'birch', kind: 'code', hiveRoot, outboxDir: '/tmp/o', writeFileFn });
  assert.equal(cBad.ok, false);
  assert.match(cBad.error, /kind "code" refused/);
  assert.equal(writes.length, 0);

  const cGood = createCard({ title: 'Splat holdout fix', project: 'Alpha', assignee: 'birch', kind: 'code', kindReason: 'parser only', hiveRoot, outboxDir: '/tmp/o', writeFileFn });
  assert.equal(cGood.ok, true);
  assert.equal(cGood.createPayload.body.kindReason, 'parser only');

  const pBad = patchCard({ id: 'c1', title: 'Sprite strip trim', project: 'GammaGame', kind: 'code', hiveRoot, outboxDir: '/tmp/o', writeFileFn });
  assert.equal(pBad.ok, false);
  assert.match(pBad.error, /kind "code" refused/);

  const dBad = dispatchTask({
    card: { id: 'c2', title: 'DeltaGame felt shader', project: 'DeltaGame', kind: 'code' },
    assignee: 'birch',
    contract: 'Fix it',
    hiveRoot, outboxDir: '/tmp/o',
    writeFileFn
  });
  assert.equal(dBad.ok, false);
  assert.match(dBad.error, /kind "code" refused/);
  } finally { rmTree(hiveRoot); }
});
