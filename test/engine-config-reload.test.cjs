'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { getEngines, getEngineThresholds, parseEngineList, chooseEngine, limitSwitchPick, readEngine } = loadTs('src/main/engineChoice.ts');

test('Boss prompt and bundled protocol reread engine config between spawns', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-engine-reload-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  let engines = { agy: { model: 'first-model', description: 'First engine' } };
  hive.setEngines(() => engines);
  hive.setOrchestratorMaySpawn(true);
  for (const [id, label] of [['boss-1', 'First engine'], ['boss-2', 'Second engine']]) {
    const injection = await hive.ensureAgent({ id, name: 'Boss', provider: 'claude', cwd: home, isGod: true });
    const prompt = injection.args[injection.args.indexOf('--append-system-prompt') + 1];
    assert.ok(prompt.includes(`"agy" (${label})`));
    assert.ok(fs.readFileSync(path.join(hive.root(), 'PROTOCOL-BOSS.md'), 'utf8').includes(`"agy" (${label})`));
    engines = { agy: { model: 'second-model', description: 'Second engine' } };
  }
});

test('engine config cannot replace IDs or admit prototype names and invalid providers', () => {
  assert.deepEqual(parseEngineList(['__proto__', 'constructor', 'toString', 'agy-argon']), []);
  const table = getEngines({ engines: { agy: { id: 'rogue', provider: 'rogue' } } });
  assert.equal(table.agy.id, 'agy');
  assert.equal(table.agy.provider, 'antigravity');
  assert.equal(chooseEngine(['rogue', 'constructor'], {}, () => true), null);
});

test('invalid thresholds fall back while zero margin and reset discount remain valid', () => {
  assert.deepEqual(getEngineThresholds({ engineThresholds: { fullPercent: 101, headroomMargin: -1, resetSoonMs: NaN } }), getEngineThresholds());
  assert.deepEqual(getEngineThresholds({ engineThresholds: { fullPercent: 0, headroomMargin: 0, resetSoonMs: 0 } }), { fullPercent: 85, headroomMargin: 0, resetSoonMs: 0 });
});

test('configured full cutoff also governs full-window reset and limit switching', () => {
  const reading = readEngine([{ percent: 88, resetsAtMs: 10_000_000 }], 0, { thresholds: { fullPercent: 90 } });
  assert.equal(reading.roomAtMs, undefined);
  const cands = [{ engine: 'agy', label: 'agy' }, { engine: 'codex', label: 'codex' }];
  const readings = { agy: { percent: 88 }, codex: { percent: 80 } };
  assert.equal(limitSwitchPick(cands, readings, 0).index, 1);
  assert.equal(limitSwitchPick(cands, readings, 0, { thresholds: { fullPercent: 90 } }).index, 0);
});
