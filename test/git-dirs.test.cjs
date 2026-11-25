'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { gitDirsOf, agentGitDirs, enclosingRepo, taskRepoRoots } = loadTs('src/main/gitDirs.ts');

function tmp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-gitdirs-'))); }
const repo = (d) => fs.mkdirSync(path.join(d, '.git', 'objects'), { recursive: true });

test('a .git folder is its own git dir; a .git file resolves gitdir and its common dir', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  repo(path.join(root, 'main'));
  const wtGit = path.join(root, 'main', '.git', 'worktrees', 'wt');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  fs.mkdirSync(path.join(root, 'wt'));
  fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
  const subGit = path.join(root, 'main', '.git', 'modules', 'sub');
  fs.mkdirSync(subGit, { recursive: true });
  fs.mkdirSync(path.join(root, 'main', 'sub'));
  fs.writeFileSync(path.join(root, 'main', 'sub', '.git'), 'gitdir: ' + subGit + '\n');

  assert.deepEqual(gitDirsOf(path.join(root, 'main')), [path.join(root, 'main', '.git')]);
  assert.deepEqual(gitDirsOf(path.join(root, 'wt')), [wtGit, path.join(root, 'main', '.git')]);
  assert.deepEqual(gitDirsOf(path.join(root, 'main', 'sub')), [subGit], 'a submodule has no commondir');
  assert.deepEqual(gitDirsOf(root), []);
  fs.writeFileSync(path.join(root, 'bad'), '');
  fs.mkdirSync(path.join(root, 'broken'));
  fs.writeFileSync(path.join(root, 'broken', '.git'), 'gitdir: /nope/nowhere\n');
  assert.deepEqual(gitDirsOf(path.join(root, 'broken')), []);
});

test('an agent gets its own repo, extra dirs that are repos, and repos directly inside them', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  repo(path.join(root, 'Vault'));
  fs.mkdirSync(path.join(root, 'Vault', 'Notes', 'Deep'), { recursive: true });
  repo(path.join(root, 'GameDev', 'GameA'));
  repo(path.join(root, 'GameDev', 'GameB'));
  repo(path.join(root, 'GameDev', 'Jams', 'JamOne'));
  repo(path.join(root, 'GameDev', 'GameA', 'Packages', 'Sub'));
  fs.mkdirSync(path.join(root, 'GameDev', '.hidden', '.git'), { recursive: true });
  repo(path.join(root, 'Tools'));
  const dirs = agentGitDirs(path.join(root, 'Vault', 'Notes', 'Deep'),
    [path.join(root, 'GameDev'), path.join(root, 'Tools')], [path.join(root, 'GameDev', 'GameB')]);
  assert.deepEqual(dirs.sort(), [
    path.join(root, 'GameDev', 'GameA', '.git'),
    path.join(root, 'GameDev', 'GameB', '.git'),
    path.join(root, 'Tools', '.git'),
    path.join(root, 'Vault', '.git')
  ].sort(), 'two levels down (JamOne, the nested Sub) and hidden folders are left out');
});

test('repos directly inside the cwd count too', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  repo(path.join(root, 'src', 'one'));
  assert.deepEqual(agentGitDirs(path.join(root, 'src'), []), [path.join(root, 'src', 'one', '.git')]);
});

test('the home repo is never reached by climbing from below it', (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  repo(home);
  fs.mkdirSync(path.join(home, 'HarnessAgents'));
  assert.equal(enclosingRepo(path.join(home, 'HarnessAgents'), home), null);
  assert.equal(enclosingRepo(home, home), home, 'an agent whose cwd IS home still gets it');
  assert.deepEqual(agentGitDirs(path.join(home, 'HarnessAgents'), [], [], home), []);
});

test('open tasks name repos by absolute path or by project label, inside the project dirs', (t) => {
  const root = tmp();
  const outside = tmp();
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  repo(path.join(root, 'Sphere-Survivors'));
  repo(path.join(root, 'BetaGame'));
  fs.mkdirSync(path.join(root, 'BetaGame', 'Assets'), { recursive: true });
  repo(path.join(outside, 'Elsewhere'));
  const found = taskRepoRoots([
    { text: `Fix lighting in ${path.join(root, 'BetaGame', 'Assets', 'Missing.cs')}.`, project: 'Alpha' },
    { text: 'Port the shader', project: 'SphereSurvivors' },
    { text: `See ${path.join(outside, 'Elsewhere')}`, project: 'Studio' }
  ], [root]);
  assert.deepEqual(found.sort(), [path.join(root, 'BetaGame'), path.join(root, 'Sphere-Survivors')].sort());
});

test('a `_` grouping folder adds the repos directly inside it, one level only', (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jams = path.join(root, 'GameDev', '_Game Jams');
  repo(path.join(jams, 'SphereSurvivors'));
  repo(path.join(jams, 'OtherJam'));
  repo(path.join(jams, '_Archive', 'OldJam'));
  repo(path.join(jams, 'Group', 'TooDeep'));
  repo(path.join(root, 'GameDev', 'Plain', 'Nested'));
  repo(path.join(root, 'GameDev', 'GameA'));
  const dirs = agentGitDirs(undefined, [path.join(root, 'GameDev')]);
  assert.deepEqual(dirs.sort(), [
    path.join(root, 'GameDev', 'GameA', '.git'),
    path.join(jams, 'OtherJam', '.git'),
    path.join(jams, 'SphereSurvivors', '.git')
  ].sort(), 'not through a non-`_` folder, not a `_` folder inside a `_` folder, not two levels into the group');
});
