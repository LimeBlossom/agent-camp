'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { scanStrayFiles, formatStrayFiles, readStrayBaseline } = loadTs('src/main/strayFiles.ts');

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strays-'));
  made.push(root);
  return root;
}

const deps = {
  git: (cwd, args) => {
    try { return Promise.resolve(execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); }
    catch { return Promise.resolve(null); }
  },
  sizeOf: () => Promise.resolve(2_000_000_000)
};

test('first scan seeds the baseline and reports nothing; later scans report only new entries', async () => {
  const root = tmp();
  const watched = path.join(root, 'Programming');
  fs.mkdirSync(path.join(watched, 'HumanProject'), { recursive: true });
  fs.writeFileSync(path.join(watched, 'notes.txt'), 'x');
  const baseline = path.join(root, 'hive', 'stray-baseline.json');

  assert.deepEqual(await scanStrayFiles([watched], baseline, ['Maple'], deps), []);
  assert.deepEqual(readStrayBaseline(baseline), { [watched]: ['HumanProject', 'notes.txt'] });

  fs.mkdirSync(path.join(watched, 'maple-probe'));
  fs.writeFileSync(path.join(watched, 'diskcheck.txt'), 'x'.repeat(1234));
  fs.mkdirSync(path.join(watched, '.hive-scratch'));
  const repo = path.join(watched, 'GameCopy');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'birch/try-thing']);

  const list = await scanStrayFiles([watched], baseline, ['Maple', 'Birch'], deps);
  const got = list.map((e) => `${path.basename(e.path)} ${e.isDir ? 'dir' : 'file'} ${e.sizeBytes} ${e.owner}`).sort();
  assert.deepEqual(got, [
    'GameCopy dir 2000000000 birch',
    'diskcheck.txt file 1234 null',
    'maple-probe dir 2000000000 maple'
  ]);
  assert.deepEqual(readStrayBaseline(baseline), { [watched]: ['HumanProject', 'notes.txt'] }, 'a later scan never rewrites the baseline');
  assert.ok(fs.existsSync(path.join(watched, 'maple-probe')), 'report only');
});

test('a folder added to the watch list later gets its own baseline without dropping the others', async () => {
  const root = tmp();
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'old.txt'), '');
  const baseline = path.join(root, 'baseline.json');
  await scanStrayFiles([a], baseline, [], deps);
  fs.writeFileSync(path.join(a, 'new.txt'), '');
  const list = await scanStrayFiles([a, b], baseline, [], deps);
  assert.deepEqual(list.map((e) => path.basename(e.path)), ['new.txt']);
  assert.deepEqual(readStrayBaseline(baseline), { [a]: [], [b]: ['old.txt'] });
});

test('formatStrayFiles is null when empty and names size, mtime and owner', () => {
  assert.equal(formatStrayFiles([], '/hive/stray-baseline.json'), null);
  const text = formatStrayFiles([
    { path: '/P/x', isDir: true, sizeBytes: 3e9, mtimeMs: Date.UTC(2026, 9, 17), owner: 'maple' },
    { path: '/P/y.txt', isDir: false, sizeBytes: 5e5, mtimeMs: Date.UTC(2026, 9, 16), owner: null }
  ], '/hive/stray-baseline.json');
  assert.match(text, /^Stray files \(2; report only, nothing was moved\)/);
  assert.match(text, /`\/hive\/stray-baseline\.json`/);
  assert.match(text, /- dir `\/P\/x`: 3\.0 GB, modified 2026-10-17, likely owner maple/);
  assert.match(text, /- file `\/P\/y\.txt`: 0\.5 MB, modified 2026-10-16, likely owner unknown/);
});
