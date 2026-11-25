'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { mergePreflight, strayPaths } = loadTs('src/main/mergePreflight.ts');
const { handleCampMcpCall } = loadTs('src/main/campTools.ts');

const git = (...a) => {
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const put = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const commit = (dir, rel, text) => { put(dir, rel, text); git('-C', dir, 'add', rel); git('-C', dir, 'commit', '-qm', rel); };

function repos(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-preflight-'));
  t.after(() => rmTree(tmp));
  const repo = path.join(tmp, 'repo'), wt = path.join(tmp, 'wt');
  git('init', '-q', '-b', 'main', repo);
  commit(repo, 'a.txt', 'a');
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat', wt, 'main');
  commit(wt, 'src/b.ts', 'b');
  return { repo, wt, opts: { repo, worktree: wt, branch: 'feat', target: 'main' } };
}
const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c.status]));

test('strayPaths flags scratch output, not source', () => {
  assert.deepEqual(strayPaths(['src/x.ts', 'a.orig', 'logs/run.log', 'node_modules/x/i.js', 'dist/app.js', 'COMMIT_MSG_TMP', 'docs/out.md']),
    ['a.orig', 'logs/run.log', 'node_modules/x/i.js', 'dist/app.js', 'COMMIT_MSG_TMP']);
});

test('a clean fast-forward branch with passing tests passes every check', (t) => {
  const { opts } = repos(t);
  const r = mergePreflight({ ...opts, testCommand: 'true' });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(byName(r), { 'clean-tree': 'pass', 'fast-forward': 'pass', tests: 'pass', 'no-stray-files': 'pass' });
});

test('each check fails on its own problem', (t) => {
  const { repo, wt, opts } = repos(t);
  commit(repo, 'moved.txt', 'target moved');
  commit(wt, 'debug.log', 'x');
  put(wt, 'notes.txt', 'untracked');
  put(repo, 'a.txt', 'dirty');
  const r = mergePreflight({ ...opts, testCommand: 'echo boom; exit 3' });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(byName(r), { 'clean-tree': 'fail', 'fast-forward': 'fail', tests: 'fail', 'no-stray-files': 'fail' });
  const stray = r.checks.find((c) => c.name === 'no-stray-files').detail;
  assert.match(stray, /added: debug\.log/);
  assert.match(stray, /untracked in worktree: notes\.txt/);
  assert.match(r.checks.find((c) => c.name === 'tests').detail, /exited 3\nboom/);
});

test('no test command fails unless skipTests; the tool returns the checks either way', (t) => {
  const { opts } = repos(t);
  assert.equal(byName(mergePreflight(opts)).tests, 'fail');
  assert.equal(mergePreflight({ ...opts, skipTests: true }).verdict, 'pass');
  const res = handleCampMcpCall('merge_preflight', { ...opts }, { hiveRoot: os.tmpdir(), agentId: 'god' });
  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(res.content[0].text).verdict, 'fail');
});
