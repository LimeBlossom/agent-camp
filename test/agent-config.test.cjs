'use strict';

/**
 * Boss `agent-config` messages through the outbox: set one or more agents' camp
 * model tier (and/or primary provider/model) on the same store the UI uses, expose
 * the resolved walk as `ladder` in `fleet.json`, and refuse bad input or non-Boss
 * senders with the reason delivered to the sender's inbox.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { RosterStore } = loadTs('src/main/roster.ts');
const { parseModelEntry, planAgentConfigMessage } = loadTs('src/shared/modelBalance.ts');

function baseAgents() {
  return {
    'god-1': {
      id: 'god-1',
      isGod: true,
      onRoster: true,
      provider: 'claude',
      model: 'claude-opus-4-7',
      placement: { unity: false, network: false, extraDirs: 0, isGod: true }
    },
    'worker-1': {
      id: 'worker-1',
      isGod: false,
      onRoster: true,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      placement: { unity: false, network: false, extraDirs: 0, isGod: false }
    },
    'worker-2': {
      id: 'worker-2',
      isGod: false,
      onRoster: true,
      provider: 'codex',
      model: 'gpt-5.4',
      placement: { unity: false, network: false, extraDirs: 0, codexSandbox: 'sandboxed', isGod: false }
    }
  };
}

test('parseModelEntry accepts object entries, provider/model strings, and agy alias', () => {
  assert.deepEqual(parseModelEntry({ provider: 'antigravity', model: 'gemini-3-flash' }), {
    ok: true,
    entry: { provider: 'antigravity', model: 'gemini-3-flash' }
  });
  assert.deepEqual(parseModelEntry('agy/claude-opus-4-6-thinking'), {
    ok: true,
    entry: { provider: 'antigravity', model: 'claude-opus-4-6-thinking' }
  });
  assert.deepEqual(parseModelEntry('codex/default'), {
    ok: true,
    entry: { provider: 'codex' }
  });
  assert.equal(parseModelEntry('unknown/model').ok, false);
  assert.equal(parseModelEntry({ provider: 'claude', extra: 1 }).ok, false);
});

const TIERS = {
  strong: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'antigravity', model: 'Gemini 4 Argon (Medium)' }],
  medium: [{ provider: 'claude', model: 'claude-sonnet-5-5' }],
  light: [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }, { provider: 'codex', model: 'gpt-6-luna' }]
};

test('planAgentConfigMessage validates tier, bulk ids, provider and entryExclusion rules', () => {
  const agents = baseAgents();

  const strong = planAgentConfigMessage({ isBoss: true, agents, tiers: TIERS, body: { id: 'worker-1', tier: 'strong' } });
  assert.equal(strong.ok, true);
  assert.equal(strong.patches.length, 1);
  assert.equal(strong.patches[0].engineChanged, false);
  assert.deepEqual(strong.patches[0].effectiveLadder.map((e) => e.model), [
    'claude-opus-5-5', 'Gemini 4 Argon (Medium)', 'claude-sonnet-5-5', 'Gemini 3.8 Flash (High)', 'gpt-6-luna'
  ]);

  // worker-2 has a sandbox level, so its walk leaves out the agy entries
  const sandboxed = planAgentConfigMessage({ isBoss: true, agents, tiers: TIERS, body: { id: 'worker-2', tier: 'strong' } });
  assert.equal(sandboxed.ok, true);
  assert.deepEqual(sandboxed.patches[0].effectiveLadder.map((e) => e.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-luna']);

  // A stored tier is kept when only the engine changes
  const engine = planAgentConfigMessage({
    isBoss: true, agents: { ...agents, 'worker-1': { ...agents['worker-1'], tier: 'light' } }, tiers: TIERS,
    body: { id: 'worker-1', provider: 'codex', model: 'gpt-6-luna' }
  });
  assert.equal(engine.ok, true);
  assert.equal(engine.patches[0].tier, undefined);
  assert.equal(engine.patches[0].engineChanged, true);
  assert.match(engine.patches[0].command, /^codex/);
  assert.deepEqual(engine.patches[0].effectiveLadder.map((e) => e.model), ['Gemini 3.8 Flash (High)', 'gpt-6-luna']);

  const okBulk = planAgentConfigMessage({ isBoss: true, agents, tiers: TIERS, body: { ids: ['worker-1', 'worker-2'], tier: 'medium' } });
  assert.equal(okBulk.ok, true);
  assert.deepEqual(okBulk.ids, ['worker-1', 'worker-2']);

  const excludedAgy = planAgentConfigMessage({ isBoss: true, agents, tiers: TIERS, body: { id: 'worker-2', provider: 'agy', model: 'gemini-3-flash' } });
  assert.equal(excludedAgy.ok, false);
  assert.equal(excludedAgy.id, 'worker-2');
  assert.match(excludedAgy.reason, /runs without a sandbox; this agent has a sandbox level set/);

  const nonBoss = planAgentConfigMessage({ isBoss: false, agents, tiers: TIERS, body: { id: 'worker-1', tier: 'strong' } });
  assert.equal(nonBoss.ok, false);
  assert.match(nonBoss.reason, /only the Boss changes agent balancers/);

  const bossNoInbox = planAgentConfigMessage({ isBoss: true, godId: 'god-1', agents, tiers: TIERS, body: { id: 'boss', provider: 'kimi', model: 'kimi-k2' } });
  assert.equal(bossNoInbox.ok, false);
  assert.match(bossNoInbox.reason, /cannot drain hive mail/);

  const nothing = planAgentConfigMessage({ isBoss: true, agents, tiers: TIERS, body: { id: 'worker-1' } });
  assert.equal(nothing.ok, false);
  assert.match(nothing.reason, /send "tier", "provider", or "model"/);
});

test('HiveManager routes Boss agent-config outbox message to RosterStore, fleet.json, and renderer IPC, and refuses bad/worker requests via inbox', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-config-'));
  t.after(() => rmTree(home));

  const emitted = [];
  const hive = new HiveManager(
    () => home,
    (channel, payload) => {
      emitted.push({ channel, payload });
      return true;
    }
  );
  hive.setModelTiersSource(() => TIERS);
  await hive.ensureAgent({ id: 'god-1', name: 'Oak', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Birch', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Alder', provider: 'codex', cwd: home });
  hive.setCodexSandbox('worker-2', 'sandboxed');

  const roster = new RosterStore(() => home);
  roster.write({
    version: 1,
    savedAt: new Date(0).toISOString(),
    agents: [
      { id: 'god-1', name: 'Oak', provider: 'claude', model: 'claude-opus-5-5', command: 'claude --model claude-opus-5-5', isGod: true },
      { id: 'worker-1', name: 'Birch', provider: 'claude', model: 'claude-sonnet-5-5', command: 'claude --model claude-sonnet-5-5', tier: 'medium' }
    ],
    archived: [],
    restorable: [
      { id: 'worker-2', name: 'Alder', provider: 'codex', model: 'gpt-6-luna', command: 'codex --model gpt-6-luna' }
    ],
    queues: {},
    selectedId: 'god-1'
  });

  const root = path.join(home, 'hive');
  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [
      { id: 'god-1', name: 'Oak', model: 'claude-opus-5-5', ladder: [{ provider: 'claude', model: 'claude-opus-5-5' }] },
      { id: 'worker-1', name: 'Birch', model: 'claude-sonnet-5-5', ladder: [{ provider: 'claude', model: 'claude-sonnet-5-5' }] },
      { id: 'worker-2', name: 'Alder', model: 'gpt-6-luna', ladder: [{ provider: 'codex', model: 'gpt-6-luna' }] }
    ]
  });

  const sendOutbox = (agentId, msg) => {
    const file = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    fs.writeFileSync(path.join(root, 'agents', agentId, 'outbox', file), JSON.stringify(msg), 'utf8');
    return hive.routeOnce();
  };

  // 1) Boss moves worker-1 to the light tier
  assert.equal(sendOutbox('god-1', { to: 'harness', act: 'agent-config', body: { id: 'worker-1', tier: 'light' } }), 1);
  const lightWalk = [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }, { provider: 'codex', model: 'gpt-6-luna' }];

  const w1 = roster.read().agents.find((a) => a.id === 'worker-1');
  assert.equal(w1.tier, 'light');
  assert.equal('models' in w1, false);

  // A fresh RosterStore (simulating a renderer before its first non-empty write)
  // still has its empty-first-write guard armed after a main-side patchAgents write.
  const freshStore = new RosterStore(() => home);
  freshStore.patchAgents([{ id: 'worker-1', patch: { tier: 'light' } }]);
  const emptyAttempt = freshStore.write({
    version: 1,
    savedAt: new Date().toISOString(),
    agents: [],
    archived: [],
    restorable: [],
    queues: {},
    selectedId: null
  });
  assert.equal(emptyAttempt.ok, false);
  assert.equal(emptyAttempt.skipped, 'empty-first-write');

  const cfgEvt = emitted.find((e) => e.channel === 'hive:agentConfigChanged');
  assert.ok(cfgEvt, 'expected hive:agentConfigChanged IPC event');
  assert.equal(cfgEvt.payload.patches.length, 1);
  assert.equal(cfgEvt.payload.patches[0].id, 'worker-1');
  assert.equal(cfgEvt.payload.patches[0].tier, 'light');

  const fleet = hive.readFleet(root);
  const w1Fleet = fleet.agents.find((a) => a.id === 'worker-1');
  assert.deepEqual(w1Fleet.ladder, lightWalk);
  assert.equal(w1Fleet.tier, 'light');
  assert.equal(hive.inbox('god-1').length, 0, 'successful agent-config sends no refusal mail');

  // 2) Worker attempts to send agent-config -> refused with mail in worker's inbox
  sendOutbox('worker-1', { to: 'harness', act: 'agent-config', body: { id: 'worker-1', tier: 'strong' } });
  const w1Inbox = hive.inbox('worker-1');
  assert.equal(w1Inbox.length, 1);
  assert.equal(w1Inbox[0].from, 'harness');
  assert.match(w1Inbox[0].subject, /agent-config refused for worker-1: only the Boss changes agent balancers/);

  // 3) Boss puts sandboxed worker-2 on agy -> refused with reason in Boss's inbox
  sendOutbox('god-1', { to: 'harness', act: 'agent-config', body: { id: 'worker-2', provider: 'agy', model: 'gemini-3-flash' } });
  const godInbox = hive.inbox('god-1');
  assert.equal(godInbox.length, 1);
  assert.equal(godInbox[0].from, 'harness');
  assert.match(godInbox[0].subject, /agent-config refused for worker-2:.*sandbox level set/);

  // 4) PROTOCOL-BOSS.md documents agent-config with tier, and the tier walk in fleet.json
  const protoBoss = fs.readFileSync(path.join(root, 'PROTOCOL-BOSS.md'), 'utf8');
  assert.match(protoBoss, /"act": "agent-config"/);
  assert.match(protoBoss, /"tier": "light"/);
  assert.match(protoBoss, /`ladder`/);
  assert.doesNotMatch(protoBoss, /"ladder": \[/);
});

test('agent-config sets a camp model tier; per-agent ladders are refused with a pointer to tiers', () => {
  const agents = baseAgents();
  const tiers = {
    strong: [{ provider: 'claude', model: 'claude-opus-5-5' }],
    medium: [{ provider: 'claude', model: 'claude-sonnet-5-5' }],
    light: [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }]
  };
  const ok = planAgentConfigMessage({ isBoss: true, agents, tiers, body: { id: 'worker-1', tier: 'light' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.patches[0].tier, 'light');
  assert.deepEqual(ok.patches[0].effectiveLadder, [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }]);

  const bulk = planAgentConfigMessage({ isBoss: true, agents, tiers, body: { ids: ['worker-1', 'boss'], tier: 'strong' } });
  assert.equal(bulk.ok, true);
  assert.deepEqual(bulk.patches.map((p) => p.tier), ['strong', 'strong']);

  for (const key of ['ladder', 'models']) {
    const refused = planAgentConfigMessage({ isBoss: true, agents, tiers, body: { id: 'worker-1', [key]: ['claude/claude-opus-5-5'] } });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /per-agent ladders were replaced by camp model tiers; send "tier"/);
  }
  const bad = planAgentConfigMessage({ isBoss: true, agents, tiers, body: { id: 'worker-1', tier: 'ultra' } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /tier must be one of strong, medium, light/);
});
