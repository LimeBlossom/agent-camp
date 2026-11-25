'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { UnityBroker, unityHoldReason, UNITY_HOLD_FILE } = loadTs('src/main/unityBroker.ts');
const { CAMP_MCP_TOOLS, handleCampMcpCall } = loadTs('src/main/campTools.ts');

const linuxOnly = { skip: process.platform !== 'linux' };

function tmp(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

// Same stand-ins as unity-broker.test.cjs: a bwrap that runs the command after `--` and a
// Unity that leaves a marker, so "Unity never started" is a file check.
function harness(t) {
  const displays = { started: 0 };
  const home = tmp('md-unity-hold-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = path.join(home, 'hive');
  const ws = path.join(home, 'ws');
  const proj = path.join(ws, 'Game');
  fs.mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.11f1\n');
  const queue = path.join(hive, 'agents', 'a1', 'unity-requests');
  fs.mkdirSync(queue, { recursive: true });
  const bwrap = path.join(home, 'bwrap');
  fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  const bin = path.join(home, 'Editor', '6000.3.11f1', 'Editor', 'Unity');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const marker = path.join(home, 'unity-ran');
  fs.writeFileSync(bin, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  const notes = [];
  const logs = [];
  const broker = new UnityBroker({
    hiveRoot: () => hive,
    agent: (id) => (id === 'a1' ? { unity: true, cwd: ws, extraDirs: [] } : null),
    notify: (id, subject, body) => notes.push({ id, subject, body }),
    log: (e) => logs.push(e),
    editorRoot: () => path.join(home, 'Editor'),
    bwrapPath: bwrap,
    home: path.join(home, 'userhome'),
    killGraceSec: 1,
    agentCooldownSec: () => 0,
    unityProcesses: () => [],
    startDisplay: async () => {
      displays.started++;
      return { display: 42, socket: '/nonexistent/X42', stop: async () => {} };
    }
  });
  const request = (name) => {
    const f = path.join(queue, name);
    fs.writeFileSync(f, JSON.stringify({ project: proj, args: ['-quit'] }));
    return f;
  };
  const hold = (body) => fs.writeFileSync(path.join(hive, 'unity-hold.json'), typeof body === 'string' ? body : JSON.stringify(body));
  const unhold = () => fs.rmSync(path.join(hive, 'unity-hold.json'), { force: true });
  const ranCount = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').length : 0);
  return { hive, queue, broker, notes, logs, request, hold, unhold, ranCount, displays };
}

test('the hold file lives at <hive>/unity-hold.json', () => {
  assert.equal(UNITY_HOLD_FILE, 'unity-hold.json');
});

test('a hold refuses the run: no Unity, a failed unity-run event, and an inform naming the hold', linuxOnly, async (t) => {
  const h = harness(t);
  h.hold({ reason: 'The human license review', since: '2026-11-21T01:37:00Z' });
  const out = await h.broker.handle('a1', h.request('held.json'));
  assert.equal(out.status, 'done');
  assert.equal(out.result.ok, false);
  assert.equal(out.result.reason, 'unity-hold: The human license review');
  assert.equal(h.ranCount(), 0, 'Unity never started');
  assert.equal(h.displays.started, 0, 'no private display either');
  assert.deepEqual(h.logs.map((e) => e.kind), ['unity-run'], 'no unity-run-start');
  assert.equal(h.logs[0].ok, false);
  assert.equal(h.logs[0].reason, 'unity-hold: The human license review');
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].id, 'a1');
  assert.match(h.notes[0].body, /unity-hold: The human license review/);
  assert.match(h.notes[0].body, /2026-11-21T01:37:00Z/, 'the inform says since when');
  assert.equal(fs.existsSync(path.join(h.queue, '.failed', 'held.json')), true);
});

test('without a hold file the run proceeds as today', linuxOnly, async (t) => {
  const h = harness(t);
  const out = await h.broker.handle('a1', h.request('free.json'));
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(h.ranCount(), 1);
});

test('the hold is read at each request: set, then cleared, with no restart', linuxOnly, async (t) => {
  const h = harness(t);
  h.hold({ reason: 'pause', since: '2026-11-21T00:00:00Z' });
  assert.equal((await h.broker.handle('a1', h.request('one.json'))).result.ok, false);
  h.unhold();
  assert.equal((await h.broker.handle('a1', h.request('two.json'))).result.ok, true);
  h.hold({ reason: 'again', since: '2026-11-21T00:05:00Z' });
  assert.equal((await h.broker.handle('a1', h.request('three.json'))).result.reason, 'unity-hold: again');
  assert.equal(h.ranCount(), 1);
});

test('an allow list lets the named agent run and still holds everyone else', linuxOnly, async (t) => {
  const h = harness(t);
  h.hold({ reason: 'pause', since: '2026-11-21T00:00:00Z', allow: ['a1'] });
  assert.equal((await h.broker.handle('a1', h.request('allowed.json'))).result.ok, true);
  assert.equal(unityHoldReason(h.hive, 'a2'), 'unity-hold: pause');
  assert.equal(unityHoldReason(h.hive, 'a1'), null);
});

test('an unreadable hold file holds every run rather than letting them through', (t) => {
  const hive = tmp('md-unity-hold-bad-');
  t.after(() => fs.rmSync(hive, { recursive: true, force: true }));
  assert.equal(unityHoldReason(hive, 'a1'), null, 'no file, no hold');
  fs.writeFileSync(path.join(hive, 'unity-hold.json'), '{not json');
  assert.match(unityHoldReason(hive, 'a1'), /^unity-hold: .*unity-hold\.json/);
  fs.writeFileSync(path.join(hive, 'unity-hold.json'), JSON.stringify({ since: '2026-11-21T00:00:00Z' }));
  assert.match(unityHoldReason(hive, 'a1'), /^unity-hold: /, 'a hold with no reason still holds');
});

// ── The Boss's camp tool ──────────────────────────────────────────────

function bossHive(t) {
  const hive = tmp('md-unity-hold-tool-');
  t.after(() => fs.rmSync(hive, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'boss1', agents: { boss1: { isGod: true }, w1: {} } }));
  return hive;
}
const call = (hive, agentId, args) => handleCampMcpCall('unity_hold', args, { hiveRoot: hive, agentId, outboxDir: path.join(hive, 'outbox-' + agentId) });

test('unity_hold is a camp tool', () => {
  const tool = CAMP_MCP_TOOLS.find((x) => x.name === 'unity_hold');
  assert.ok(tool, 'unity_hold listed');
  assert.deepEqual(tool.inputSchema.required, ['action']);
});

test('the Boss sets a hold with a reason and an allow list, then clears it', (t) => {
  const hive = bossHive(t);
  const file = path.join(hive, 'unity-hold.json');
  const set = call(hive, 'boss1', { action: 'set', reason: 'license review', allow: ['w1'] });
  assert.ok(!set.isError, JSON.stringify(set));
  const held = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(held.reason, 'license review');
  assert.deepEqual(held.allow, ['w1']);
  assert.ok(!Number.isNaN(Date.parse(held.since)), 'since is a timestamp');
  assert.equal(unityHoldReason(hive, 'other'), 'unity-hold: license review');
  const clear = call(hive, 'boss1', { action: 'clear' });
  assert.ok(!clear.isError, JSON.stringify(clear));
  assert.equal(fs.existsSync(file), false);
  assert.equal(unityHoldReason(hive, 'other'), null);
});

test('unity_hold refuses a worker, a set with no reason and an unknown action', (t) => {
  const hive = bossHive(t);
  const file = path.join(hive, 'unity-hold.json');
  assert.equal(call(hive, 'w1', { action: 'set', reason: 'x' }).isError, true);
  assert.equal(fs.existsSync(file), false, 'a worker cannot set a hold');
  fs.writeFileSync(file, JSON.stringify({ reason: 'kept', since: '2026-11-21T00:00:00Z' }));
  assert.equal(call(hive, 'w1', { action: 'clear' }).isError, true);
  assert.equal(fs.existsSync(file), true, 'a worker cannot clear one');
  assert.equal(call(hive, 'boss1', { action: 'set' }).isError, true);
  assert.equal(call(hive, 'boss1', { action: 'pause' }).isError, true);
});

test('PROTOCOL-BOSS.md names the unity_hold tool', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const boss = src.slice(src.indexOf('function protocolBossMarkdown'));
  assert.match(boss, /\\?`unity_hold\\?`/);
});
