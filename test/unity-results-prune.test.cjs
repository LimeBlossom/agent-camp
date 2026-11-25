'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { pruneUnityResults, unityResultsDirs, UNITY_RESULTS_MAX_AGE_MS } = loadTs('src/main/unityResultsPrune.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14);

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'))); }
function touch(p, ageMs, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = (NOW - ageMs) / 1000;
  fs.utimesSync(p, t, t);
}
function age(p, ageMs) { const t = (NOW - ageMs) / 1000; fs.utimesSync(p, t, t); }

test('deletes runs whose newest file is past the cutoff, keeps the rest', () => {
  const results = path.join(tmp(), 'a', 'unity-results');
  touch(path.join(results, 'old', 'unity.log'), 10 * DAY, '12345');
  touch(path.join(results, 'old', 'out', 'shot.png'), 9 * DAY, 'abc');
  age(path.join(results, 'old', 'out'), 9 * DAY); age(path.join(results, 'old'), 9 * DAY);
  touch(path.join(results, 'mixed', 'unity.log'), 30 * DAY);
  touch(path.join(results, 'mixed', 'late.txt'), 2 * DAY);
  age(path.join(results, 'mixed'), 30 * DAY);
  touch(path.join(results, 'fresh', 'result.json'), 1 * DAY);

  const r = pruneUnityResults([results], NOW);
  assert.deepEqual(r.deleted.map((d) => path.basename(d.path)), ['old']);
  assert.equal(r.freedBytes, 8);
  assert.equal(r.kept, 2);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(fs.readdirSync(results).sort(), ['fresh', 'mixed']);
});

test('a run just inside the window stays; just outside goes', () => {
  const results = path.join(tmp(), 'unity-results');
  touch(path.join(results, 'edge-in', 'f'), UNITY_RESULTS_MAX_AGE_MS - 60_000);
  age(path.join(results, 'edge-in'), UNITY_RESULTS_MAX_AGE_MS - 60_000);
  touch(path.join(results, 'edge-out', 'f'), UNITY_RESULTS_MAX_AGE_MS + 60_000);
  age(path.join(results, 'edge-out'), UNITY_RESULTS_MAX_AGE_MS + 60_000);
  const r = pruneUnityResults([results], NOW);
  assert.deepEqual(r.deleted.map((d) => path.basename(d.path)), ['edge-out']);
});

test('dry run reports without deleting', () => {
  const results = path.join(tmp(), 'unity-results');
  touch(path.join(results, 'old', 'f'), 20 * DAY);
  age(path.join(results, 'old'), 20 * DAY);
  const r = pruneUnityResults([results], NOW, UNITY_RESULTS_MAX_AGE_MS, true);
  assert.equal(r.deleted.length, 1);
  assert.ok(fs.existsSync(path.join(results, 'old', 'f')));
});

test('refuses a dir not named unity-results and skips symlinked runs', () => {
  const root = tmp();
  const other = path.join(root, 'project');
  touch(path.join(other, 'old', 'f'), 20 * DAY);
  age(path.join(other, 'old'), 20 * DAY);
  const results = path.join(root, 'unity-results');
  fs.mkdirSync(results);
  fs.symlinkSync(path.join(other, 'old'), path.join(results, 'link'));
  const r = pruneUnityResults([other, results], NOW);
  assert.equal(r.deleted.length, 0);
  assert.equal(r.errors.length, 1);
  assert.ok(fs.existsSync(path.join(other, 'old', 'f')));
  assert.ok(fs.lstatSync(path.join(results, 'link')).isSymbolicLink());
});

test('finds results dirs under the scratch root and the hive agents fallback', () => {
  const root = tmp();
  const scratch = path.join(root, 'scratch');
  const hive = path.join(root, 'hive');
  fs.mkdirSync(path.join(scratch, 'a1', 'unity-results'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'a2', 'other'), { recursive: true });
  fs.mkdirSync(path.join(hive, 'agents', 'a1', 'unity-results'), { recursive: true });
  const dirs = unityResultsDirs(hive, scratch).sort();
  assert.deepEqual(dirs, [path.join(hive, 'agents', 'a1', 'unity-results'), path.join(scratch, 'a1', 'unity-results')].sort());
  assert.deepEqual(unityResultsDirs(null, path.join(root, 'missing')), []);
});
