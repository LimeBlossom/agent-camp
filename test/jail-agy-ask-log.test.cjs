'use strict';

// hive-jail-agy-ask-usage-log: agy-ask appends ~/.local/share/agy-ask/usage.log, so a jailed
// agent needs that one folder writable and nothing else under ~/.local.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, JAIL_BWRAP } = loadTs('src/main/agentJail.ts');

const ID = 'quince-test01';
const haveBwrap = existsSync(JAIL_BWRAP) && spawnSync(JAIL_BWRAP, ['--ro-bind', '/', '/', 'true']).status === 0;

function fixture({ withLogDir = true } = {}) {
  const base = realpathSync(mkdtempSync('/var/tmp/agy-ask-log-test-'));
  const home = join(base, 'home');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const scratchRoot = join(base, 'scratch');
  for (const d of [join(home, '.gemini', 'antigravity-cli'), join(home, '.local', 'share', 'other'),
    agentDir, join(hive, 'bin'), join(scratchRoot, ID)]) mkdirSync(d, { recursive: true });
  if (withLogDir) mkdirSync(join(home, '.local', 'share', 'agy-ask'), { recursive: true });
  return { base, home, hive, agentDir, scratchRoot, logDir: join(home, '.local', 'share', 'agy-ask') };
}

function planFor(f) {
  return jailPlan({
    provider: 'antigravity', agentId: ID, home: f.home, agentDir: f.agentDir, hiveRoot: f.hive,
    scratchRoot: f.scratchRoot, cwd: f.agentDir, extraWritable: [], runtimeDirs: []
  });
}

test('the agy-ask usage-log folder is writable, and nothing wider under ~/.local', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(r.plan.writable.includes(f.logDir), 'agy-ask log folder writable');
    for (const d of [f.home, join(f.home, '.local'), join(f.home, '.local', 'share')]) {
      assert.ok(!r.plan.writable.includes(d), `${d} stays read-only`);
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a missing agy-ask folder is created so the bind exists on the first run', () => {
  const f = fixture({ withLogDir: false });
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(f.logDir), 'folder created');
    assert.ok(r.plan.writable.includes(f.logDir));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('live: the jail appends usage.log but cannot write a sibling under ~/.local/share', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const run = (cmd) => spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/bin/sh', '-c', cmd]), { encoding: 'utf8' });
    const ok = run(`echo row >> '${f.logDir}/usage.log'`);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(f.logDir, 'usage.log')));
    assert.notEqual(run(`touch '${f.home}/.local/share/other/x'`).status, 0, 'sibling stays read-only');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
