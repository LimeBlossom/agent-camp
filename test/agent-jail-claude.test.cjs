'use strict';

// camp-jail-provider-claude: a Claude worker in sandboxedAgents runs jailed, with its
// session state writable and the config the human's unjailed sessions load kept read-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, JAIL_BWRAP, PROVIDER_NET_HOSTS } = loadTs('src/main/agentJail.ts');

const ID = 'spruce-test01';
const STATE = ['projects', 'todos', 'shell-snapshots', 'statsig', 'session-env', 'sessions', 'file-history', 'plans', 'debug', 'paste-cache'];

function fixture({ withState = true } = {}) {
  const base = realpathSync(mkdtempSync('/var/tmp/agent-jail-claude-test-'));
  const home = join(base, 'home');
  const claude = join(home, '.claude');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const scratchRoot = join(base, 'scratch');
  const project = join(base, 'projects', 'Game');
  for (const d of [join(claude, 'hooks'), join(claude, 'rules'), join(claude, 'plugins'), join(hive, 'bin'), agentDir, join(scratchRoot, ID), project]) {
    mkdirSync(d, { recursive: true });
  }
  if (withState) for (const d of STATE) mkdirSync(join(claude, d), { recursive: true });
  writeFileSync(join(claude, 'settings.json'), '{"hooks":{}}');
  writeFileSync(join(claude, 'CLAUDE.md'), '# rules');
  writeFileSync(join(claude, 'hooks', 'guard.sh'), '#!/bin/sh');
  writeFileSync(join(claude, 'rules', 'r.md'), 'rule');
  writeFileSync(join(claude, '.credentials.json'), '{}');
  writeFileSync(join(home, '.claude.json'), '{"projects":{}}');
  if (withState) {
    mkdirSync(join(claude, 'projects', '-home-user-Vault', 'memory'), { recursive: true });
    writeFileSync(join(claude, 'projects', '-home-user-Vault', 'memory', 'MEMORY.md'), '# index');
  }
  return { base, home, claude, hive, agentDir, scratchRoot, project };
}

function planFor(f) {
  return jailPlan({
    provider: 'claude', agentId: ID, home: f.home, agentDir: f.agentDir, hiveRoot: f.hive,
    scratchRoot: f.scratchRoot, cwd: f.project, extraWritable: [], runtimeDirs: []
  });
}

test('claude: the plan is ok with session state writable and config, hooks and rules not', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const w = r.plan.writable;
    for (const d of STATE) assert.ok(w.includes(join(f.claude, d)), `~/.claude/${d} writable`);
    for (const d of [f.claude, f.home, join(f.claude, 'hooks'), join(f.claude, 'rules'), join(f.claude, 'plugins')]) {
      assert.ok(!w.some((x) => x === d), `${d} not writable`);
    }
    assert.ok(r.plan.readOnly.includes(join(f.claude, 'projects', '-home-user-Vault', 'memory')), 'auto-memory the unjailed sessions load stays read-only');
    assert.ok(!w.some((x) => x.endsWith('.claude.json') || x.endsWith('settings.json') || x.endsWith('CLAUDE.md')), 'no config file is bound writable');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('claude: missing state folders are created so the bind exists', () => {
  const f = fixture({ withState: false });
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    for (const d of STATE) {
      assert.ok(existsSync(join(f.claude, d)), `~/.claude/${d} created`);
      assert.ok(r.plan.writable.includes(join(f.claude, d)));
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('claude: the proxy lets the CLI reach Anthropic', () => {
  const hosts = PROVIDER_NET_HOSTS.claude;
  assert.ok(Array.isArray(hosts) && hosts.includes('anthropic.com'));
});

const haveBwrap = existsSync(JAIL_BWRAP);

test('live claude: state writes work; settings, hooks, rules, CLAUDE.md, credentials and ~/.claude.json stay read-only', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const run = (script) => spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/bin/sh', '-c', script]), { encoding: 'utf8' });
    const ok = (script) => { const res = run(script); assert.equal(res.status, 0, `${script}\n${res.stderr}`); };
    const fails = (script) => assert.notEqual(run(script).status, 0, `${script} should fail`);
    for (const d of STATE) ok(`touch '${f.claude}/${d}/x.jsonl'`);
    ok(`touch '${f.claude}/projects/-home-user-Vault/s.jsonl'`);
    fails(`echo x >> '${f.claude}/projects/-home-user-Vault/memory/MEMORY.md'`);
    fails(`touch '${f.claude}/projects/-home-user-Vault/memory/injected.md'`);
    ok(`cat '${f.claude}/settings.json' '${f.home}/.claude.json' > /dev/null`);
    fails(`echo '{}' > '${f.claude}/settings.json'`);
    fails(`touch '${f.claude}/settings.local.json'`);
    fails(`echo x > '${f.claude}/CLAUDE.md'`);
    fails(`echo x >> '${f.claude}/hooks/guard.sh'`);
    fails(`touch '${f.claude}/hooks/new.sh'`);
    fails(`touch '${f.claude}/rules/new.md'`);
    fails(`touch '${f.claude}/plugins/injected'`);
    fails(`echo '{}' > '${f.claude}/.credentials.json'`);
    fails(`echo '{}' > '${f.home}/.claude.json'`);
    fails(`touch '${f.home}/.claude.json.lock'`);
    assert.equal(readFileSync(join(f.claude, 'settings.json'), 'utf8'), '{"hooks":{}}');
    assert.equal(readFileSync(join(f.home, '.claude.json'), 'utf8'), '{"projects":{}}');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('claude: the jail forwards the telemetry collector port, other providers only the configured ones', () => {
  const { jailLoopbackPorts } = loadTs('src/main/agentJail.ts');
  assert.deepEqual(jailLoopbackPorts([9876], 'claude', 'http://127.0.0.1:43111'), [9876, 43111]);
  assert.deepEqual(jailLoopbackPorts(null, 'claude', null), []);
  assert.deepEqual(jailLoopbackPorts([9876, 'x', 70000], 'antigravity', 'http://127.0.0.1:43111'), [9876]);
  assert.deepEqual(jailLoopbackPorts([43111], 'claude', 'http://127.0.0.1:43111'), [43111]);
});
