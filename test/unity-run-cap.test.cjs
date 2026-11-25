'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const {
  UnityBroker,
  listUnityProcesses,
  UNITY_MAX_CONCURRENT_DEFAULT,
  UNITY_AGENT_COOLDOWN_DEFAULT_SEC,
  UNITY_MACHINE_INSTANCE_LIMIT
} = loadTs('src/main/unityBroker.ts');

const linuxOnly = { skip: process.platform !== 'linux', timeout: 10_000 };

function tmp(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

// Stand-in bwrap runs the command after `--`; stand-in Unity waits for a release file, so
// a run stays "running" until the test lets it go.
function harness(t, deps = {}) {
  const home = tmp('md-unity-cap-');
  t.after(() => { fs.writeFileSync(release, ''); fs.rmSync(home, { recursive: true, force: true }); });
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
  fs.writeFileSync(bin, `#!/bin/sh\necho ran >> "${marker}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done\nexit 0\n`, { mode: 0o755 });
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

test('defaults: 2 concurrent agent runs, 300 s per-agent cooldown, 3 Unity instances on the machine', () => {
  assert.equal(UNITY_MAX_CONCURRENT_DEFAULT, 2);
  assert.equal(UNITY_AGENT_COOLDOWN_DEFAULT_SEC, 300);
  assert.equal(UNITY_MACHINE_INSTANCE_LIMIT, 3);
});

test('a 3rd concurrent run is deferred, left in the queue, and runs once a slot frees', linuxOnly, async (t) => {
  const h = harness(t, { agentCooldownSec: () => 0 });
  const p1 = h.broker.handle('a1', h.request('a1', h.projects[0]));
  const p2 = h.broker.handle('a2', h.request('a2', h.projects[1]));
  const f3 = h.request('a3', h.projects[2]);
  const third = await h.broker.handle('a3', f3);
  assert.equal(third.status, 'deferred');
  assert.match(third.reason, /2 agent Unity runs are running \(cap 2\)/);
  assert.equal(fs.existsSync(f3), true, 'the deferred request stays queued, not failed');
  assert.equal(fs.existsSync(path.join(path.dirname(f3), '.failed', path.basename(f3))), false);
  h.letGo();
  await Promise.all([p1, p2]);
  const again = await h.broker.handle('a3', f3);
  assert.equal(again.status, 'done');
  assert.equal(again.result.ok, true, JSON.stringify(again.result));
});

test('the cap is read at each request, so a config change applies with no restart', linuxOnly, async (t) => {
  const cfg = { max: 1 };
  const h = harness(t, { agentCooldownSec: () => 0, maxConcurrent: () => cfg.max });
  const p1 = h.broker.handle('a1', h.request('a1', h.projects[0]));
  const f2 = h.request('a2', h.projects[1]);
  const second = await h.broker.handle('a2', f2);
  assert.equal(second.status, 'deferred');
  assert.match(second.reason, /cap 1/);
  cfg.max = 2;
  const p2 = h.broker.handle('a2', f2);
  await h.waitRan(2);
  h.letGo();
  assert.equal((await p1).result.ok, true);
  assert.equal((await p2).result.ok, true);
});

test('Unity already running on the machine (the editor included) defers a run that would make 4', linuxOnly, async (t) => {
  const procs = { list: [{ pid: 100, projectPath: '/home/user/GameA' }, { pid: 101, projectPath: '/other/agent/proj' }] };
  const h = harness(t, { agentCooldownSec: () => 0, unityProcesses: () => procs.list });
  const p1 = h.broker.handle('a1', h.request('a1', h.projects[0]));
  await h.waitRan(1);
  // The broker's own run shows up as a Unity process too; it must not count twice.
  procs.list = [...procs.list, { pid: 102, projectPath: h.projects[0] }];
  const f2 = h.request('a2', h.projects[1]);
  const second = await h.broker.handle('a2', f2);
  assert.equal(second.status, 'deferred');
  assert.match(second.reason, /3 Unity instances are already running on this machine \(limit 3\)/);
  assert.equal(fs.existsSync(f2), true, 'deferred, not rejected');
  h.letGo();
  await p1;
});

test('with one outside Unity the machine limit still allows both agent slots', linuxOnly, async (t) => {
  const h = harness(t, { agentCooldownSec: () => 0, unityProcesses: () => [{ pid: 100, projectPath: '/home/user/GameA' }] });
  const p1 = h.broker.handle('a1', h.request('a1', h.projects[0]));
  const p2 = h.broker.handle('a2', h.request('a2', h.projects[1]));
  await h.waitRan(2);
  h.letGo();
  assert.equal((await p1).result.ok, true);
  assert.equal((await p2).result.ok, true);
});

test('a second request from the same agent inside the cooldown defers, naming the time left', linuxOnly, async (t) => {
  const h = harness(t);
  h.letGo();
  const first = await h.broker.handle('a1', h.request('a1', h.projects[0]));
  assert.equal(first.result.ok, true);
  h.clock.now += 100_000;
  const f2 = h.request('a1', h.projects[1]);
  const second = await h.broker.handle('a1', f2);
  assert.equal(second.status, 'deferred');
  assert.match(second.reason, /cooldown/);
  assert.match(second.reason, /200 ?s/, 'names the seconds left');
  assert.equal(fs.existsSync(f2), true);
  const other = await h.broker.handle('a2', h.request('a2', h.projects[2]));
  assert.equal(other.result.ok, true, 'the cooldown is per agent');
  h.clock.now += 201_000;
  const third = await h.broker.handle('a1', f2);
  assert.equal(third.status, 'done');
  assert.equal(third.result.ok, true);
});

test('a deferred request tells its agent once, not on every tick', linuxOnly, async (t) => {
  const h = harness(t);
  h.letGo();
  await h.broker.handle('a1', h.request('a1', h.projects[0]));
  const before = h.notes.length;
  const f2 = h.request('a1', h.projects[1]);
  await h.broker.handle('a1', f2);
  await h.broker.handle('a1', f2);
  await h.broker.handle('a1', f2);
  const deferNotes = h.notes.slice(before);
  assert.equal(deferNotes.length, 1, JSON.stringify(deferNotes));
  assert.equal(deferNotes[0].id, 'a1');
  assert.match(deferNotes[0].body, /cooldown/);
  assert.match(deferNotes[0].body, /queued|waits|wait/i);
});

test('the unity hold still fails a request outright, even when the cap would defer it', linuxOnly, async (t) => {
  const h = harness(t, { agentCooldownSec: () => 0 });
  const p1 = h.broker.handle('a1', h.request('a1', h.projects[0]));
  const p2 = h.broker.handle('a2', h.request('a2', h.projects[1]));
  fs.writeFileSync(path.join(h.hive, 'unity-hold.json'), JSON.stringify({ reason: 'review', since: '2026-11-21T05:00:00Z' }));
  const held = await h.broker.handle('a3', h.request('a3', h.projects[2]));
  assert.equal(held.status, 'done');
  assert.equal(held.result.reason, 'unity-hold: review');
  h.letGo();
  await Promise.all([p1, p2]);
});

test('Unity asset import workers are not counted as editors', (t) => {
  const proc = tmp('md-unity-proc-cap-');
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const fake = (pid, comm, argv) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'comm'), comm + '\n');
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
  };
  fake(20, 'Unity', ['/opt/Unity', '-projectPath', '/p']);
  fake(21, 'Unity', ['/opt/Unity', '-batchMode', '-projectPath', '/p', '-name', 'AssetImportWorker0']);
  assert.deepEqual(listUnityProcesses(proc).map((p) => p.pid), [20]);
});

test('PROTOCOL.md tells workers to batch tests into one Unity run and not rerun a passing one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const start = src.indexOf('const PROTOCOL_MD = `');
  const proto = src.slice(start, start + src.slice(start).search(/[^\\]`;/));
  assert.match(proto, /## Unity runs/);
  assert.match(proto, /one run/i);
  assert.match(proto, /passing/i);
});

test('config exposes unityMaxConcurrent and unityAgentCooldownSec, and main passes them to the broker', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8');
  assert.match(cfg, /unityMaxConcurrent\?: number/);
  assert.match(cfg, /unityAgentCooldownSec\?: number/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /maxConcurrent: \(\) => readConfig\(\)\.unityMaxConcurrent/);
  assert.match(main, /agentCooldownSec: \(\) => readConfig\(\)\.unityAgentCooldownSec/);
});
