'use strict';

// A jailed Claude has no route to downloads.claude.ai, so its autoupdater only pages the Boss.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, JAIL_BWRAP } = loadTs('src/main/agentJail.ts');
const ID = 'hazel-test01';

function planFor(provider) {
  const base = realpathSync(mkdtempSync('/var/tmp/jail-provider-env-test-'));
  const home = join(base, 'home');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const scratchRoot = join(base, 'scratch');
  for (const d of [join(hive, 'bin'), agentDir, join(scratchRoot, ID), home]) mkdirSync(d, { recursive: true });
  const r = jailPlan({ provider, agentId: ID, home, agentDir, hiveRoot: hive, scratchRoot, cwd: base, extraWritable: [], runtimeDirs: [] });
  assert.equal(r.ok, true, r.error);
  return { base, plan: r.plan };
}

function setenvPairs(argv) {
  const out = {};
  for (let i = 0; i < argv.indexOf('--'); i++) if (argv[i] === '--setenv') out[argv[i + 1]] = argv[i + 2];
  return out;
}

test('claude: the jail sets DISABLE_AUTOUPDATER=1', () => {
  const { base, plan } = planFor('claude');
  try {
    assert.equal(setenvPairs(jailArgv(plan, ['claude']))['DISABLE_AUTOUPDATER'], '1');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('antigravity: the jail sets no Claude env', () => {
  const { base, plan } = planFor('antigravity');
  try {
    assert.equal(setenvPairs(jailArgv(plan, ['agy']))['DISABLE_AUTOUPDATER'], undefined);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('claude: the jailed process sees DISABLE_AUTOUPDATER=1', { skip: !existsSync(JAIL_BWRAP) && 'no bwrap' }, () => {
  const { base, plan } = planFor('claude');
  try {
    const r = spawnSync(JAIL_BWRAP, jailArgv(plan, ['/bin/sh', '-c', 'printf %s "$DISABLE_AUTOUPDATER"']), { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '1');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
