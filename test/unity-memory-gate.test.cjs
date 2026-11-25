'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const {
  UnityBroker,
  listUnityProcesses,
  UNITY_MAX_CONCURRENT_DEFAULT,
  UNITY_AGENT_COOLDOWN_DEFAULT_SEC,
  UNITY_MACHINE_INSTANCE_LIMIT,
  UNITY_MIN_MEM_AVAILABLE_GB_DEFAULT,
  UNITY_MAX_MEM_PSI_AVG10_DEFAULT
} = loadTs('src/main/unityBroker.ts');

const linuxOnly = { skip: process.platform !== 'linux', timeout: 10_000 };

function tmp(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

// Stand-in bwrap runs the command after `--`; stand-in Unity waits for a release file, so
// a run stays "running" until the test lets it go.
function harness(t, deps = {}) {
  const home = tmp('md-unity-mem-');
  // Let stubs go, wait for them to exit BEFORE removing the home (a stub that sees its dir
  // vanish would otherwise spin forever and hold a real broker machine-instance slot), then
  // kill stragglers and assert none survive.
  t.after(async () => {
    fs.writeFileSync(release, '');
    const alive = () => spawnSync('pgrep', ['-f', home]).status === 0;
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    const leaked = alive();
    if (leaked) spawnSync('pkill', ['-9', '-f', home]);
    fs.rmSync(home, { recursive: true, force: true });
    assert.equal(leaked, false, 'stub Unity processes outlived the test');
  });
  const hive = path.join(home, 'hive');
  const ws = path.join(home, 'ws');
  const projects = ['G1', 'G2', 'G3', 'G4'].map((n) => {
    const p = path.join(ws, n);
    fs.mkdirSync(path.join(p, 'ProjectSettings'), { recursive: true });
    fs.writeFileSync(path.join(p, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.11f1\n');
    return p;
  });
  const agents = ['a1', 'a2', 'a3', 'a4'];
  for (const a of agents) fs.mkdirSync(path.join(hive, 'agents', a, 'unity-requests'), { recursive: true });
  const bwrap = path.join(home, 'bwrap');
  fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  const bin = path.join(home, 'Editor', '6000.3.11f1', 'Editor', 'Unity');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const release = path.join(home, 'release');
  const marker = path.join(home, 'unity-ran');
  fs.writeFileSync(bin, `#!/bin/sh\necho ran >> "${marker}"\nwhile [ ! -f "${release}" ]; do [ -d "${home}" ] || exit 0; sleep 0.05; done\nexit 0\n`, { mode: 0o755 });
  const notes = [];
  const logs = [];
  const clock = { now: Date.parse('2026-11-21T05:00:00Z') };
  const broker = new UnityBroker({
    hiveRoot: () => hive,
    agent: (id) => (agents.includes(id) ? { unity: true, cwd: ws, extraDirs: [] } : null),
    notify: (id, subject, body) => notes.push({ id, subject, body }),
    log: (e) => logs.push(e),
    editorRoot: () => path.join(home, 'Editor'),
    bwrapPath: bwrap,
    home: path.join(home, 'userhome'),
    killGraceSec: 1,
    startDisplay: async () => ({ display: 42, socket: '/nonexistent/X42', stop: async () => {} }),
    now: () => clock.now,
    unityProcesses: () => [],
    ...deps
  });
  let n = 0;
  const request = (agent, project) => {
    const f = path.join(hive, 'agents', agent, 'unity-requests', `r${++n}.json`);
    fs.writeFileSync(f, JSON.stringify({ project, args: ['-quit'] }));
    return f;
  };
  const ranCount = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0);
  const waitRan = async (k) => {
    for (let i = 0; i < 200 && ranCount() < k; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ranCount(), k, `${k} Unity runs started`);
  };
  const letGo = () => fs.writeFileSync(release, '');
  return { home, hive, projects, broker, notes, logs, clock, request, ranCount, waitRan, letGo };
}


// Raw /proc text, as the kernel prints it. The broker parses these; tests inject them.
const GB_KB = 1024 * 1024;
const meminfo = (availGb) => `MemTotal:       32616704 kB\nMemFree:         1000000 kB\nMemAvailable:   ${Math.round(availGb * GB_KB)} kB\nBuffers:          100000 kB\n`;
const psi = (avg10) => `some avg10=${avg10.toFixed(2)} avg60=1.00 avg300=0.50 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1234\n`;
const ample = { readMeminfo: () => meminfo(20), readMemoryPressure: () => psi(0) };

test('defaults: hold under 8 GB MemAvailable or memory PSI some avg10 over 10', () => {
  assert.equal(UNITY_MIN_MEM_AVAILABLE_GB_DEFAULT, 8);
  assert.equal(UNITY_MAX_MEM_PSI_AVG10_DEFAULT, 10);
});

test('MemAvailable under the threshold defers, leaves the request queued, and names value and threshold', linuxOnly, async (t) => {
  const h = harness(t, { ...ample, readMeminfo: () => meminfo(5.2) });
  h.letGo();
  const f = h.request('a1', h.projects[0]);
  const out = await h.broker.handle('a1', f);
  assert.equal(out.status, 'deferred');
  assert.match(out.reason, /MemAvailable 5\.2 GB < 8 GB/);
  assert.equal(fs.existsSync(f), true, 'deferred, not failed');
  assert.equal(fs.existsSync(path.join(path.dirname(f), '.failed', path.basename(f))), false);
  assert.equal(h.ranCount(), 0, 'Unity never started');
});

test('memory PSI some avg10 over the threshold defers, naming value and threshold', linuxOnly, async (t) => {
  const h = harness(t, { ...ample, readMemoryPressure: () => psi(14.2) });
  h.letGo();
  const f = h.request('a1', h.projects[0]);
  const out = await h.broker.handle('a1', f);
  assert.equal(out.status, 'deferred');
  assert.match(out.reason, /PSI some avg10 14\.2 > 10/);
  assert.equal(fs.existsSync(f), true);
  assert.equal(h.ranCount(), 0);
});

test('the agent is told once why its request waits, quoting the measured value', linuxOnly, async (t) => {
  const h = harness(t, { ...ample, readMeminfo: () => meminfo(5.2) });
  h.letGo();
  const f = h.request('a1', h.projects[0]);
  await h.broker.handle('a1', f);
  await h.broker.handle('a1', f);
  assert.equal(h.notes.length, 1, JSON.stringify(h.notes));
  assert.match(h.notes[0].body, /MemAvailable 5\.2 GB < 8 GB/);
});

test('starts when both signals clear, and a deferred request is released once memory recovers', linuxOnly, async (t) => {
  const mem = { gb: 5.2 };
  const h = harness(t, { ...ample, readMeminfo: () => meminfo(mem.gb) });
  h.letGo();
  const f = h.request('a1', h.projects[0]);
  assert.equal((await h.broker.handle('a1', f)).status, 'deferred');
  mem.gb = 12;
  h.letGo();
  const out = await h.broker.handle('a1', f);
  assert.equal(out.status, 'done');
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
});

test('exactly at the thresholds does not hold (below / above only)', linuxOnly, async (t) => {
  const h = harness(t, { readMeminfo: () => meminfo(8), readMemoryPressure: () => psi(10) });
  h.letGo();
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'done');
});

test('the existing cooldown and cap checks answer before the memory gate', linuxOnly, async (t) => {
  const h = harness(t, { ...ample, readMeminfo: () => meminfo(1), maxConcurrent: () => 0 });
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'deferred');
  assert.match(out.reason, /cap 0/);
});

test('a reader that throws never blocks a run: it logs a warning and falls back to the existing checks', linuxOnly, async (t) => {
  const h = harness(t, {
    readMeminfo: () => { throw new Error('ENOENT: /proc/meminfo'); },
    readMemoryPressure: () => { throw new Error('ENOENT: /proc/pressure/memory'); }
  });
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'done');
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.ok(h.logs.some((e) => /warn/i.test(String(e.kind)) && /mem/i.test(JSON.stringify(e))), JSON.stringify(h.logs));
});

test('unparseable /proc text is treated like a reader error, not as zero memory', linuxOnly, async (t) => {
  const h = harness(t, { readMeminfo: () => 'garbage\n', readMemoryPressure: () => '' });
  h.letGo();
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'done');
});

test('one failing reader leaves the other signal in force', linuxOnly, async (t) => {
  const h = harness(t, { readMeminfo: () => { throw new Error('boom'); }, readMemoryPressure: () => psi(30) });
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'deferred');
  assert.match(out.reason, /PSI some avg10 30(\.0)? > 10/);
});

test('config thresholds are read at each request and override the defaults', linuxOnly, async (t) => {
  const cfg = { gb: 4, psi: 50 };
  const h = harness(t, {
    agentCooldownSec: () => 0,
    readMeminfo: () => meminfo(5.2), readMemoryPressure: () => psi(14.2),
    minMemAvailableGb: () => cfg.gb, maxMemPressureAvg10: () => cfg.psi
  });
  h.letGo();
  h.letGo();
  const first = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(first.status, 'done', 'loosened thresholds let 5.2 GB / PSI 14.2 start');
  cfg.gb = 6;
  const f2 = h.request('a2', h.projects[1]);
  const second = await h.broker.handle('a2', f2);
  assert.equal(second.status, 'deferred');
  assert.match(second.reason, /MemAvailable 5\.2 GB < 6 GB/);
  cfg.gb = 4; cfg.psi = 12;
  const third = await h.broker.handle('a2', f2);
  assert.equal(third.status, 'deferred');
  assert.match(third.reason, /PSI some avg10 14\.2 > 12/);
});

test('a threshold of 0 disables that signal', linuxOnly, async (t) => {
  const h = harness(t, { readMeminfo: () => meminfo(0.5), readMemoryPressure: () => psi(99),
    minMemAvailableGb: () => 0, maxMemPressureAvg10: () => 0 });
  h.letGo();
  h.letGo();
  const out = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(out.status, 'done');
});

test('config exposes the two thresholds, and main passes them to the broker', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '../src/main/config.ts'), 'utf8');
  assert.match(cfg, /unityMinMemAvailableGb\?: number/);
  assert.match(cfg, /unityMaxMemPressureAvg10\?: number/);
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(main, /minMemAvailableGb: \(\) => readConfig\(\)\.unityMinMemAvailableGb/);
  assert.match(main, /maxMemPressureAvg10: \(\) => readConfig\(\)\.unityMaxMemPressureAvg10/);
});
