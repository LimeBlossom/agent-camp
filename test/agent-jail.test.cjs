'use strict';

// hive-sandbox-2: a per-agent bubblewrap jail around the agent's whole CLI process.
// The live tests run real bwrap over fixture folders under /var/tmp (the jail's own
// /tmp is a private tmpfs, so fixtures there would be hidden from the jailed shell).

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, withJail, isJailed, JAIL_BWRAP } = loadTs('src/main/agentJail.ts');

const ID = 'quince-test01';

function fixture() {
  const base = realpathSync(mkdtempSync('/var/tmp/agent-jail-test-'));
  const home = join(base, 'home');
  const project = join(base, 'projects', 'Game');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const scratchRoot = join(base, 'scratch');
  const worktree = join(scratchRoot, ID, 'Game-wt');
  for (const d of [join(home, '.ssh'), join(home, '.gemini', 'antigravity-cli'), project,
    join(agentDir, 'unity-requests'), join(agentDir, 'outbox'), join(hive, 'bin'), worktree,
    join(scratchRoot, ID, 'unity-results')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'hooks.json'), '{}');
  writeFileSync(join(project, 'README.md'), 'project file');
  writeFileSync(join(hive, 'bin', 'agy-hook.cjs'), '// shim');
  spawnSync('git', ['init', '-q', project]);
  return { base, home, project, hive, agentDir, scratchRoot, worktree };
}

function planFor(f, over = {}) {
  return jailPlan({
    provider: 'antigravity', agentId: ID, home: f.home, agentDir: f.agentDir, hiveRoot: f.hive,
    scratchRoot: f.scratchRoot, cwd: f.project, extraWritable: [], runtimeDirs: [], ...over
  });
}

test('the plan writes only the agent folder, its scratch folder and agy state', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const w = r.plan.writable;
    for (const d of [f.agentDir, join(f.scratchRoot, ID), join(f.home, '.gemini', 'antigravity-cli')]) {
      assert.ok(w.includes(d), `${d} writable`);
    }
    assert.ok(!w.includes(f.project), 'a project cwd stays read-only');
    assert.ok(!w.some((d) => f.home === d), 'home itself is not writable');
    assert.ok(r.plan.readOnly.includes(join(f.hive, 'bin')), 'hook shims stay read-only');
    assert.ok(r.plan.readOnly.includes(join(f.home, '.gemini', 'antigravity-cli', 'hooks.json')));
    assert.ok(r.plan.hidden.includes(join(f.home, '.ssh')));
    assert.ok(!w.includes(f.hive), 'the hive root is read-only (jail-ledger-readonly)');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a cwd inside the agent scratch folder gets its git dirs so it can commit', () => {
  const f = fixture();
  try {
    const g = (...a) => spawnSync('git', ['-C', f.project, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
    g('add', 'README.md'); g('commit', '-q', '-m', 'init');
    assert.equal(g('worktree', 'add', '-q', '--detach', join(f.scratchRoot, ID, 'wt2')).status, 0);
    const r = planFor(f, { cwd: join(f.scratchRoot, ID, 'wt2') });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.plan.writable.includes(join(f.project, '.git')), 'common git dir writable');
    if (existsSync(JAIL_BWRAP)) {
      const wt = join(f.scratchRoot, ID, 'wt2');
      const res = spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/bin/sh', '-c',
        `echo y > '${wt}/new.txt' && git -C '${wt}' add new.txt && git -C '${wt}' -c user.name=t -c user.email=t@t commit -q -m jailed`]), { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(spawnSync('git', ['-C', wt, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim(), 'jailed');
    }
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('a provider the jail has no state map for is refused, never run unjailed', () => {
  const f = fixture();
  try {
    const r = planFor(f, { provider: 'grok' });
    assert.equal(r.ok, false);
    assert.match(r.error, /grok/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('argv order: read-only root first, writable binds, read-only overlays, hidden, then the command', () => {
  const plan = { writable: ['/w'], readOnly: ['/w/bin'], hidden: ['/h/.ssh'], cwd: '/c' };
  const a = jailArgv(plan, ['/usr/bin/agy', '-i', 'multi\nline']);
  assert.deepEqual(a.slice(0, 3), ['--ro-bind', '/', '/']);
  const at = (flag, p) => a.findIndex((x, i) => x === flag && a[i + 1] === p);
  assert.ok(at('--bind', '/w') > 0);
  assert.ok(at('--ro-bind', '/w/bin') > at('--bind', '/w'), 'overlay after its writable parent');
  assert.ok(at('--tmpfs', '/h/.ssh') > at('--ro-bind', '/w/bin'));
  assert.ok(a.includes('--die-with-parent'));
  assert.deepEqual(a.slice(a.indexOf('--chdir'), a.indexOf('--chdir') + 2), ['--chdir', '/c']);
  assert.deepEqual(a.slice(a.lastIndexOf('--')), ['--', '/usr/bin/agy', '-i', 'multi\nline']);
});

test('withJail wraps the resolved file in bwrap; no plan leaves it untouched', () => {
  const plan = { writable: [], readOnly: [], hidden: [], cwd: '/c' };
  const r = withJail('/usr/bin/agy', ['-i', 'x'], plan);
  assert.equal(r.file, JAIL_BWRAP);
  assert.deepEqual(r.args.slice(-4), ['--', '/usr/bin/agy', '-i', 'x']);
  const args = ['-i', 'x'];
  const n = withJail('/usr/bin/agy', args, undefined);
  assert.equal(n.file, '/usr/bin/agy');
  assert.equal(n.args, args);
});

test('config: sandboxedAgents unset jails nobody; it names agents one by one', () => {
  assert.equal(isJailed({ sandboxedAgents: ['quince-mulcpt5f'] }, 'quince-mulcpt5f'), true);
  assert.equal(isJailed({ sandboxedAgents: ['quince-mulcpt5f'] }, 'willow-x'), false);
  assert.equal(isJailed({}, 'quince-mulcpt5f'), false);
});

const haveBwrap = existsSync(JAIL_BWRAP);

function runJailed(f, plan, script) {
  return spawnSync(JAIL_BWRAP, jailArgv(plan, ['/bin/sh', '-c', script]).slice(0), { encoding: 'utf8' });
}

test('live: reads work, scratch and own-folder writes work, hive-root, project and home writes fail, ssh keys hidden', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const ok = (script) => {
      const res = runJailed(f, r.plan, script);
      assert.equal(res.status, 0, `${script}\n${res.stderr}`);
      return res.stdout;
    };
    const fails = (script) => {
      const res = runJailed(f, r.plan, script);
      assert.notEqual(res.status, 0, `${script} should fail`);
    };
    assert.equal(ok(`cat '${f.project}/README.md'`), 'project file');
    ok(`git -C '${f.project}' status --short`);
    ok(`touch '${f.worktree}/edit.txt'`);
    ok(`touch '${f.agentDir}/outbox/m.json'`);
    fails(`touch '${f.hive}/research-note.md'`);
    ok(`touch '${f.home}/.gemini/antigravity-cli/state.db'`);
    fails(`touch '${f.project}/ILLEGAL.txt'`);
    fails(`touch '${f.home}/ILLEGAL.txt'`);
    fails(`touch '${f.hive}/bin/agy-hook.cjs'`);
    fails(`echo x > '${f.home}/.gemini/antigravity-cli/hooks.json'`);
    assert.equal(ok(`ls -A '${f.home}/.ssh'`), '');
    fails(`cat '${f.home}/.ssh/id_ed25519'`);
    assert.equal(existsSync(join(f.project, 'ILLEGAL.txt')), false);
    assert.equal(readFileSync(join(f.home, '.ssh', 'id_ed25519'), 'utf8'), 'PRIVATE KEY', 'host key untouched');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test('live: a Unity request written in the jail reaches the broker outside, and results come back in', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const req = join(f.agentDir, 'unity-requests', 'probe.json');
    const res = runJailed(f, r.plan, `printf '{"project":"x"}' > '${req}.tmp' && mv '${req}.tmp' '${req}'`);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(req, 'utf8'), '{"project":"x"}', 'the broker sees the request on the host');
    const resultDir = join(f.scratchRoot, ID, 'unity-results', 'probe');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, 'result.json'), '{"ok":true}');
    const back = runJailed(f, r.plan, `cat '${resultDir}/result.json'`);
    assert.equal(back.stdout, '{"ok":true}');
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
