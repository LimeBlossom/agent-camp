'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { scanLeftovers, formatLeftovers, triageLeftovers, findProjects, LEFTOVER_IDLE_DAYS } = loadTs('src/main/leftovers.ts');

const DAY = 86_400_000;
const OLD = new Date(Date.now() - (LEFTOVER_IDLE_DAYS + 3) * DAY);

function git(cwd, ...args) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', ['-C', cwd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function commit(cwd, file, when) {
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, 'add', file);
  const env = when ? { GIT_COMMITTER_DATE: when.toISOString(), GIT_AUTHOR_DATE: when.toISOString() } : {};
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file], { env: { ...process.env, ...env } });
}

function unity(dir, product) {
  fs.mkdirSync(path.join(dir, 'Assets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectSettings.asset'), `PlayerSettings:\n  productName: ${product}\n`);
}

function ageIndex(wt) {
  const gitDir = git(wt, 'rev-parse', '--absolute-git-dir');
  fs.utimesSync(path.join(gitDir, 'index'), OLD, OLD);
}

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-'));
  made.push(root);
  const game = path.join(root, 'Game');
  fs.mkdirSync(game);
  git(game, 'init', '-q', '-b', 'main');
  unity(game, 'MyGame');
  commit(game, 'a.txt');

  // Merged and clean: listed.
  git(game, 'worktree', 'add', '-q', '-b', 'done-feature', path.join(root, 'Game-done'));
  commit(path.join(root, 'Game-done'), 'b.txt');
  git(game, 'merge', '-q', '--ff-only', 'done-feature');

  // Merged but dirty: work in progress, not listed.
  git(game, 'worktree', 'add', '-q', '-b', 'dirty', path.join(root, 'Game-dirty'));
  fs.writeFileSync(path.join(root, 'Game-dirty', 'wip.txt'), 'wip');

  // Unmerged and fresh: not listed.
  git(game, 'worktree', 'add', '-q', '-b', 'active', path.join(root, 'Game-active'));
  commit(path.join(root, 'Game-active'), 'c.txt');

  // Unmerged and untouched for a week: listed as idle.
  git(game, 'worktree', 'add', '-q', '-b', 'stale', path.join(root, 'Game-stale'));
  commit(path.join(root, 'Game-stale'), 'd.txt', OLD);
  ageIndex(path.join(root, 'Game-stale'));

  // Local clone whose HEAD is in main: listed.
  execFileSync('git', ['clone', '-q', game, path.join(root, 'Game-clone')]);

  // Unity copies outside git: a twin of MyGame and one named after an agent are listed,
  // an unrelated original jam project is not.
  unity(path.join(root, 'copy-of-game'), 'MyGame');

  // Clone of a folder since moved away, carrying the tracked game's product: listed as
  // an orphan, and never chosen as copy-of-game's twin.
  const gone = path.join(root, 'Moved');
  fs.mkdirSync(gone);
  git(gone, 'init', '-q', '-b', 'main');
  unity(gone, 'MyGame');
  commit(gone, 'm.txt');
  execFileSync('git', ['clone', '-q', gone, path.join(root, 'AAA-orphan')]);
  fs.rmSync(gone, { recursive: true, force: true });
  unity(path.join(root, 'Jams', 'maple-probe'), 'Probe');
  unity(path.join(root, 'Jams', 'OriginalJam'), 'OriginalJam');
  return root;
}

const deps = (now = Date.now()) => ({
  git: (cwd, args) => {
    try { return Promise.resolve(execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); }
    catch { return Promise.resolve(null); }
  },
  sizeOf: () => Promise.resolve(1_500_000_000),
  now: () => now
});

test('findProjects finds main repos and non-git Unity projects, not worktrees', () => {
  const root = fixture();
  const found = findProjects([root]);
  assert.deepEqual(found.repos.map((p) => path.basename(p)), ['AAA-orphan', 'Game', 'Game-clone']);
  assert.deepEqual(found.unity.map((p) => path.basename(p)), ['OriginalJam', 'maple-probe', 'copy-of-game']);
});

test('scanLeftovers lists merged-clean and idle worktrees, clones and Unity copies only', async () => {
  const root = fixture();
  const list = await scanLeftovers([root], ['Maple', 'Delta Status Scout'], {}, deps());
  const got = list.map((l) => `${l.kind} ${path.basename(l.path)} ${l.reason}`).sort();
  assert.deepEqual(got, [
    'clone AAA-orphan orphan',
    'clone Game-clone merged',
    'copy copy-of-game copy',
    'copy maple-probe copy',
    'worktree Game-done merged',
    'worktree Game-stale idle'
  ]);
  const done = list.find((l) => path.basename(l.path) === 'Game-done');
  assert.equal(done.branch, 'done-feature');
  assert.equal(path.basename(done.of), 'Game');
  assert.equal(done.into, 'main');
  assert.equal(done.sizeBytes, 1_500_000_000);
});

test('scanLeftovers skips Unity copies untouched since before the hive existed', async () => {
  const root = fixture();
  const old = path.join(root, 'copy-of-game');
  for (const p of [old, path.join(old, 'Assets'), path.join(old, 'ProjectSettings'), path.join(old, 'ProjectSettings', 'ProjectSettings.asset')]) fs.utimesSync(p, OLD, OLD);
  const list = await scanLeftovers([root], ['Maple'], { copiesSinceMs: Date.now() - DAY }, deps());
  const copies = list.filter((l) => l.kind === 'copy').map((l) => path.basename(l.path));
  assert.deepEqual(copies, ['maple-probe']);
});

test('a Unity copy names the tracked repo as its twin, not a clone of it', async () => {
  const root = fixture();
  const list = await scanLeftovers([root], [], {}, deps());
  assert.equal(path.basename(list.find((l) => path.basename(l.path) === 'copy-of-game').of), 'Game');
});

test('scanLeftovers never modifies the folders it reports', async () => {
  const root = fixture();
  const snap = () => execFileSync('find', [root, '-not', '-path', '*/.git/*'], { encoding: 'utf8' }).split('\n').sort().join('\n');
  const before = snap();
  const indexBefore = fs.statSync(path.join(git(path.join(root, 'Game-stale'), 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs;
  await scanLeftovers([root], ['Maple']);
  assert.equal(snap(), before);
  assert.equal(fs.statSync(path.join(git(path.join(root, 'Game-stale'), 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs, indexBefore);
});

test('formatLeftovers lists only the safe set, with remove commands, and counts the stale rest', () => {
  const NOW = Date.UTC(2026, 10, 6);
  assert.equal(formatLeftovers([], '/home/u', NOW), null);
  const one = { kind: 'worktree', path: '/home/u/src/x-y', of: '/home/u/src/x', branch: 'b', reason: 'merged', into: 'main', lastTouchedMs: Date.UTC(2026, 9, 1), sizeBytes: 2e9, audit: { ok: true, issues: [] } };
  const idle = { ...one, path: '/home/u/src/x-old', reason: 'idle', into: undefined, sizeBytes: 1e9 };
  const text = formatLeftovers([one, idle], '/home/u', NOW);
  assert.equal(text.split('\n').length, 3);
  assert.match(text, /^Leftovers safe to remove \(1, 2\.0 GB; report only/);
  assert.match(text, /- `~\/src\/x-y` \[b\] of x: merged into main, clean, 2\.0 GB, last touched 2026-10-01\. `git -C ~\/src\/x worktree remove ~\/src\/x-y`/);
  assert.doesNotMatch(text, /x-old/, 'a stale one is never listed');
  assert.match(text, /1 stale leftover\(s\) \(1\.0 GB/);
  assert.equal(formatLeftovers([idle], '/home/u', NOW), 'Leftovers: none safe to remove. 1 stale leftover(s) (1.0 GB: idle, orphaned or outside git) not listed; they need their owner\'s say.');
  const many = Array.from({ length: 25 }, (_, i) => ({ ...one, path: `/p/${i}` }));
  const lines = formatLeftovers(many, '/home/u', NOW).split('\n');
  assert.equal(lines.length, 22);
  assert.equal(lines[21], '- and 5 more (10.0 GB)');
});

test('triageLeftovers: a merged worktree touched within a day, a merged clone and a copy are not safe', () => {
  const NOW = Date.UTC(2026, 10, 6);
  const wt = { kind: 'worktree', path: '/a', of: '/r', reason: 'merged', lastTouchedMs: NOW - 2 * DAY, sizeBytes: 1, audit: { ok: true, issues: [] } };
  const fresh = { ...wt, path: '/b', lastTouchedMs: NOW - 3_600_000 };
  const clone = { ...wt, kind: 'clone', path: '/c' };
  const copy = { ...wt, kind: 'copy', path: '/d', reason: 'copy' };
  const { safe, stale } = triageLeftovers([wt, fresh, clone, copy], NOW);
  assert.deepEqual(safe.map((l) => l.path), ['/a']);
  assert.deepEqual(stale.map((l) => l.path), ['/b', '/c', '/d']);
});
