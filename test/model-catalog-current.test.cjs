'use strict';

/**
 * The model catalog offers only current models, a legacy name anywhere a model is
 * saved or named resolves to its successor (or is reported), and every model carries
 * a recorded speciality the pickers show.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const catalog = require('../src/shared/modelCatalog.json');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-catalog-userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userDataDir } } };

const {
  modelFamily,
  migrateModel,
  isRetiredModel,
  isCatalogModel,
  resolveNamedModel,
  modelCatalogWarnings,
  modelSpeciality,
  specialityText
} = loadTs('src/shared/modelCatalogCheck.ts');
const { migrateAgentModels, migrateModelList, migrateModelCommand } = loadTs('src/shared/modelMigration.ts');
const { loadRuntimeModelCatalog } = loadTs('src/main/runtimeModelCatalog.ts');
const { modelsForProvider } = loadTs('src/renderer/src/store/config.ts');
const { AGENT_PROVIDER_PRESETS } = loadTs('src/shared/agentProvider.ts');

const CHECKED = ['claude', 'codex', 'antigravity', 'grok'];

test('the retired list records when it was checked against the vendor pages', () => {
  assert.match(catalog.retiredChecked, /^\d{4}-\d{2}-\d{2}$/);
  for (const p of CHECKED) assert.ok(catalog.retired[p] && typeof catalog.retired[p] === 'object', p);
});

test('no picker offers a retired model', () => {
  for (const p of CHECKED) {
    for (const m of catalog.providers[p]) {
      if (m.id) assert.equal(isRetiredModel(p, m.id), false, `${p}/${m.id} is retired but still offered`);
    }
  }
});

test('every retired name resolves to a model the picker offers', () => {
  for (const p of CHECKED) {
    // agy keys are families; every agy row carries an effort.
    for (const key of Object.keys(catalog.retired[p])) {
      const legacy = p === 'antigravity' ? `${key}-high` : key;
      const next = migrateModel(p, legacy);
      assert.notEqual(next, legacy, `${p}/${legacy} has no successor`);
      assert.ok(isCatalogModel(p, next), `${p}/${legacy} -> ${next}, which is not in the catalog`);
    }
  }
});

test('modelFamily drops the effort, the 1M window and agy display-name form', () => {
  assert.equal(modelFamily('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(modelFamily('claude-opus-5-5-high'), 'claude-opus-5-5');
  assert.equal(modelFamily('Gemini 4 Argon (Medium)'), 'gemini-4-argon');
  assert.equal(modelFamily('gemini-4-neon-xhigh'), 'gemini-4-neon');
  assert.equal(modelFamily('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash');
  assert.equal(modelFamily('gpt-6.2-sol'), 'gpt-6.2-sol');
});

test('legacy names resolve to their current successor', () => {
  assert.equal(migrateModel('claude', 'claude-sonnet-5'), 'claude-sonnet-5-5');
  assert.equal(migrateModel('claude', 'claude-opus-4-8[1m]'), 'claude-opus-5-5[1m]');
  assert.equal(migrateModel('claude', 'claude-haiku-4-5-20251001'), 'claude-haiku-5-5');
  assert.equal(migrateModel('claude', 'claude-fable-5-1'), 'claude-fable-5-2');
  assert.equal(migrateModel('codex', 'gpt-5.5'), 'gpt-6.2-sol');
  assert.equal(migrateModel('codex', 'gpt-6.1-sol'), 'gpt-6.2-sol');
  assert.equal(migrateModel('codex', 'gpt-5.6-luna'), 'gpt-6-luna');
  // agy keeps the effort and the form it was given.
  assert.equal(migrateModel('antigravity', 'Gemini 3.7 Flash (Medium)'), 'Gemini 3.8 Flash (Medium)');
  assert.equal(migrateModel('antigravity', 'gemini-3.5-flash-low'), 'gemini-3.8-flash-low');
  assert.equal(migrateModel('grok', 'grok-4.5'), 'grok-4.7');
});

test('current, unknown and default models pass through untouched', () => {
  assert.equal(migrateModel('claude', 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(migrateModel('antigravity', 'Gemini 3.8 Flash (High)'), 'Gemini 3.8 Flash (High)');
  assert.equal(migrateModel('codex', 'gpt-7-nova'), 'gpt-7-nova');
  assert.equal(migrateModel('claude', undefined), undefined);
  // Retirement is per provider: a Cursor slug that looks like a retired Codex one is Cursor's.
  assert.equal(migrateModel('cursor', 'gpt-5.6-luna-high'), 'gpt-5.6-luna-high');
});

test('a spawn that names a legacy model runs its successor and says so; an unknown one warns', () => {
  const legacy = resolveNamedModel('claude', 'claude-sonnet-5');
  assert.equal(legacy.model, 'claude-sonnet-5-5');
  assert.match(legacy.note, /claude-sonnet-5.*retired.*claude-sonnet-5-5/);
  const unknown = resolveNamedModel('codex', 'gpt-7-nova');
  assert.equal(unknown.model, 'gpt-7-nova');
  assert.match(unknown.note, /not in the model catalog/);
  assert.deepEqual(resolveNamedModel('claude', 'claude-opus-5-5'), { model: 'claude-opus-5-5' });
  assert.deepEqual(resolveNamedModel('claude', undefined), { model: undefined });
});

test('saved rosters, ladders and commands move off retired models on every provider', () => {
  const agent = migrateAgentModels({
    id: 'x', provider: 'claude', model: 'claude-sonnet-5',
    models: [{ provider: 'claude', model: 'claude-opus-4-8' }, { provider: 'antigravity', model: 'Gemini 3.5 Flash (High)' }, { provider: 'claude', model: 'claude-opus-5-5' }]
  });
  assert.equal(agent.model, 'claude-sonnet-5-5');
  assert.deepEqual(agent.models, [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }]);
  const current = { id: 'y', provider: 'claude', model: 'claude-opus-5-5' };
  assert.equal(migrateAgentModels(current), current, 'nothing to move returns the same object');
  assert.equal(migrateModelCommand('codex --model gpt-5.6-sol -a never'), 'codex --model gpt-6.2-sol -a never');
  const list = [{ provider: 'codex', model: 'gpt-6.2-sol' }];
  assert.equal(migrateModelList(list), list);
});

test('config warns when defaultModel, godModel or a tier entry is not in the catalog', () => {
  const warnings = modelCatalogWarnings({
    defaultModel: 'claude-sonnet-5',
    godProvider: 'claude',
    godModel: 'claude-opus-5-5',
    modelTiers: {
      strong: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'antigravity', model: 'gemini-4-argon-medium' }],
      medium: [{ provider: 'codex', model: 'gpt-7-nova' }],
      light: [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' }, { provider: 'codex' }]
    }
  });
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.match(warnings[0], /defaultModel "claude-sonnet-5".*retired.*claude-sonnet-5-5/);
  assert.match(warnings[1], /medium tier.*codex\/gpt-7-nova.*not in the model catalog/);
  assert.deepEqual(modelCatalogWarnings({ godProvider: 'codex', godModel: 'gpt-6.2-sol' }), []);
  assert.match(modelCatalogWarnings({ godProvider: 'claude', godModel: 'claude-opus-4-8' })[0], /godModel/);
});

test('reading config moves the Boss and the tiers off retired models but leaves defaultModel for the human', () => {
  const { readConfig } = loadTs('src/main/config.ts');
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    defaultModel: 'claude-sonnet-5',
    godProvider: 'claude',
    godModel: 'claude-opus-4-8[1m]',
    modelTiers: { strong: [{ provider: 'codex', model: 'gpt-6-astra' }], medium: [], light: [{ provider: 'antigravity', model: 'Gemini 3.7 Flash (Low)' }] }
  }));
  const cfg = readConfig();
  assert.equal(cfg.defaultModel, 'claude-sonnet-5');
  assert.equal(cfg.godModel, 'claude-opus-5-5[1m]');
  assert.deepEqual(cfg.modelTiers.strong, [{ provider: 'codex', model: 'gpt-6.2-astra' }]);
  assert.deepEqual(cfg.modelTiers.light, [{ provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' }]);
});

test('the runtime catalog never re-adds a retired model from the Codex cache or the agy listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-catalog-'));
  const codexModelsPath = path.join(dir, 'models_cache.json');
  fs.writeFileSync(codexModelsPath, JSON.stringify({ models: [
    { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' },
    { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list' }
  ] }));
  const agy = ['gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.7-flash-high\tGemini 3.7 Flash (High)'].join('\n');
  const merged = loadRuntimeModelCatalog({ baked: catalog, codexModelsPath, log: () => {} }, agy);
  const codex = merged.providers.codex.map((m) => m.id);
  assert.ok(!codex.includes('gpt-5.6-sol') && !codex.includes('gpt-6-sol'), codex.join(','));
  const agyIds = merged.providers.antigravity.map((m) => m.id);
  assert.ok(!agyIds.includes('gemini-3.7-flash-high'), agyIds.join(','));
});

test('every offered model on a checked provider has a speciality with a source', () => {
  for (const p of CHECKED) {
    for (const m of catalog.providers[p]) {
      if (!m.id || /^gpt-oss|orchestrator/i.test(m.id)) continue;
      const s = modelSpeciality(p, m.id);
      assert.ok(s, `${p}/${m.id} has no speciality`);
      assert.ok(s.strengths && s.source, `${p}/${m.id} speciality needs strengths and a source`);
    }
  }
  const argon = modelSpeciality('antigravity', 'Gemini 4 Argon (High)');
  assert.match(argon.weaknesses, /identifiers/);
  assert.match(modelSpeciality('codex', 'gpt-6-luna').weaknesses, /video/i);
});

test('the pickers carry the speciality as a tooltip', () => {
  const opus = modelsForProvider('claude').find((m) => m.id === 'claude-opus-5-5');
  assert.equal(opus.title, specialityText('claude', 'claude-opus-5-5'));
  assert.match(opus.title, /^Good at: .+\n(Weak at: .+\n)?Source: .+$/);
  const def = modelsForProvider('codex').find((m) => m.id === undefined);
  assert.equal(def.title, undefined);
});

test('no code default, prompt or example names a retired model', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(f);
    }
  };
  walk(root);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [];
  for (const p of ['claude', 'codex', 'grok']) {
    for (const id of Object.keys(catalog.retired[p])) patterns.push(new RegExp(`(?<![\\w./-])${esc(id)}(?![\\w.-])`));
  }
  for (const fam of Object.keys(catalog.retired.antigravity)) {
    const words = fam.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    patterns.push(new RegExp(esc(words)), new RegExp(`(?<![\\w./-])${esc(fam)}-`));
  }
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const re of patterns) if (re.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('every built-in orchestrator recommendation on a checked provider is in the catalog', () => {
  for (const preset of AGENT_PROVIDER_PRESETS) {
    if (!CHECKED.includes(preset.id) || !preset.recommendedOrchestratorModel) continue;
    assert.ok(isCatalogModel(preset.id, preset.recommendedOrchestratorModel), `${preset.id}: ${preset.recommendedOrchestratorModel}`);
  }
});

test('a fresh install defaults every agent to Opus 5.5', () => {
  const { readConfig } = loadTs('src/main/config.ts');
  fs.rmSync(path.join(userDataDir, 'config.json'), { force: true });
  assert.equal(readConfig().defaultModel, 'claude-opus-5-5');
});
