'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { worktreeRoot } = loadTs('src/main/worktreeRoot.ts');

test('worktrees go on the scratch drive when it is mounted', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'md-wtroot-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.equal(worktreeRoot('/home/u/HarnessAgents', '/repo', scratch), path.join(scratch, 'worktrees'));
});

test('an unmounted scratch drive falls back to the hive home, then the repo', () => {
  const missing = path.join(os.tmpdir(), 'md-wtroot-missing-' + process.pid);
  assert.equal(worktreeRoot('/home/u/HarnessAgents', '/repo', missing), path.join('/home/u/HarnessAgents', 'worktrees'));
  assert.equal(worktreeRoot(null, '/repo', null), path.join('/repo', 'worktrees'));
});
