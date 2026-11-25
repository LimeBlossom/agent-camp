'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const {
  oversizedPaths, excludePathspecs, removeTmpObjects, HiveCommitMonitor,
  HIVE_COMMIT_WARN_AFTER_MS, HIVE_COMMIT_WARN_REPEAT_MS
} = loadTs('src/main/hiveCommitGuard.ts');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-guard-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  const write = (rel, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), Buffer.alloc(bytes, 120));
  };
  const runner = (args) => { const r = git(...args); return { ok: r.status === 0, out: r.stdout }; };
  git('init', '-q');
  return { dir, git, write, runner, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('files over the cap are left out of the add, small ones and ones with glob characters in the name are judged by size', async () => {
  const r = repo();
  try {
    r.write('board.md', 10);
    r.write('research/reel/game.zip', 2000);
    r.write('research/a*[b] big.bin', 2000);
    r.write('research/notes.md', 10);
    r.write('research/ignored.zip', 5000);
    fs.writeFileSync(path.join(r.dir, '.gitignore'), 'research/ignored.zip\n');
    r.write('tracked.log', 10);
    r.git('add', '--', 'tracked.log');
    r.git('commit', '-q', '-m', 'seed');
    r.write('tracked.log', 3000); // a tracked file that grew past the cap

    const scope = ['.', ':(exclude)agents'];
    const big = await oversizedPaths(r.dir, r.runner, scope, 1000);
    assert.deepEqual(big, ['research/a*[b] big.bin', 'research/reel/game.zip', 'tracked.log']);

    assert.equal(r.git('add', '-A', '--', ...scope, ...excludePathspecs(big)).status, 0);
    const staged = r.git('diff', '--cached', '--name-only').stdout.trim().split('\n').sort();
    assert.deepEqual(staged, ['.gitignore', 'board.md', 'research/notes.md']);
  } finally { r.done(); }
});

test('a deleted tracked file is not reported as oversized, and a failed listing reports nothing', async () => {
  const r = repo();
  try {
    r.write('gone.bin', 3000);
    r.git('add', '--', 'gone.bin');
    r.git('commit', '-q', '-m', 'seed');
    fs.rmSync(path.join(r.dir, 'gone.bin'));
    assert.deepEqual(await oversizedPaths(r.dir, r.runner, ['.'], 1000), []);
    assert.deepEqual(await oversizedPaths(r.dir, async () => ({ ok: false, out: '' }), ['.'], 1000), []);
  } finally { r.done(); }
});

test('after a timeout only the tmp objects written since the attempt began are removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tmpobj-'));
  try {
    const objects = path.join(dir, 'objects');
    fs.mkdirSync(path.join(objects, 'pack'), { recursive: true });
    const put = (rel, ageMs) => {
      const p = path.join(objects, rel);
      fs.writeFileSync(p, Buffer.alloc(100));
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(p, t, t);
    };
    put('tmp_obj_new', 0);
    put('pack/tmp_pack_new', 0);
    put('tmp_obj_older', 60_000);
    put('ab', 0); // not a tmp file
    const freed = removeTmpObjects(dir, Date.now() - 1000);
    assert.equal(freed, 200);
    assert.deepEqual(fs.readdirSync(objects).sort(), ['ab', 'pack', 'tmp_obj_older']);
    assert.deepEqual(fs.readdirSync(path.join(objects, 'pack')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the startup sweep removes only orphans old enough that no running git owns them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tmpobj-'));
  try {
    const objects = path.join(dir, 'objects');
    fs.mkdirSync(objects, { recursive: true });
    for (const [name, ageMs] of [['tmp_obj_live', 60_000], ['tmp_obj_orphan', 2 * 3_600_000]]) {
      const p = path.join(objects, name);
      fs.writeFileSync(p, 'x');
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(p, t, t);
    }
    assert.equal(removeTmpObjects(dir), 1);
    assert.deepEqual(fs.readdirSync(objects), ['tmp_obj_live']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the boss is warned once a failure streak passes the threshold, then at the repeat interval, and a success resets it', () => {
  const m = new HiveCommitMonitor();
  const t0 = 1_000_000_000_000;
  m.ok(t0);
  m.fail('git add timed out', t0 + 1000);
  assert.equal(m.warning(t0 + 1000), null);
  assert.equal(m.snapshot().failingSince, t0);

  const late = t0 + HIVE_COMMIT_WARN_AFTER_MS;
  m.fail('git add timed out', late);
  const w = m.warning(late);
  assert.match(w, /failed for 1\.0 h \(2 attempts this run\).*git add timed out/);
  assert.equal(m.warning(late + 1000), null);
  assert.ok(m.warning(late + HIVE_COMMIT_WARN_REPEAT_MS));

  m.ok(late + HIVE_COMMIT_WARN_REPEAT_MS + 1);
  assert.deepEqual(m.snapshot(), { lastOkAt: late + HIVE_COMMIT_WARN_REPEAT_MS + 1, failingSince: null, failures: 0, lastError: null });
  assert.equal(m.warning(late + 10 * HIVE_COMMIT_WARN_REPEAT_MS), null);
});

test('a streak that began before this process started is dated from the last commit', () => {
  const m = new HiveCommitMonitor();
  const now = 1_000_000_000_000;
  m.fail('boom', now, now - 5 * 3_600_000);
  assert.match(m.warning(now), /failed for 5\.0 h/);
});

const { livePathspecs, combinedCommitMessage } = loadTs('src/main/hive.ts');

test('a per-agent pathspec no agent has is dropped, since git add fails on a pathspec that matches nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-live-'));
  try {
    fs.mkdirSync(path.join(dir, 'agents', 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'a', 'memory.md'), 'm');
    assert.deepEqual(livePathspecs(dir, ['agents/*/memory.md', 'agents/*/memory-archive.md', '.', ':(exclude)agents']),
      ['agents/*/memory.md', '.', ':(exclude)agents']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one change keeps its own message; a burst is counted and summarised', () => {
  assert.equal(combinedCommitMessage(['hive: msg a→b']), 'hive: msg a→b');
  assert.equal(combinedCommitMessage(['x', 'y', 'x']), 'hive: 3 changes\n\nx x2\ny');
});
