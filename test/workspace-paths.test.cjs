'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const wp = loadTs('src/main/workspacePaths.ts');

test('the workspace root is the real parent of a symlinked hive home', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'drive', 'HarnessAgents'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'home'));
  fs.symlinkSync(path.join(tmp, 'drive', 'HarnessAgents'), path.join(tmp, 'home', 'HarnessAgents'));
  assert.equal(wp.deriveWorkspaceRoot({ harnessHome: path.join(tmp, 'home', 'HarnessAgents') }), fs.realpathSync(path.join(tmp, 'drive')));
});

test('config workspaceRoot wins over the hive home; nothing set falls back to the user home', () => {
  assert.equal(wp.deriveWorkspaceRoot({ workspaceRoot: '/srv/work', harnessHome: '/x/HarnessAgents' }), '/srv/work');
  assert.equal(wp.deriveWorkspaceRoot({ harnessHome: null }), os.homedir());
});

test('a launch-environment root is kept over config', () => {
  const env = {};
  assert.equal(wp.exportWorkspaceRoot({ workspaceRoot: '/from/config' }, env, '/from/launch'), '/from/launch');
  assert.equal(env.MD_WORKSPACE_ROOT, '/from/launch');
  assert.equal(wp.exportWorkspaceRoot({ workspaceRoot: '/from/config' }, env, undefined), '/from/config');
});

test('scratch and stray dirs hang off the workspace root unless their own variable is set', () => {
  const env = { MD_WORKSPACE_ROOT: '/w' };
  assert.equal(wp.hiveScratchRoot(env), '/w/.hive-scratch');
  assert.deepEqual(wp.strayWatchDirs([], env), ['/w']);
  assert.deepEqual(wp.strayWatchDirs(['/w/games/a', '/w/games/jams/b', '/elsewhere/c'], env), ['/w', '/w/games', '/w/games/jams']);
  assert.equal(wp.hiveScratchRoot({ MD_WORKSPACE_ROOT: '/w', MD_HIVE_SCRATCH_ROOT: '/s' }), '/s');
});

test('no tracked source names this machine\'s home or mount folders', () => {
  const user = os.userInfo().username;
  const root = path.join(__dirname, '..');
  const needles = [`/home/${user}/`, `/media/${user}/`, `/Users/${user}/`, `/mnt/${user}/`];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(ts|tsx|cjs|mjs|js|sh|json|ya?ml)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (needles.some((n) => text.includes(n))) offenders.push(path.relative(root, p));
    }
  };
  for (const d of ['src', 'test', 'test-support', 'tools', 'scripts']) {
    if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  }
  assert.deepEqual(offenders, [], 'put machine paths in config or the environment, not in code');
});
