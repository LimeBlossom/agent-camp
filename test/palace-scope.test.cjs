'use strict';

/**
 * One-shot boot migration onto the memory-only palace.
 *
 * The old palace holds 2.7 GB of transcripts, reports and bundled js mined from
 * whole agent folders. Mining only memory files from now on does not remove
 * that bulk, so the palace must be rebuilt. Camp cannot be quit while an agent
 * runs a script (every session dies with it), so the rotation happens at boot:
 * a palace without the current scope marker is renamed aside with a manifest,
 * and a fresh palace carrying the marker takes its place.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { ensurePalaceScope, PALACE_SCOPE, SCOPE_MARKER } = loadTs('src/main/palaceScope.ts');

const NOW = new Date(Date.UTC(2026, 10, 24, 3, 4, 5));
const OLD = 'palace-old-20261124';

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-palace-scope-'));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}

function seedPalace(h, marker) {
  const p = path.join(h, 'palace');
  fs.mkdirSync(path.join(p, '0fba457c-8187-471f-a6aa-6321ad8ac52d'), { recursive: true });
  fs.writeFileSync(path.join(p, 'chroma.sqlite3'), 'sqlite bytes');
  fs.writeFileSync(path.join(p, '0fba457c-8187-471f-a6aa-6321ad8ac52d', 'data_level0.bin'), 'vectors');
  if (marker !== undefined) fs.writeFileSync(path.join(p, SCOPE_MARKER), marker);
  return p;
}

/** Every file under dir with its contents, so "untouched" is a byte check. */
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const f = path.join(e.parentPath, e.name);
      return [path.relative(dir, f), fs.readFileSync(f, 'utf8')];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

const notLive = () => false;

test('the scope is agent-notes-v1 and lives in palace/.scope', () => {
  assert.equal(PALACE_SCOPE, 'agent-notes-v1');
  assert.equal(SCOPE_MARKER, '.scope');
});

test('marker present: no-op, palace untouched, nothing renamed', (t) => {
  const h = home(t);
  const p = seedPalace(h, PALACE_SCOPE);
  const before = snapshot(p);
  let asked = 0;

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: () => { asked += 1; return true; } });

  assert.equal(r.action, 'current');
  assert.deepEqual(snapshot(p), before);
  assert.deepEqual(fs.readdirSync(h).sort(), ['palace']);
  assert.equal(asked, 0, 'a current palace never needs the process check');
});

test('marker absent: palace renamed aside byte for byte, fresh palace carries the marker', (t) => {
  const h = home(t);
  const p = seedPalace(h);
  const before = snapshot(p);

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });

  assert.equal(r.action, 'rotated');
  assert.equal(r.to, path.join(h, OLD));
  assert.deepEqual(snapshot(path.join(h, OLD)), before);
  assert.deepEqual(snapshot(p), [[SCOPE_MARKER, PALACE_SCOPE]]);
});

test('a rotation leaves a manifest whose before and after lists match', (t) => {
  const h = home(t);
  seedPalace(h);

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });

  assert.ok(r.manifestDir && r.manifestDir.startsWith(path.join(h, 'palace-rotations') + path.sep));
  const read = (n) => fs.readFileSync(path.join(r.manifestDir, n), 'utf8');
  assert.equal(read('before.sha'), read('after.sha'));
  assert.equal(read('before.size'), read('after.size'));
  assert.match(read('before.sha'), /^[0-9a-f]{64}  \.\/chroma\.sqlite3$/m);
  assert.equal(read('before.sha').trim().split('\n').length, 2);
  assert.equal(Number(read('before.size')), 'sqlite bytes'.length + 'vectors'.length);
});

test('rotation is idempotent: the second boot is a no-op', (t) => {
  const h = home(t);
  seedPalace(h);
  ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });
  const after = fs.readdirSync(h).sort();

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });

  assert.equal(r.action, 'current');
  assert.deepEqual(fs.readdirSync(h).sort(), after);
});

test('rotate refused while a mempalace process is live: palace untouched, no marker', (t) => {
  const h = home(t);
  const p = seedPalace(h);
  const before = snapshot(p);

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: () => true });

  assert.equal(r.action, 'refused');
  assert.deepEqual(snapshot(p), before);
  assert.deepEqual(fs.readdirSync(h).sort(), ['palace']);
});

test('a different scope marker is rotated like a missing one', (t) => {
  const h = home(t);
  seedPalace(h, 'whole-folder');

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });

  assert.equal(r.action, 'rotated');
  assert.equal(fs.readFileSync(path.join(h, OLD, SCOPE_MARKER), 'utf8'), 'whole-folder');
  assert.equal(fs.readFileSync(path.join(h, 'palace', SCOPE_MARKER), 'utf8'), PALACE_SCOPE);
});

test('an existing palace-old of the same day is left alone; the rotation takes the next free name', (t) => {
  const h = home(t);
  seedPalace(h);
  fs.mkdirSync(path.join(h, OLD));
  fs.writeFileSync(path.join(h, OLD, 'keep.txt'), 'earlier rotation');

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: notLive });

  assert.equal(r.action, 'rotated');
  assert.equal(r.to, path.join(h, `${OLD}-2`));
  assert.deepEqual(snapshot(path.join(h, OLD)), [['keep.txt', 'earlier rotation']]);
});

test('no palace yet: a fresh one is created with the marker', (t) => {
  const h = home(t);

  const r = ensurePalaceScope({ home: h, now: NOW, mempalaceLive: () => true });

  assert.equal(r.action, 'fresh');
  assert.deepEqual(snapshot(path.join(h, 'palace')), [[SCOPE_MARKER, PALACE_SCOPE]]);
});
