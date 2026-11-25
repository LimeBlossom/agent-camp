'use strict';

// hive-sandbox-jail-ledger-readonly: inside the jail the harness-owned hive files are
// read-only, the app runtime the hook launcher execs stays visible, and the network is a
// private namespace whose only way out is the host's allowlisting proxy.
// Live tests run real bwrap over fixtures under /var/tmp (the jail's /tmp is a tmpfs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { join, dirname } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { jailPlan, jailArgv, JAIL_BWRAP, installJailNet, PROVIDER_NET_HOSTS } = loadTs('src/main/agentJail.ts');
const { startJailProxy } = loadTs('src/main/jailProxy.ts');

const ID = 'quince-test01';
const OTHER = 'willow-test02';
const haveBwrap = fs.existsSync(JAIL_BWRAP);
const LEDGER = ['tasks.json', 'board.md', 'fleet.json', 'registry.json', 'unity-hold.json', 'results-migration.json'];

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync('/var/tmp/jail-ledger-test-'));
  const home = join(base, 'home');
  const hive = join(base, 'hive');
  const agentDir = join(hive, 'agents', ID);
  const otherDir = join(hive, 'agents', OTHER);
  const scratchRoot = join(base, 'scratch');
  const runtime = join(base, 'runtime');
  for (const d of [join(home, '.gemini', 'antigravity-cli'), join(agentDir, 'inbox'), join(agentDir, 'outbox'),
    join(otherDir, 'inbox'), join(hive, 'bin'), join(hive, 'research'), join(hive, 'vault-inbox'),
    join(scratchRoot, ID), runtime]) fs.mkdirSync(d, { recursive: true });
  for (const f of LEDGER) fs.writeFileSync(join(hive, f), 'harness');
  fs.writeFileSync(join(agentDir, 'memory.md'), 'mine');
  fs.writeFileSync(join(otherDir, 'memory.md'), 'theirs');
  return { base, home, hive, agentDir, otherDir, scratchRoot, runtime };
}

function planFor(f, over = {}) {
  return jailPlan({
    provider: 'antigravity', agentId: ID, home: f.home, agentDir: f.agentDir, hiveRoot: f.hive,
    scratchRoot: f.scratchRoot, cwd: f.agentDir, extraWritable: [], runtimeDirs: [f.runtime], ...over
  });
}

function sh(plan, script) {
  return spawnSync(JAIL_BWRAP, jailArgv(plan, ['/bin/sh', '-c', script]), { encoding: 'utf8' });
}

/** Async run, so a proxy in this process can serve the jail while it runs. */
function shAsync(plan, script) {
  return new Promise((resolve) => {
    const c = spawn(JAIL_BWRAP, jailArgv(plan, ['/bin/sh', '-c', script]));
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
}

test('the hive root is no longer writable; own folder, research and vault-inbox are', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const w = r.plan.writable;
    assert.ok(!w.includes(f.hive), 'hive root not writable');
    for (const d of [f.agentDir, join(f.hive, 'research'), join(f.hive, 'vault-inbox')]) assert.ok(w.includes(d), `${d} writable`);
    assert.ok(!w.includes(f.otherDir), 'another agent folder not writable');
    assert.ok(!w.includes(join(f.hive, 'agents')), 'the agents folder itself not writable');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('missing research or vault-inbox folders are simply not bound', () => {
  const f = fixture();
  try {
    fs.rmSync(join(f.hive, 'vault-inbox'), { recursive: true });
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(!r.plan.writable.some((d) => d.endsWith('vault-inbox')));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('live: ledger files, other agents and new hive-root files are read-only; own folder, research, vault-inbox writable', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const ok = (s) => { const x = sh(r.plan, s); assert.equal(x.status, 0, `${s}\n${x.stderr}`); return x.stdout; };
    const fails = (s) => assert.notEqual(sh(r.plan, s).status, 0, `${s} should fail`);
    for (const file of LEDGER) {
      assert.equal(ok(`cat '${f.hive}/${file}'`), 'harness', `${file} readable`);
      fails(`echo x > '${f.hive}/${file}'`);
      fails(`echo x > '${f.hive}/${file}.tmp' && mv '${f.hive}/${file}.tmp' '${f.hive}/${file}'`);
      fails(`rm -f '${f.hive}/${file}' && test ! -e '${f.hive}/${file}'`);
    }
    fails(`touch '${f.hive}/new-root-file'`);
    fails(`echo x > '${f.otherDir}/memory.md'`);
    fails(`touch '${f.otherDir}/inbox/forged.json'`);
    fails(`mkdir '${f.hive}/agents/${ID}-twin'`);
    ok(`echo m > '${f.agentDir}/memory.md'`);
    ok(`printf '{}' > '${f.agentDir}/outbox/m.json.tmp' && mv '${f.agentDir}/outbox/m.json.tmp' '${f.agentDir}/outbox/m.json'`);
    ok(`touch '${f.agentDir}/inbox/.done-probe'`);
    ok(`echo r > '${f.hive}/research/note.md'`);
    ok(`echo v > '${f.hive}/vault-inbox/finding.md'`);
    for (const file of LEDGER) assert.equal(fs.readFileSync(join(f.hive, file), 'utf8'), 'harness', `${file} untouched on the host`);
    assert.equal(fs.readFileSync(join(f.otherDir, 'memory.md'), 'utf8'), 'theirs');
    assert.equal(fs.readFileSync(join(f.agentDir, 'outbox', 'm.json'), 'utf8'), '{}', 'the harness still reads the outbox');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('live: a harness atomic rewrite of tasks.json is visible in the jail (no stale file bind)', { skip: !haveBwrap && 'no bwrap' }, async () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const tasks = join(f.hive, 'tasks.json');
    const up = join(f.agentDir, 'jail-up');
    const go = join(f.agentDir, 'jail-go');
    const run = shAsync(r.plan, `touch '${up}'; i=0; while [ ! -f '${go}' ] && [ $i -lt 1000 ]; do sleep 0.02; i=$((i+1)); done; cat '${tasks}'`);
    for (let i = 0; i < 500 && !fs.existsSync(up); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(fs.existsSync(up), 'the jail started');
    fs.writeFileSync(`${tasks}.tmp-x`, 'rewritten');
    fs.renameSync(`${tasks}.tmp-x`, tasks);
    fs.writeFileSync(go, '');
    const x = await run;
    assert.equal(x.status, 0, x.stderr);
    assert.equal(x.stdout, 'rewritten');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('live: the hook socket in the read-only hive root still accepts connections', { skip: !haveBwrap && 'no bwrap' }, async () => {
  const f = fixture();
  const sock = join(f.hive, 'hooks.sock');
  let got = '';
  const srv = net.createServer((c) => c.on('data', (d) => { got += d; }));
  await new Promise((res) => srv.listen(sock, res));
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    const node = process.execPath;
    const x = await shAsync({ ...r.plan, readOnly: [...r.plan.readOnly, dirname(node)] },
      `'${node}' -e "const c=require('net').createConnection('${sock}',()=>c.end('hello'));c.on('error',e=>{console.error(e.message);process.exit(3)})"`);
    assert.equal(x.status, 0, x.stderr);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(got, 'hello');
  } finally { srv.close(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the app runtime the hook launcher execs is bound read-only; a missing one refuses the jail', () => {
  const f = fixture();
  try {
    const r = planFor(f);
    assert.equal(r.ok, true, r.error);
    assert.ok(r.plan.readOnly.includes(f.runtime));
    const missing = planFor(f, { runtimeDirs: [join(f.base, 'gone')] });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /gone/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('live: a runtime under /tmp (the AppImage mount) is visible past the jail tmpfs', { skip: !haveBwrap && 'no bwrap' }, () => {
  const f = fixture();
  const tmpRuntime = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), '.mount_jailtest-')));
  try {
    const exe = join(tmpRuntime, 'app');
    fs.writeFileSync(exe, '#!/bin/sh\necho runtime-ok\n', { mode: 0o755 });
    const r = planFor(f, { runtimeDirs: [tmpRuntime] });
    assert.equal(r.ok, true, r.error);
    const x = sh(r.plan, `'${exe}'`);
    assert.equal(x.status, 0, x.stderr);
    assert.equal(x.stdout.trim(), 'runtime-ok');
  } finally { fs.rmSync(tmpRuntime, { recursive: true, force: true }); fs.rmSync(f.base, { recursive: true, force: true }); }
});

// ─── network namespace + proxy ───────────────────────────────────────────────

test('provider hosts for antigravity are Google-only', () => {
  assert.ok(Array.isArray(PROVIDER_NET_HOSTS.antigravity) && PROVIDER_NET_HOSTS.antigravity.length > 0);
  for (const h of PROVIDER_NET_HOSTS.antigravity) assert.match(h, /(^|\.)(google|googleapis|gstatic|googleusercontent)\.com$/);
});

test('argv with a net plan unshares the network, binds the net dir read-only and wraps the command in the forwarder', () => {
  const plan = { writable: ['/w'], readOnly: [], hidden: [], cwd: '/c', net: { dir: '/n', node: '/r/node', proxyPort: 18080, loopbackPorts: [9876] } };
  const a = jailArgv(plan, ['/usr/bin/agy', '-i', 'x']);
  assert.ok(a.includes('--unshare-net'));
  assert.ok(a.some((x, i) => x === '--ro-bind' && a[i + 1] === '/n' && a[i + 2] === '/n'));
  const tail = a.slice(a.indexOf('--') + 1);
  assert.deepEqual(tail.slice(0, 2), ['/r/node', '/n/jail-net.cjs']);
  assert.deepEqual(tail.slice(tail.indexOf('--')), ['--', '/usr/bin/agy', '-i', 'x']);
  const noNet = jailArgv({ ...plan, net: undefined }, ['/usr/bin/agy']);
  assert.ok(!noNet.includes('--unshare-net'));
});

async function netFixture(t, { loopbackPorts = [] } = {}) {
  const f = fixture();
  const netDir = join(f.base, 'jail-net');
  fs.mkdirSync(netDir);
  installJailNet(netDir);
  const upstream = http.createServer((req, res) => res.end(`upstream ${req.method} ${req.url} host=${req.headers.host}`));
  await new Promise((res) => upstream.listen(0, '127.0.0.1', res));
  const upPort = upstream.address().port;
  const denied = [];
  const proxy = await startJailProxy({
    sock: join(netDir, 'proxy.sock'),
    allow: () => ['allowed.test'],
    loopbackPorts,
    onDeny: (host) => denied.push(host),
    // The fixture has no internet: every allowed host resolves to the local upstream.
    connectTo: (host, port) => (host === '127.0.0.1' ? { host, port } : { host: '127.0.0.1', port: upPort })
  });
  const r = planFor(f, { runtimeDirs: [f.runtime, dirname(process.execPath)], net: { dir: netDir, node: process.execPath, proxyPort: 18080, loopbackPorts } });
  assert.equal(r.ok, true, r.error);
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(f.base, { recursive: true, force: true }); });
  return { f, plan: r.plan, upPort, denied };
}

test('live: the jail cannot reach the host network directly', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const { plan, upPort } = await netFixture(t);
  const x = await shAsync(plan, `curl -sS --noproxy '*' -m 3 http://127.0.0.1:${upPort}/`);
  assert.notEqual(x.status, 0, `direct loopback reached the host: ${x.stdout}`);
  const y = await shAsync(plan, 'curl -sS --noproxy "*" -m 3 http://1.1.1.1/');
  assert.notEqual(y.status, 0, 'direct internet reached');
});

test('live: an allowed host goes through the proxy, plain HTTP and CONNECT', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const { plan, denied } = await netFixture(t);
  const x = await shAsync(plan, 'curl -sS -m 5 http://allowed.test/a');
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, /^upstream GET \/a host=allowed\.test/);
  const y = await shAsync(plan, 'curl -sS -m 5 -p http://sub.allowed.test:8443/b');
  assert.equal(y.status, 0, y.stderr);
  assert.match(y.stdout, /^upstream GET \/b/);
  assert.deepEqual(denied, []);
});

test('live: a host off the allowlist is refused with 403 and reported', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const { plan, denied } = await netFixture(t);
  const x = await shAsync(plan, 'curl -s -o /dev/null -w "%{http_code}" -m 5 http://evil.test/');
  assert.equal(x.stdout, '403');
  const y = await shAsync(plan, 'curl -sS -m 5 -p https://evil2.test/');
  assert.notEqual(y.status, 0);
  assert.deepEqual(denied, ['evil.test', 'evil2.test']);
});

test('live: listed loopback ports are forwarded to the host; others are not', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const svc = http.createServer((req, res) => res.end('blender-mcp'));
  await new Promise((res) => svc.listen(0, '127.0.0.1', res));
  const port = svc.address().port;
  t.after(() => svc.close());
  const { plan, upPort } = await netFixture(t, { loopbackPorts: [port] });
  const x = await shAsync(plan, `curl -sS --noproxy '*' -m 5 http://127.0.0.1:${port}/`);
  assert.equal(x.status, 0, x.stderr);
  assert.equal(x.stdout, 'blender-mcp');
  const y = await shAsync(plan, `curl -sS -m 5 -p http://127.0.0.1:${upPort}/`);
  assert.notEqual(y.status, 0, 'an unlisted loopback port is not reachable through the proxy');
});

test('live: the forwarder passes the command exit code through and fails closed without the proxy', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const { plan, f } = await netFixture(t);
  const x = await shAsync(plan, 'exit 7');
  assert.equal(x.status, 7);
  const ghost = join(f.base, 'ghost-net');
  fs.mkdirSync(ghost);
  installJailNet(ghost);
  const y = await shAsync({ ...plan, net: { ...plan.net, dir: ghost } }, 'curl -sS -m 3 http://allowed.test/ && echo LEAK');
  assert.ok(!y.stdout.includes('LEAK'));
});

/** Live layout: the scratch root is an absolute symlink (/media/.../.hive-scratch -> ~/.hive-scratch). */
function linkedScratch(f) {
  const realRoot = join(f.base, 'real-scratch');
  fs.mkdirSync(join(realRoot, ID), { recursive: true });
  const link = join(f.base, 'scratch-link');
  fs.symlinkSync(realRoot, link);
  const netDir = join(link, '.jail-net', ID);
  fs.mkdirSync(netDir, { recursive: true });
  installJailNet(netDir);
  return { link, realRoot, netDir };
}

test('a net dir reached through a symlinked scratch root is bound at its real path', () => {
  const f = fixture();
  try {
    const s = linkedScratch(f);
    const r = planFor(f, { scratchRoot: s.link, net: { dir: s.netDir, node: process.execPath, proxyPort: 18080, loopbackPorts: [] } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.plan.net.dir, join(s.realRoot, '.jail-net', ID));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a missing net dir refuses the jail rather than letting bwrap fail at spawn', () => {
  const f = fixture();
  try {
    const r = planFor(f, { net: { dir: join(f.base, 'no-such-net'), node: process.execPath, proxyPort: 18080, loopbackPorts: [] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /no-such-net/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('live: a jail whose net dir sits under a symlinked scratch root starts and runs its command', { skip: !haveBwrap && 'no bwrap' }, async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const s = linkedScratch(f);
  const proxy = await startJailProxy({ sock: join(s.netDir, 'proxy.sock'), allow: () => [], loopbackPorts: [], onDeny: () => {} });
  t.after(() => proxy.close());
  const r = planFor(f, { scratchRoot: s.link, runtimeDirs: [f.runtime, dirname(process.execPath)],
    net: { dir: s.netDir, node: process.execPath, proxyPort: 18080, loopbackPorts: [] } });
  assert.equal(r.ok, true, r.error);
  const x = await shAsync(r.plan, 'exit 7');
  assert.equal(x.status, 7, x.stderr);
});
