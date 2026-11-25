'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts so tests never touch real config
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-engine-config-test-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

test.after(() => rmTree(userData));

const {
  chooseEngine,
  balanceEngines,
  readEngine,
  parseEngineList,
  ENGINES,
  ENGINE_FULL_PERCENT,
  HEADROOM_MARGIN,
  RESET_SOON_MS,
  DEFAULT_ENGINES,
  DEFAULT_ENGINE_THRESHOLDS,
  getEngines,
  getEngineThresholds,
  formatEnginePromptProse
} = loadTs('src/main/engineChoice.ts');

const { HiveManager } = loadTs('src/main/hive.ts');

const all = () => true;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const win = (percent, lengthMs, resetsInMs) => ({ percent, lengthMs, resetsAtMs: NOW + resetsInMs });
const cand = (engine, label = engine) => ({ engine, label });

function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0, 'the hive protocol must be on argv');
  return inj.args[i + 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Config values override defaults
// ─────────────────────────────────────────────────────────────────────────────

test('getEngines: config values override default engine model and properties', () => {
  assert.equal(typeof getEngines, 'function', 'getEngines must be exported as a function');

  const customCfg = {
    engines: {
      agy: { id: 'agy', provider: 'antigravity', model: 'gemini-3.8-flash-custom', description: 'Custom Flash' }
    }
  };

  const resolved = getEngines(customCfg);
  assert.equal(resolved.agy.model, 'gemini-3.8-flash-custom', 'Custom agy model in config must override default');
  assert.equal(resolved.agy.description, 'Custom Flash', 'Custom description in config must override default');
  assert.equal(resolved['agy-claude'].model, 'claude-opus-5-5-high', 'Unchanged engines must preserve defaults');
});

test('getEngineThresholds: config values override default thresholds', () => {
  assert.equal(typeof getEngineThresholds, 'function', 'getEngineThresholds must be exported as a function');

  const customCfg = {
    engineThresholds: {
      fullPercent: 90,
      headroomMargin: 15,
      resetSoonMs: 10 * 60_000
    }
  };

  const thresholds = getEngineThresholds(customCfg);
  assert.equal(thresholds.fullPercent, 90, 'Custom fullPercent must override default 85');
  assert.equal(thresholds.headroomMargin, 15, 'Custom headroomMargin must override default 30');
  assert.equal(thresholds.resetSoonMs, 600_000, 'Custom resetSoonMs must override default 900_000');
});

test('chooseEngine: respects custom fullPercent and engines table from config', () => {
  // agy is at 88% usage. Under default 85%, agy is skipped.
  // With custom fullPercent: 90, agy has room and is chosen.
  // With custom model 'gemini-3.8-flash-custom', the chosen engine carries the custom model.
  const customEngines = {
    agy: { id: 'agy', provider: 'antigravity', model: 'gemini-3.8-flash-custom', description: 'Custom Flash' },
    'agy-claude': { id: 'agy-claude', provider: 'antigravity', model: 'claude-opus-5-5-high' },
    codex: { id: 'codex', provider: 'codex' },
    claude: { id: 'claude', provider: 'claude' }
  };

  const choiceDefault = chooseEngine(['agy', 'codex'], { agy: 88, codex: 20 }, all);
  assert.equal(choiceDefault.engine.id, 'codex', 'Under default fullPercent (85%), 88% is full and skipped');

  // Passing custom thresholds and engines table (options object or positional)
  const choiceCustom = chooseEngine(
    ['agy', 'codex'],
    { agy: 88, codex: 20 },
    all,
    () => false,
    { thresholds: { fullPercent: 90 }, engines: customEngines }
  );

  assert.equal(choiceCustom.engine.id, 'agy', 'Under custom fullPercent (90%), 88% has room');
  assert.equal(choiceCustom.engine.model, 'gemini-3.8-flash-custom', 'Chosen engine must carry the configured model');
});

test('balanceEngines: respects custom headroomMargin from config', () => {
  // Candidate claude: 70%, codex: 50% (difference = 20 points).
  // Under default margin (30), codex does NOT overtake claude.
  const defaultBalance = balanceEngines([cand('claude'), cand('codex')], { claude: { percent: 70 }, codex: { percent: 50 } }, NOW);
  assert.equal(defaultBalance.index, 0, 'Under default margin (30), 20 point lead does not switch candidates');

  // With custom margin (15), codex takes over claude (20 >= 15).
  const customBalance = balanceEngines(
    [cand('claude'), cand('codex')],
    { claude: { percent: 70 }, codex: { percent: 50 } },
    NOW,
    { thresholds: { headroomMargin: 15 } }
  );
  assert.equal(customBalance.index, 1, 'Under custom margin (15), 20 point lead takes over');
  assert.match(customBalance.reason, /15%+/);
});

test('readEngine: respects custom resetSoonMs from config', () => {
  // A window resetting in 20 minutes (20 * 60_000 ms).
  // Under default resetSoonMs (15 min = 900_000 ms), 20 min does NOT read 0%.
  const defaultReading = readEngine([{ percent: 95, resetsAtMs: NOW + 20 * 60_000, lengthMs: HOUR }], NOW);
  assert.equal(defaultReading.percent, 95, 'Under default 15 min resetSoonMs, 20 min reset does not read 0%');

  // With custom resetSoonMs (25 min = 1_500_000 ms), 20 min counts as reset soon and reads 0%.
  const customReading = readEngine(
    [{ percent: 95, resetsAtMs: NOW + 20 * 60_000, lengthMs: HOUR }],
    NOW,
    { thresholds: { resetSoonMs: 25 * 60_000 } }
  );
  assert.equal(customReading.percent, 0, 'Under custom 25 min resetSoonMs, 20 min reset reads 0%');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Defaults apply when key is absent
// ─────────────────────────────────────────────────────────────────────────────

test('getEngines falls back to DEFAULT_ENGINES when config key is absent or empty', () => {
  assert.equal(typeof getEngines, 'function', 'getEngines must be exported as a function');

  const fromUndefined = getEngines();
  const fromEmpty = getEngines({});

  assert.ok(fromUndefined.agy, 'agy engine must exist in defaults');
  assert.equal(fromUndefined.agy.model, 'gemini-3.8-flash-high', 'default agy model must be gemini-3.8-flash-high');
  assert.equal(fromUndefined['agy-claude'].model, 'claude-opus-5-5-high', 'default agy-claude model must be claude-opus-5-5-high');
  assert.equal(fromUndefined['agy-argon'].model, 'gemini-4-argon-medium', 'default agy-argon model must be gemini-4-argon-medium');
  assert.equal(fromUndefined.codex.provider, 'codex');
  assert.equal(fromUndefined.claude.provider, 'claude');

  assert.deepEqual(fromEmpty, fromUndefined, 'empty config must resolve to same defaults as undefined');
});

test('getEngineThresholds falls back to DEFAULT_ENGINE_THRESHOLDS when key is absent or empty', () => {
  assert.equal(typeof getEngineThresholds, 'function', 'getEngineThresholds must be exported as a function');

  const fromUndefined = getEngineThresholds();
  const fromEmpty = getEngineThresholds({});

  assert.equal(fromUndefined.fullPercent, 85, 'default fullPercent must be 85');
  assert.equal(fromUndefined.headroomMargin, 30, 'default headroomMargin must be 30');
  assert.equal(fromUndefined.resetSoonMs, 15 * 60_000, 'default resetSoonMs must be 900_000 ms');

  assert.deepEqual(fromEmpty, fromUndefined, 'empty config must resolve to same default thresholds');
});

test('partial config preserves unconfigured engine keys and thresholds', () => {
  // Only overriding fullPercent leaves headroomMargin and resetSoonMs intact
  const partialThresholds = getEngineThresholds({ engineThresholds: { fullPercent: 75 } });
  assert.equal(partialThresholds.fullPercent, 75);
  assert.equal(partialThresholds.headroomMargin, 30);
  assert.equal(partialThresholds.resetSoonMs, 900_000);

  // Only overriding agy leaves all other engines intact
  const partialEngines = getEngines({ engines: { agy: { model: 'custom-flash' } } });
  assert.equal(partialEngines.agy.model, 'custom-flash');
  assert.equal(partialEngines.agy.provider, 'antigravity');
  assert.equal(partialEngines['agy-claude'].model, 'claude-opus-5-5-high');
  assert.equal(partialEngines.codex.provider, 'codex');
  assert.equal(partialEngines.claude.provider, 'claude');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Unknown engine ID is still refused
// ─────────────────────────────────────────────────────────────────────────────

test('parseEngineList refuses unknown engine IDs and preserves allowlist aliases', () => {
  assert.deepEqual(
    parseEngineList(['agy', 'gpt-5', 'ANTIGRAVITY', 'unknown_bot', 'codex', 'claude', 'agy']),
    ['agy', 'codex', 'claude'],
    'parseEngineList must refuse unknown engine ids and deduplicate aliases'
  );
  assert.deepEqual(parseEngineList(['unsupported', 'custom-engine']), []);
});

test('getEngines ignores or refuses unknown engine keys in config', () => {
  const invalidCfg = {
    engines: {
      agy: { model: 'gemini-3.8-flash-high' },
      'malicious-cli': { provider: 'unknown', model: 'evil' }
    }
  };

  const resolved = getEngines(invalidCfg);
  assert.equal(resolved['malicious-cli'], undefined, 'Unknown engine key in config must be ignored or refused');
  assert.ok(resolved.agy && resolved['agy-claude'] && resolved.codex && resolved.claude);
});

test('chooseEngine returns null when requested engines contain only unknown IDs', () => {
  const parsed = parseEngineList(['invalid-engine', 'nonexistent']);
  assert.equal(parsed.length, 0);
  const choice = chooseEngine(parsed, {}, all);
  assert.equal(choice, null, 'chooseEngine with no valid engines must return null');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Prompt text matches config
// ─────────────────────────────────────────────────────────────────────────────

test('formatEnginePromptProse generates spawn queue engine description and default list from engine data', () => {
  assert.equal(typeof formatEnginePromptProse, 'function', 'formatEnginePromptProse must be exported as a function');

  const defaultProse = formatEnginePromptProse();
  assert.match(defaultProse, /"agy" \(Gemini Flash\)/, 'default prose must describe agy');
  assert.match(defaultProse, /"agy-claude" \(Claude Opus 5\.5 on agy's separate quota\)/, 'default prose must describe agy-claude');
  assert.match(defaultProse, /"claude"[\s\S]*"codex"[\s\S]*and "agy"/, 'default prose must name claude first and agy last');
  assert.match(defaultProse, /\["claude","codex","agy-claude","agy"\]/, 'default prose must include array');

  // Custom engine descriptions in config
  const customEngines = {
    agy: { id: 'agy', provider: 'antigravity', model: 'gemini-3.8-flash-fast', description: 'Gemini 3.8 Flash' },
    'agy-claude': { id: 'agy-claude', provider: 'antigravity', model: 'claude-opus-5-5-high', description: 'Claude Opus 5.5 Fast' },
    codex: { id: 'codex', provider: 'codex' },
    claude: { id: 'claude', provider: 'claude' }
  };

  const customProse = formatEnginePromptProse(customEngines);
  assert.match(customProse, /"agy" \(Gemini 3\.8 Flash\)/, 'custom prose must reflect custom agy description');
  assert.match(customProse, /"agy-claude" \(Claude Opus 5\.5 Fast\)/, 'custom prose must reflect custom agy-claude description');
});

test('HiveManager identityPrompt generates spawn queue prompt matching configured engines', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-prompt-test-'));
  t.after(() => rmTree(home));

  const hive = new HiveManager(() => home);
  assert.equal(typeof hive.setEngines, 'function', 'hive.setEngines must be available on HiveManager');

  const customEngines = {
    agy: { id: 'agy', provider: 'antigravity', model: 'gemini-2.5-pro', description: 'Gemini 2.5 Pro' },
    'agy-claude': { id: 'agy-claude', provider: 'antigravity', model: 'claude-opus-5-5', description: 'Opus 5.5' },
    codex: { id: 'codex', provider: 'codex' },
    claude: { id: 'claude', provider: 'claude' }
  };

  hive.setEngines(customEngines);
  hive.setOrchestratorMaySpawn(true);

  const inj = await hive.ensureAgent(
    { id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true }
  );

  const prompt = promptOf(inj);
  assert.match(prompt, /SPAWNING A WORKER:/, 'Prompt must include SPAWNING A WORKER section');
  assert.match(prompt, /"agy" \(Gemini 2\.5 Pro\)/, 'Spawn queue prompt must reflect configured agy description');
  assert.match(prompt, /"agy-claude" \(Opus 5\.5\)/, 'Spawn queue prompt must reflect configured agy-claude description');
});
