'use strict';

// camp-jail-provider-codex: a Codex worker in sandboxedAgents runs jailed. Its per-agent
// CODEX_HOME (<agentDir>/.codex) stays writable, the session folders and login it links
// from ~/.codex are bound writable through the links, and the hive-written config.toml
// (hooks and the user's PreToolUse guards) stays read-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync, symlinkSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, JAIL_BWRAP, JAIL_PROVIDERS, jailSupports, PROVIDER_NET_HOSTS } = loadTs('src/main/agentJail.ts');
const { startJailProxy } = loadTs('src/main/jailProxy.ts');
const { codexSandboxLevelFor } = loadTs('src/shared/codexSandbox.ts');

const ID = 'pine-test01';
const HIVE_ID = 'f776f7793822';

function fixture() {
  const base = realpathSync(mkdtempSync('/var/tmp/agent-jail-codex-test-'));
  const home = join(base, 'home');
  const userCodex = join(home, '.codex');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const codexHome = join(agentDir, '.codex');
  const scratchRoot = join(base, 'scratch');
  const sessions = join(userCodex, 'sessions', 'munder-difflin', HIVE_ID, ID);
  const archived = join(userCodex, 'archived_sessions', 'munder-difflin', HIVE_ID, ID);
  const otherSessions = join(userCodex, 'sessions', 'munder-difflin', HIVE_ID, 'other-agent');
  for (const d of [codexHome, join(hive, 'bin'), join(scratchRoot, ID), sessions, archived, otherSessions, join(userCodex, 'skills')]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(userCodex, 'auth.json'), '{"tokens":"old"}');
  writeFileSync(join(userCodex, 'config.toml'), 'model = "gpt-6.2-astra"\n');
  writeFileSync(join(userCodex, 'AGENTS.md'), '# user');
  writeFileSync(join(codexHome, 'config.toml'), '[[hooks.PreToolUse]]\n');
  symlinkSync(join(userCodex, 'auth.json'), join(codexHome, 'auth.json'));
  symlinkSync(join(userCodex, 'AGENTS.md'), join(codexHome, 'AGENTS.md'));
  symlinkSync(sessions, join(codexHome, 'sessions'));
  symlinkSync(archived, join(codexHome, 'archived_sessions'));
  return { base, home, userCodex, hive, agentDir, codexHome, scratchRoot, sessions, archived, otherSessions };
}

function planFor(f, over = {}) {
  return jailPlan({
    provider: 'codex', agentId: ID, home: f.home, agentDir: f.agentDir, hiveRoot: f.hive,
    scratchRoot: f.scratchRoot, cwd: f.agentDir, extraWritable: [], runtimeDirs: [], ...over
  });
}

test('codex: the jail supports the provider', () => {
  assert.equal(jailSupports('codex'), true);
  assert.ok(JAIL_PROVIDERS.includes('codex'));
});

test('codex: the plan binds the linked session folders and login writable, the hive config read-only', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const w = r.plan.writable;
    assert.ok(w.includes(f.agentDir), 'CODEX_HOME lives in the writable agent folder');
    assert.ok(w.includes(f.sessions), 'the session folder the link points at is writable');
    assert.ok(w.includes(f.archived), 'the archived-session folder the link points at is writable');
    assert.ok(w.includes(join(f.userCodex, 'auth.json')), 'the login is writable, so a token refresh is saved');
    for (const d of [f.home, f.userCodex, join(f.userCodex, 'sessions'), f.otherSessions, join(f.userCodex, 'config.toml'), join(f.userCodex, 'AGENTS.md')]) {
      assert.ok(!w.includes(d), `${d} not writable`);
    }
    assert.ok(r.plan.readOnly.includes(join(f.codexHome, 'config.toml')), 'hooks and guards in config.toml stay read-only');
    assert.deepEqual(r.plan.env, {});
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('codex: a link that points outside ~/.codex is not bound', () => {
  const f = fixture();
  try {
    const elsewhere = join(f.base, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(f.codexHome, 'sessions'));
    symlinkSync(elsewhere, join(f.codexHome, 'sessions'));
    rmSync(join(f.codexHome, 'auth.json'));
    symlinkSync(join(f.home, '.claude.json'), join(f.codexHome, 'auth.json'));
    writeFileSync(join(f.home, '.claude.json'), '{}');
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(!r.plan.writable.includes(elsewhere));
    assert.ok(!r.plan.writable.includes(join(f.home, '.claude.json')));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('codex: a missing CODEX_HOME plans without the linked binds', () => {
  const f = fixture();
  try {
    rmSync(f.codexHome, { recursive: true, force: true });
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(!r.plan.writable.includes(f.sessions));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('codex: the proxy lets the CLI reach ChatGPT and OpenAI', () => {
  const hosts = PROVIDER_NET_HOSTS.codex;
  assert.ok(Array.isArray(hosts) && hosts.includes('chatgpt.com') && hosts.includes('openai.com'));
});

test('codex: a jailed agent runs danger-full-access, since bwrap is the boundary', () => {
  assert.equal(codexSandboxLevelFor({ jailed: true, agentSandbox: true, stored: 'sandboxed' }), 'full');
  assert.equal(codexSandboxLevelFor({ jailed: true, agentSandbox: false, stored: 'sandboxed' }), 'full');
  assert.equal(codexSandboxLevelFor({ jailed: false, agentSandbox: true, stored: 'sandboxed' }), 'sandboxed');
  assert.equal(codexSandboxLevelFor({ jailed: false, agentSandbox: true, stored: 'full' }), 'full');
  assert.equal(codexSandboxLevelFor({ jailed: false, agentSandbox: false, stored: 'sandboxed' }), 'full');
});

test('proxy: telemetry hosts stay denied when a broader provider domain is allowed', async (t) => {
  const dir = realpathSync(mkdtempSync('/var/tmp/agent-jail-codex-proxy-'));
  const denied = [];
  const proxy = await startJailProxy({
    sock: join(dir, 'proxy.sock'), allow: () => ['chatgpt.com'], loopbackPorts: [],
    onDeny: (h) => denied.push(h), connectTo: () => ({ host: '127.0.0.1', port: 9 })
  });
  t.after(() => { proxy.close(); rmSync(dir, { recursive: true, force: true }); });
  const reply = await new Promise((res, rej) => {
    const c = net.createConnection(join(dir, 'proxy.sock'));
    let out = '';
    c.on('data', (d) => { out += d; });
    c.on('end', () => res(out));
    c.on('close', () => res(out));
    c.on('error', rej);
    c.write('CONNECT ab.chatgpt.com:443 HTTP/1.1\r\nHost: ab.chatgpt.com:443\r\n\r\n');
  });
  assert.match(reply, /^HTTP\/1\.[01] 403/);
  assert.deepEqual(denied, ['ab.chatgpt.com']);
});

const haveBwrap = existsSync(JAIL_BWRAP);

test('live codex: CODEX_HOME, linked sessions and login write; config and the rest of ~/.codex do not', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const run = (script) => spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/bin/sh', '-c', script]), { encoding: 'utf8' });
    const ok = (script) => { const res = run(script); assert.equal(res.status, 0, `${script}\n${res.stderr}`); };
    const fails = (script) => assert.notEqual(run(script).status, 0, `${script} should fail`);
    ok(`mkdir -p '${f.codexHome}/tmp/arg0' && touch '${f.codexHome}/state_5.sqlite' '${f.codexHome}/history.jsonl'`);
    ok(`mkdir -p '${f.codexHome}/sessions/2026/11/25' && touch '${f.codexHome}/sessions/2026/11/25/rollout.jsonl'`);
    ok(`touch '${f.codexHome}/archived_sessions/rollout.jsonl'`);
    ok(`printf '{"tokens":"new"}' > '${f.codexHome}/auth.json'`);
    ok(`cat '${f.codexHome}/config.toml' '${f.codexHome}/AGENTS.md' > /dev/null`);
    fails(`echo x >> '${f.codexHome}/config.toml'`);
    fails(`rm '${f.codexHome}/config.toml'`);
    fails(`echo x > '${f.userCodex}/config.toml'`);
    fails(`echo x > '${f.userCodex}/AGENTS.md'`);
    fails(`touch '${f.otherSessions}/planted.jsonl'`);
    fails(`touch '${f.userCodex}/sessions/planted.jsonl'`);
    assert.equal(readFileSync(join(f.userCodex, 'auth.json'), 'utf8'), '{"tokens":"new"}');
    assert.ok(existsSync(join(f.sessions, '2026', '11', '25', 'rollout.jsonl')));
    assert.equal(readFileSync(join(f.codexHome, 'config.toml'), 'utf8'), '[[hooks.PreToolUse]]\n');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

function codexBin() {
  try { return execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const codex = codexBin();

test('live codex: the CLI starts in the jail with its own home writable', { skip: (!haveBwrap && 'no bwrap') || (!codex && 'no codex CLI') }, () => {
  const f = fixture();
  try {
    const r = planFor(f, { runtimeDirs: [dirname(process.execPath)] });
    assert.equal(r.ok, true, r.error);
    const res = spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/usr/bin/env', `CODEX_HOME=${f.codexHome}`, codex, '--version']), { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /codex-cli \d/);
    assert.doesNotMatch(res.stderr, /Read-only file system/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
