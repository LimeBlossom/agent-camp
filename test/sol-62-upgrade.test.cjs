'use strict';

/** GPT-6.2 Sol replaces GPT-6.1 Sol: the picker, the Codex
 *  default, the effort menu, and every saved selection a running hive carries
 *  (worker roster, restorable workers, the Boss's config). Archived workers are
 *  history and keep the model they ran on. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sol62-config-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { RosterStore } = loadTs('src/main/roster.ts');
const { providerPreset } = loadTs('src/shared/agentProvider.ts');
const { buildSpawnCommand, modelsForProvider } = loadTs('src/renderer/src/store/config.ts');
const { effortLevelsFor, capEffort } = loadTs('src/shared/effort.ts');
const { difficultyEffort } = loadTs('src/shared/difficulty.ts');
const { migrateModelList } = loadTs('src/shared/modelMigration.ts');

const OLD = 'gpt-6.1-sol';
const NEW = 'gpt-6.2-sol';

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('the Codex picker offers GPT-6.2 Sol where GPT-6.1 Sol was, and keeps Astra, Terra and Luna', () => {
  const ids = modelsForProvider('codex').map((m) => m.id);
  assert.equal(ids[1], NEW, 'first real model after CLI default');
  assert.equal(modelsForProvider('codex')[1].label, 'GPT-6.2 Sol');
  assert.ok(!ids.includes(OLD), 'GPT-6.1 Sol is no longer offered');
  for (const kept of ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna']) assert.ok(ids.includes(kept), kept);
});

test('both catalog copies agree on the Codex list', () => {
  const root = path.join(__dirname, '..');
  const compiled = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/modelCatalog.json'), 'utf8'));
  const published = JSON.parse(fs.readFileSync(path.join(root, 'docs/model-catalog.json'), 'utf8'));
  assert.deepEqual(published.providers.codex, compiled.providers.codex);
});

test('the recommended Codex orchestrator model is GPT-6.2 Sol', () => {
  assert.equal(providerPreset('codex').recommendedOrchestratorModel, NEW);
});

test('GPT-6.2 Sol offers every effort GPT-6.1 Sol did, max included, and never none', () => {
  const levels = effortLevelsFor('codex', NEW);
  assert.deepEqual(levels, effortLevelsFor('codex', OLD));
  assert.ok(levels.includes('max'));
  assert.ok(!levels.includes('none'));
  assert.equal(capEffort('codex', 'medium'), 'medium');
  for (const d of [undefined, 'easy', 'normal', 'hard']) {
    for (const own of [undefined, 'low', 'medium', 'max']) {
      assert.equal(difficultyEffort(d, 'codex', NEW, own), difficultyEffort(d, 'codex', OLD, own), `${d} ${own}`);
    }
  }
});

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-sol62-roster-'));
}

function solAgent(extra = {}) {
  return {
    id: 'w1', name: 'Elm', provider: 'codex', model: OLD, effort: 'medium',
    command: `codex --model ${OLD} -a never -s workspace-write`,
    models: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: OLD, maxPercent: 80 }],
    note: 'keep me', ...extra
  };
}

function rosterWith(home, extra) {
  fs.writeFileSync(path.join(home, 'roster.json'), JSON.stringify({
    version: 1, savedAt: new Date(0).toISOString(), agents: [], archived: [], restorable: [], queues: {}, selectedId: null, ...extra
  }));
}

test('a saved worker on GPT-6.1 Sol loads on GPT-6.2 Sol with its effort and other settings kept', () => {
  const home = tmpHome();
  rosterWith(home, { agents: [solAgent()] });
  const a = new RosterStore(() => home).read().agents[0];
  assert.equal(a.model, NEW);
  assert.equal(a.command, `codex --model ${NEW} -a never -s workspace-write`);
  assert.deepEqual(a.models, [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: NEW, maxPercent: 80 }]);
  assert.equal(a.effort, 'medium');
  assert.equal(a.note, 'keep me');
  assert.equal(buildSpawnCommand({ defaultCommand: 'claude', autoMode: true }, a.model, 'codex'), a.command);
});

test('restorable workers migrate too, and a ladder holding both Sols keeps the first in either order', () => {
  const home = tmpHome();
  const newThenOld = solAgent({
    id: 'w2',
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
      { provider: 'codex', model: NEW, maxPercent: 90 },
      { provider: 'codex', model: OLD, maxPercent: 70 }
    ]
  });
  const oldThenNew = solAgent({
    id: 'w3',
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
      { provider: 'codex', model: OLD, maxPercent: 70 },
      { provider: 'codex', model: NEW, maxPercent: 90 },
      { provider: 'antigravity', model: 'claude-opus-5-5-high', maxPercent: 85 }
    ]
  });
  rosterWith(home, { restorable: [solAgent(), newThenOld, oldThenNew] });
  const store = new RosterStore(() => home);
  const [r1, r2, r3] = store.read().restorable;
  assert.equal(r1.model, NEW);
  assert.ok(!JSON.stringify(r1).includes(OLD));
  assert.deepEqual(r2.models, [
    { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
    { provider: 'codex', model: NEW, maxPercent: 90 }
  ]);
  assert.deepEqual(r3.models, [
    { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
    { provider: 'codex', model: NEW, maxPercent: 70 },
    { provider: 'antigravity', model: 'claude-opus-5-5-high', maxPercent: 85 }
  ]);
  assert.deepEqual(
    migrateModelList([{ provider: 'codex', model: OLD, maxPercent: 70 }, { provider: 'codex', model: NEW, maxPercent: 90 }]),
    [{ provider: 'codex', model: NEW, maxPercent: 70 }]
  );
  assert.deepEqual(
    migrateModelList([{ provider: 'codex', model: NEW, maxPercent: 90 }, { provider: 'codex', model: OLD, maxPercent: 70 }]),
    [{ provider: 'codex', model: NEW, maxPercent: 90 }]
  );
  const once = migrateModelList(oldThenNew.models);
  assert.equal(migrateModelList(once), once, 'idempotent: second pass returns the same list reference');
});

test('archived workers keep the model they ran on', () => {
  const home = tmpHome();
  rosterWith(home, { archived: [solAgent()] });
  const a = new RosterStore(() => home).read().archived[0];
  assert.equal(a.model, OLD);
  assert.deepEqual(a.models[1], { provider: 'codex', model: OLD, maxPercent: 80 });
});

test('other engines and other Codex models are untouched, and the migration is idempotent', () => {
  const home = tmpHome();
  const others = [
    { id: 'c', provider: 'claude', model: 'claude-opus-5-5', command: 'claude --model claude-opus-5-5' },
    { id: 'l', provider: 'codex', model: 'gpt-6-luna', command: 'codex --model gpt-6-luna -a never', models: [{ provider: 'codex', model: 'gpt-6.2-astra' }] },
    { id: 'g', provider: 'antigravity', model: 'claude-opus-5-5-high', models: [{ provider: 'antigravity', model: 'Gemini 4 Argon (High)' }] }
  ];
  rosterWith(home, { agents: [...others, solAgent()] });
  const store = new RosterStore(() => home);
  const first = store.read();
  assert.deepEqual(first.agents.slice(0, 3), others);
  assert.equal(store.write(first).ok, true);
  assert.deepEqual(new RosterStore(() => home).read().agents, first.agents);
});

test('the Boss saved on GPT-6.1 Sol loads on GPT-6.2 Sol, Claude rungs kept, idempotently', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    onboardingComplete: true,
    godProvider: 'codex',
    godModel: OLD,
    defaultCommand: `codex --model ${OLD} -a never -s workspace-write`,
    godModels: [
      { provider: 'claude', model: 'claude-opus-5-5' },
      { provider: 'antigravity', model: 'claude-opus-5-5-high' },
      { provider: 'codex', model: OLD }
    ]
  }));
  const cfg = readConfig();
  assert.equal(cfg.godModel, NEW);
  assert.equal(cfg.defaultCommand, `codex --model ${NEW} -a never -s workspace-write`);
  assert.deepEqual(cfg.godModels, [
    { provider: 'claude', model: 'claude-opus-5-5' },
    { provider: 'antigravity', model: 'claude-opus-5-5-high' },
    { provider: 'codex', model: NEW }
  ]);
  writeConfig({});
  const onDisk = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
  assert.ok(!onDisk.includes(OLD), 'the next save persists the migration');
  assert.deepEqual(readConfig().godModels, cfg.godModels);
});

test('a Claude Boss is untouched', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    onboardingComplete: true, godProvider: 'claude', godModel: 'claude-opus-5-5', defaultCommand: 'claude --model claude-opus-5-5',
    godModels: [{ provider: 'claude', model: 'claude-opus-5-5' }]
  }));
  const cfg = readConfig();
  assert.equal(cfg.godModel, 'claude-opus-5-5');
  assert.equal(cfg.defaultCommand, 'claude --model claude-opus-5-5');
  assert.deepEqual(cfg.godModels, [{ provider: 'claude', model: 'claude-opus-5-5' }]);
});

function bootRendererStore({ home, storedHome = null, agents, restorable, archived }) {
  const rosterStore = new RosterStore(() => home);
  const ls = new Map();
  if (storedHome !== null) ls.set('cth.rosterHome', storedHome);
  if (agents !== undefined) ls.set('cth.agents', JSON.stringify(agents));
  if (restorable !== undefined) ls.set('cth.restorableAgents', JSON.stringify(restorable));
  if (archived !== undefined) ls.set('cth.archivedAgents', JSON.stringify(archived));
  let beforeUnload = null;
  const win = {
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => { ls.set(k, String(v)); },
      removeItem: (k) => { ls.delete(k); }
    },
    cth: {
      rosterReadSync: () => rosterStore.read(),
      harnessHomeSync: () => home,
      rosterWrite: async (snap) => rosterStore.write(snap)
    },
    addEventListener: (evt, fn) => { if (evt === 'beforeunload') beforeUnload = fn; }
  };
  const prevWindow = global.window;
  global.window = win;
  try {
    delete require.cache[require.resolve('../test-support/load-ts.cjs')];
    const { useStore } = require('../test-support/load-ts.cjs')('src/renderer/src/store/store.ts');
    const flush = () => {
      const prev = global.window;
      global.window = win;
      try { beforeUnload?.(); } finally { global.window = prev; }
    };
    return { useStore, rosterStore, ls, flush };
  } finally {
    global.window = prevWindow;
  }
}

test('an old install with no roster.json migrates active Sol 6.1 workers from localStorage on first load, keeping other providers and archived history unchanged', () => {
  const home = tmpHome();
  assert.equal(fs.existsSync(path.join(home, 'roster.json')), false);

  const others = [
    { id: 'c', name: 'ClaudeWorker', provider: 'claude', model: 'claude-opus-5-5', command: 'claude --model claude-opus-5-5' },
    { id: 'l', name: 'LunaWorker', provider: 'codex', model: 'gpt-6-luna', command: 'codex --model gpt-6-luna -a never', models: [{ provider: 'codex', model: 'gpt-6.2-astra', maxPercent: 75 }] },
    { id: 'g', name: 'AgyWorker', provider: 'antigravity', model: 'claude-opus-5-5-high', models: [{ provider: 'antigravity', model: 'Gemini 4 Argon (High)', maxPercent: 85 }] }
  ];
  const archivedSol = solAgent({ id: 'arch-1' });

  const { useStore, ls, flush } = bootRendererStore({
    home,
    storedHome: null,
    agents: [solAgent({ id: 'active-1' }), ...others],
    restorable: [],
    archived: [archivedSol]
  });
  flush();

  const state = useStore.getState();
  assert.equal(ls.get('cth.rosterHome'), home);

  const active = state.agents[0];
  assert.equal(active.id, 'active-1');
  assert.equal(active.model, NEW);
  assert.equal(active.command, `codex --model ${NEW} -a never -s workspace-write`);
  assert.deepEqual(active.models, [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: NEW, maxPercent: 80 }]);
  assert.equal(active.effort, 'medium');
  assert.equal(active.note, 'keep me');

  for (let i = 0; i < others.length; i++) {
    const loaded = state.agents[i + 1];
    assert.equal(loaded.id, others[i].id);
    assert.equal(loaded.provider, others[i].provider);
    assert.equal(loaded.model, others[i].model);
    assert.equal(loaded.command, others[i].command);
    assert.deepEqual(loaded.models, others[i].models);
  }

  const [arch] = state.archivedAgents;
  assert.equal(arch.id, 'arch-1');
  assert.equal(arch.model, OLD);
  assert.equal(arch.command, `codex --model ${OLD} -a never -s workspace-write`);
  assert.deepEqual(arch.models[1], { provider: 'codex', model: OLD, maxPercent: 80 });

  const seededOnDisk = JSON.parse(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'));
  assert.equal(seededOnDisk.agents[0].model, NEW);
  assert.equal(seededOnDisk.archived[0].model, OLD);
});

test('an old install with no roster.json migrates restorable Sol 6.1 workers from localStorage, deduplicating Sol ladders in either order and seeding roster.json idempotently', () => {
  const home = tmpHome();
  assert.equal(fs.existsSync(path.join(home, 'roster.json')), false);

  const newThenOld = solAgent({
    id: 'w2',
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
      { provider: 'codex', model: NEW, maxPercent: 90 },
      { provider: 'codex', model: OLD, maxPercent: 70 }
    ]
  });
  const oldThenNew = solAgent({
    id: 'w3',
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
      { provider: 'codex', model: OLD, maxPercent: 70 },
      { provider: 'codex', model: NEW, maxPercent: 90 },
      { provider: 'antigravity', model: 'claude-opus-5-5-high', maxPercent: 85 }
    ]
  });
  const archivedSol = solAgent({ id: 'arch-1' });

  const { useStore, rosterStore, flush } = bootRendererStore({
    home,
    storedHome: home,
    agents: [solAgent({ id: 'active-1' })],
    restorable: [solAgent({ id: 'rest-1' }), newThenOld, oldThenNew],
    archived: [archivedSol]
  });
  flush();

  const state = useStore.getState();
  const [r1, r2, r3] = state.restorableAgents;
  assert.equal(r1.model, NEW);
  assert.equal(r1.command, `codex --model ${NEW} -a never -s workspace-write`);
  assert.ok(!JSON.stringify(r1).includes(OLD));
  assert.deepEqual(r2.models, [
    { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
    { provider: 'codex', model: NEW, maxPercent: 90 }
  ]);
  assert.deepEqual(r3.models, [
    { provider: 'claude', model: 'claude-opus-5-5', maxPercent: 60 },
    { provider: 'codex', model: NEW, maxPercent: 70 },
    { provider: 'antigravity', model: 'claude-opus-5-5-high', maxPercent: 85 }
  ]);

  const seededOnDisk = JSON.parse(fs.readFileSync(path.join(home, 'roster.json'), 'utf8'));
  assert.equal(seededOnDisk.restorable[0].model, NEW);
  assert.deepEqual(seededOnDisk.restorable[1].models, r2.models);
  assert.deepEqual(seededOnDisk.restorable[2].models, r3.models);
  assert.equal(seededOnDisk.archived[0].model, OLD);

  state.reloadRoster({
    agents: [solAgent({ id: 'active-1', note: 'reloaded' })],
    restorable: [solAgent({ id: 'rest-1', note: 'reloaded' })],
    archived: [archivedSol]
  });
  const afterReload = useStore.getState();
  assert.equal(afterReload.agents[0].model, NEW);
  assert.equal(afterReload.agents[0].note, 'reloaded');
  assert.equal(afterReload.restorableAgents[0].model, NEW);
  assert.equal(afterReload.restorableAgents[0].note, 'reloaded');
  assert.equal(afterReload.archivedAgents[0].model, OLD);
  assert.equal(rosterStore.read().restorable[0].model, NEW);
});

test('absent-file localStorage fallback preserves the cross-hive origin guard', () => {
  const homeA = tmpHome();
  const homeB = tmpHome();
  const { useStore, ls } = bootRendererStore({
    home: homeB,
    storedHome: homeA,
    agents: [solAgent({ id: 'foreign-active' })],
    restorable: [solAgent({ id: 'foreign-rest' })],
    archived: [solAgent({ id: 'foreign-arch' })]
  });
  const state = useStore.getState();
  assert.deepEqual(state.agents, []);
  assert.deepEqual(state.restorableAgents, []);
  assert.deepEqual(state.archivedAgents, []);
  assert.equal(fs.existsSync(path.join(homeB, 'roster.json')), false);
  assert.equal(ls.get('cth.rosterHome'), homeB);
});
