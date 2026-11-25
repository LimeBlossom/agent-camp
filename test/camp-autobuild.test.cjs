'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { mergeBranch } = loadTs('src/main/campTools.ts');
const { evaluateAndExecuteFfMerge } = loadTs('src/main/harnessFfMerge.ts');
const buildScript = path.resolve(__dirname, '../local-build.sh');
const settleMs = 1000;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-autobuild-'));
  t.after(() => rmTree(root));
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worker');
  const stage = path.join(root, 'stage');
  const installDir = path.join(root, 'install');
  const builds = path.join(installDir, 'builds');
  const launcher = path.join(installDir, 'current.AppImage');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(stage, 'dist-next'), { recursive: true });
  fs.mkdirSync(builds, { recursive: true });
  git(repo, 'init', '-b', 'integration');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'commit', '--allow-empty', '-m', 'base');
  git(repo, 'worktree', 'add', '-b', 'worker', worktree);
  const base = git(repo, 'rev-parse', 'HEAD');
  const image = sha => path.join(builds, 'Camp-' + sha + '.AppImage');
  fs.writeFileSync(image(base), 'last good package');
  fs.symlinkSync(image(base), launcher);
  return { repo, worktree, stage, installDir, builds, launcher, image, base };
}

function advance({ repo, worktree }, via) {
  git(worktree, 'commit', '--allow-empty', '-m', via);
  const options = { repo, worktree, branch: 'worker' };
  const result = via === 'boss'
    ? mergeBranch({ ...options, target: 'integration' })
    : evaluateAndExecuteFfMerge({ ...options, target: 'integration', text: '# tests 1\n# pass 1\n# fail 0' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return git(repo, 'rev-parse', 'refs/heads/integration');
}

function queue(f, packageTip) {
  const { CampBuildQueue } = loadTs('src/main/campBuildQueue.ts');
  const events = [];
  const mail = [];
  const buildQueue = new CampBuildQueue({
    repo: f.repo, branch: 'integration', installDir: f.installDir, settleMs,
    packageTip, log: event => events.push(event),
    mailBoss: (subject, body) => mail.push({ subject, body })
  });
  return { buildQueue, events, mail };
}

async function stageImage(f, embeddedSha) {
  const payload = path.join(f.stage, 'payload');
  fs.mkdirSync(path.join(payload, 'out'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'out', 'camp-build-sha'), embeddedSha + '\n');
  const archive = path.join(f.stage, 'fixture.asar');
  await asar.createPackage(payload, archive);
  // Emulate the AppImage runtime's extraction mode. Any launch attempt fails.
  fs.writeFileSync(path.join(f.stage, 'dist-next', 'Camp.AppImage'), [
    '#!/bin/sh',
    'set -eu',
    'test "$1" = --appimage-extract',
    'test "$2" = resources/app.asar',
    'mkdir -p squashfs-root/resources',
    'cp "$FIXTURE_ASAR" squashfs-root/resources/app.asar'
  ].join('\n'), { mode: 0o755 });
  return archive;
}

function swap(f, sha, archive, extraEnv = {}) {
  return spawnSync('bash', [buildScript, 'swap'], {
    encoding: 'utf8',
    env: {
      ...process.env, MD_ROOT: f.stage, MD_CAMP_INSTALL_DIR: f.installDir,
      MD_BUILD_SHA: sha, FIXTURE_ASAR: archive, MD_RUNNING: '1',
      NODE_PATH: path.resolve(__dirname, '../node_modules'), ...extraEnv
    }
  });
}

test('a Boss merge queues one build and logs the packaged tip and path', async t => {
  const f = fixture(t);
  const calls = [];
  const { buildQueue, events } = queue(f, async sha => {
    calls.push(sha);
    return f.image(sha);
  });
  await buildQueue.poll(0);
  const tip = advance(f, 'boss');
  await buildQueue.poll(1);
  await buildQueue.poll(settleMs + 1);
  await buildQueue.poll(2 * settleMs);
  assert.deepEqual(calls, [tip]);
  assert.deepEqual(events, [{ kind: 'build-done', sha: tip, path: f.image(tip) }]);
});

test('quick Boss and worker auto-ff merges produce one build of the newest tip', async t => {
  const f = fixture(t);
  const calls = [];
  const { buildQueue } = queue(f, async sha => {
    calls.push(sha);
    return f.image(sha);
  });
  await buildQueue.poll(0);
  advance(f, 'boss');
  await buildQueue.poll(1);
  const tip = advance(f, 'worker');
  await buildQueue.poll(2);
  await buildQueue.poll(settleMs + 1);
  assert.deepEqual(calls, []);
  await buildQueue.poll(settleMs + 2);
  assert.deepEqual(calls, [tip]);
});

test('a failed package keeps the launcher and logs and mails the build failure once', async t => {
  const f = fixture(t);
  let attempts = 0;
  const { buildQueue, events, mail } = queue(f, async () => {
    attempts++;
    throw new Error('fixture compiler failure');
  });
  await buildQueue.poll(0);
  const tip = advance(f, 'boss');
  await buildQueue.poll(1);
  await buildQueue.poll(settleMs + 1);
  await buildQueue.poll(2 * settleMs);
  assert.equal(attempts, 1);
  assert.equal(fs.readlinkSync(f.launcher), f.image(f.base));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'build-error');
  assert.equal(events[0].sha, tip);
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /fixture compiler failure/);
});

test('swap rejects a mismatched asar without repointing or pruning', async t => {
  const f = fixture(t);
  const tip = advance(f, 'boss');
  const old = ['1', '2', '3'].map(digit => f.image(digit.repeat(40)));
  for (const file of old) fs.writeFileSync(file, 'old package');
  const result = swap(f, tip, await stageImage(f, f.base));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha|commit/i);
  assert.equal(fs.readlinkSync(f.launcher), f.image(f.base));
  assert.ok(old.every(file => fs.existsSync(file)));
});

test('verified swap repoints the launcher and retains rollback among three packages', async t => {
  const f = fixture(t);
  const tip = advance(f, 'worker');
  const old = ['1', '2', '3'].map(digit => f.image(digit.repeat(40)));
  for (const file of old) fs.writeFileSync(file, 'old package');
  const unrelated = path.join(f.builds, 'other.AppImage');
  fs.writeFileSync(unrelated, 'unrelated package');
  const result = swap(f, tip, await stageImage(f, tip));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readlinkSync(f.launcher), f.image(tip));
  assert.equal(fs.readFileSync(f.image(f.base), 'utf8'), 'last good package');
  assert.equal(fs.readdirSync(f.builds).filter(name => name.startsWith('Camp-')).length, 3);
  assert.ok(fs.existsSync(unrelated));
});

test('a build superseded by a merge leaves the launcher on the last good package', async t => {
  const f = fixture(t);
  const stale = advance(f, 'boss');
  const archive = await stageImage(f, stale);
  advance(f, 'worker');
  const result = swap(f, stale, archive, { MD_CAMP_EXPECT_REPO: f.repo, MD_CAMP_BRANCH: 'integration' });
  assert.equal(result.status, 75, result.stderr);
  assert.equal(fs.readlinkSync(f.launcher), f.image(f.base));
  assert.deepEqual(fs.readdirSync(f.builds), [path.basename(f.image(f.base))]);
  assert.ok(!fs.readdirSync(f.installDir).some(file => file.startsWith('.swap.')));
});
