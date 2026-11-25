'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const {
  UnityBroker,
  buildUnityArgs,
  earlyoomJournalArgs,
  findOnPath,
  parseDisplayLine,
  pickDisplayServer,
  startPrivateDisplay,
  unityCommand,
  unityEnv,
  unityPromptText,
  bwrapArgv,
  audioMounts,
  checkExecuteMethod,
  clampTimeoutSec,
  filterUnityEnv,
  isInside,
  listUnityProcesses,
  projectBusyReason,
  sharedLibraryReason,
  clearSandboxPidFiles,
  resolveProjectInWorkspace,
  unityEditorFor,
  unityUserDirs,
  playerPrefsDir,
  unityResultsBase,
  testRunProblem
} = loadTs('src/main/unityBroker.ts');

function tmp(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

function unityProject(dir, version = '6000.3.11f1') {
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${version}\n`);
  return dir;
}

test('isInside accepts the folder itself and below it, never a sibling with a shared prefix', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a', '/a/b'), false);
});

test('a project inside cwd or an extra folder is accepted as its real path', (t) => {
  const ws = tmp('md-unity-ws-');
  const extra = tmp('md-unity-extra-');
  t.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(extra, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(ws, 'Game'));
  fs.mkdirSync(path.join(extra, 'Other'));
  assert.deepEqual(resolveProjectInWorkspace(path.join(ws, 'Game'), ws, []), { ok: true, value: path.join(ws, 'Game') });
  assert.deepEqual(resolveProjectInWorkspace('Game', ws, []), { ok: true, value: path.join(ws, 'Game') }, 'relative resolves against cwd');
  assert.deepEqual(resolveProjectInWorkspace(path.join(extra, 'Other'), ws, [extra]), { ok: true, value: path.join(extra, 'Other') });
});

test('a symlink out of the workspace, a ".." escape and a missing folder are refused', (t) => {
  const ws = tmp('md-unity-ws-');
  const outside = tmp('md-unity-out-');
  t.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(ws, 'link'));
  const viaLink = resolveProjectInWorkspace(path.join(ws, 'link'), ws, []);
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.reason, /outside this agent's workspace/);
  const dotdot = resolveProjectInWorkspace(path.join(ws, '..', path.basename(outside)), ws, []);
  assert.equal(dotdot.ok, false);
  assert.match(dotdot.reason, /outside/);
  assert.equal(resolveProjectInWorkspace('../' + path.basename(outside), ws, []).ok, false);
  assert.match(resolveProjectInWorkspace(path.join(ws, 'nope'), ws, []).reason, /does not exist/);
  assert.match(resolveProjectInWorkspace(undefined, ws, []).reason, /missing "project"/);
});

test('the editor comes from ProjectVersion.txt under the editor root', (t) => {
  const root = tmp('md-unity-hub-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = unityProject(path.join(root, 'proj'));
  assert.match(unityEditorFor(proj, path.join(root, 'Editor')).reason, /Unity 6000\.3\.11f1 is not installed/);
  const bin = path.join(root, 'Editor', '6000.3.11f1', 'Editor', 'Unity');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  assert.deepEqual(unityEditorFor(proj, path.join(root, 'Editor')), { ok: true, value: { version: '6000.3.11f1', editor: bin } });
  assert.match(unityEditorFor(root, path.join(root, 'Editor')).reason, /not a Unity project/);
  unityProject(path.join(root, 'evil'), '../../x');
  assert.equal(unityEditorFor(path.join(root, 'evil'), path.join(root, 'Editor')).ok, false);
});

test('executeMethod must be a dotted identifier', () => {
  assert.deepEqual(checkExecuteMethod('ProbeUI.Run'), { ok: true, value: 'ProbeUI.Run' });
  assert.deepEqual(checkExecuteMethod(undefined), { ok: true, value: undefined });
  for (const bad of ['1Bad', 'A.B;rm', 'A B', '', '-quit', 3]) assert.equal(checkExecuteMethod(bad).ok, false, String(bad));
});

test('args: allowlisted flags pass, -testResults is forced into the results folder', () => {
  const rd = '/hive/agents/a/unity-results/r1';
  assert.deepEqual(buildUnityArgs(undefined, rd), { ok: true, value: [] });
  assert.deepEqual(
    buildUnityArgs(['-runTests', '-testPlatform', 'EditMode', '-testFilter', 'Foo.Bar', '-testCategory', 'Fast',
      '-assemblyNames', 'Game.Tests', '-buildTarget', 'Linux64', '-nographics', '-quit'], rd).value,
    ['-runTests', '-testPlatform', 'EditMode', '-testFilter', 'Foo.Bar', '-testCategory', 'Fast',
      '-assemblyNames', 'Game.Tests', '-buildTarget', 'Linux64', '-nographics', '-quit']);
  assert.deepEqual(buildUnityArgs(['-testResults', '/etc/evil.xml'], rd).value, ['-testResults', path.join(rd, 'evil.xml')]);
  assert.deepEqual(buildUnityArgs(['-testResults', '../../x/../r.xml'], rd).value, ['-testResults', path.join(rd, 'r.xml')]);
  assert.deepEqual(buildUnityArgs(['-testResults', '-quit'], rd).value, ['-testResults', path.join(rd, 'test-results.xml'), '-quit']);
  assert.deepEqual(buildUnityArgs(['-testResults'], rd).value, ['-testResults', path.join(rd, 'test-results.xml')]);
});

test('args: anything off the allowlist, a missing value or a non-string rejects the request', () => {
  const rd = '/r';
  for (const bad of [
    ['-projectPath', '/x'], ['-logFile', '/tmp/x'], ['-executeMethod', 'A.B'], ['-batchmode'],
    ['-buildTarget'], ['-testFilter', '-quit'], ['-testPlatform', ''], ['-openfile', 'x'], ['--', 'x'], ['-quit', 3]
  ]) {
    const r = buildUnityArgs(bad, rd);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.reason, 'string');
  }
  assert.equal(buildUnityArgs('-quit', rd).ok, false);
});

test('env: UPPER_CASE string pairs pass; loader, sandbox, Unity and harness keys are refused', () => {
  assert.deepEqual(filterUnityEnv(undefined), { ok: true, value: {} });
  assert.deepEqual(filterUnityEnv({ PROBE_MODE: 'hud', X1: '' }), { ok: true, value: { PROBE_MODE: 'hud', X1: '' } });
  for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH', 'HOME', 'DISPLAY', 'XAUTHORITY', 'UNITY_FOO', 'BWRAP_X', 'MD_UNITY_OUT']) {
    assert.match(filterUnityEnv({ [k]: 'x' }).reason, /not allowed/, k);
  }
  assert.equal(filterUnityEnv({ lower: 'x' }).ok, false);
  assert.equal(filterUnityEnv({ '1X': 'x' }).ok, false);
  assert.equal(filterUnityEnv({ N: 3 }).ok, false);
  assert.equal(filterUnityEnv(['A']).ok, false);
});

test('timeout defaults to 600 and is clamped to 1..3600', () => {
  assert.equal(clampTimeoutSec(undefined), 600);
  assert.equal(clampTimeoutSec('60'), 600);
  assert.equal(clampTimeoutSec(-5), 600);
  assert.equal(clampTimeoutSec(0), 600);
  assert.equal(clampTimeoutSec(Infinity), 600);
  assert.equal(clampTimeoutSec(120), 120);
  assert.equal(clampTimeoutSec(0.2), 1);
  assert.equal(clampTimeoutSec(99999), 3600);
});

test('a running Unity on the project, or a lock file while Unity runs, makes the project busy', (t) => {
  const proc = tmp('md-unity-proc-');
  const proj = tmp('md-unity-proj-');
  t.after(() => { fs.rmSync(proc, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); });
  const fake = (pid, comm, argv) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'comm'), comm + '\n');
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0');
  };
  fake(10, 'Unity', ['/opt/Unity', '-batchmode', '-projectPath', proj]);
  fake(11, 'bwrap', ['bwrap', '--', '/opt/Unity', '-projectPath', '/other']);
  fake(13, 'unityhub-unity-', ['/opt/unityhub-unity-editor-6000.3.11f1', '-projectpath', '/hubproj']);
  const procs = listUnityProcesses(proc);
  assert.deepEqual(procs, [{ pid: 10, projectPath: proj }, { pid: 13, projectPath: '/hubproj' }], 'Hub-launched editors count too');
  assert.match(projectBusyReason(proj, procs), /pid 10/);
  assert.equal(projectBusyReason('/elsewhere', procs), null);
  fs.mkdirSync(path.join(proj, 'Temp'));
  fs.writeFileSync(path.join(proj, 'Temp', 'UnityLockfile'), '');
  const other = [{ pid: 12, projectPath: '/other' }];
  assert.match(projectBusyReason(proj, other), /UnityLockfile exists/);
  assert.equal(projectBusyReason(proj, []), null, 'a stale lock with no Unity alive is not busy');
  assert.equal(fs.existsSync(path.join(proj, 'Temp', 'UnityLockfile')), true, 'the lock file is never deleted');
});

test('bwrap argv binds only the project, results and Unity user dirs writable', () => {
  const argv = bwrapArgv({
    project: '/p', resultsDir: '/r', userDirs: unityUserDirs('/home/u', true),
    gpuNodes: ['/dev/dri', '/dev/nvidia0'], x11Socket: '/tmp/.X11-unix/X7', unshareNet: true, command: ['/U', '-batchmode']
  });
  const binds = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--bind') binds.push(argv[i + 1]);
  assert.deepEqual(binds, ['/tmp/.X11-unix/X7', '/p', '/r', '/home/u/.config/unity3d', '/home/u/.local/share/unity3d', '/home/u/.cache/unity3d']);
  assert.deepEqual(argv.slice(0, 4), ['--ro-bind', '/', '/', '--dev']);
  assert.ok(argv.includes('--die-with-parent'));
  assert.ok(argv.includes('--unshare-net'));
  assert.ok(!argv.includes('/tmp/.X11-unix'), 'never the whole socket directory');
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['/U', '-batchmode']);
  assert.equal(unityUserDirs('/home/u', false)[2], '/home/u/.cache');
});

test('bwrap argv covers the sound-server sockets so Unity plays no audio', () => {
  const argv = bwrapArgv({
    project: '/p', resultsDir: '/r', userDirs: [], gpuNodes: [], x11Socket: null, unshareNet: true,
    audioSockets: ['/run/user/1000/pipewire-0'], audioDirs: ['/run/user/1000/pulse'], command: ['/U']
  });
  const i = argv.indexOf('/run/user/1000/pipewire-0');
  assert.deepEqual(argv.slice(i - 2, i + 1), ['--ro-bind', '/dev/null', '/run/user/1000/pipewire-0']);
  const j = argv.indexOf('/run/user/1000/pulse');
  assert.equal(argv[j - 1], '--tmpfs');
  assert.deepEqual(audioMounts(undefined), { audioSockets: [], audioDirs: [] });
  const env = unityEnv({ PULSE_SERVER: 'unix:/run/user/1000/pulse/native' }, {}, 7, '/out');
  assert.equal(env.PULSE_SERVER, 'unix:/nonexistent');
  assert.equal(env.PIPEWIRE_REMOTE, '/nonexistent');
});

// End-to-end through handle() with a stand-in bwrap (runs the command after `--`) and a
// stand-in Unity, so the queue, results, archive, inbox and log paths run for real.
function harness(t, { unity = true, unityScript, displayError, resultsRoot, journal } = {}) {
  const displays = { started: 0, stopped: 0 };
  const home = tmp('md-unity-e2e-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = path.join(home, 'hive');
  const ws = path.join(home, 'ws');
  const proj = unityProject(path.join(ws, 'Game'));
  const queue = path.join(hive, 'agents', 'a1', 'unity-requests');
  fs.mkdirSync(queue, { recursive: true });
  const bwrap = path.join(home, 'bwrap');
  fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
  const bin = path.join(home, 'Editor', '6000.3.11f1', 'Editor', 'Unity');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, unityScript ?? '#!/bin/sh\necho "fake unity $* DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY" > "$6"\necho png > "$MD_UNITY_OUT/shot.png"\nexit 0\n', { mode: 0o755 });
  const notes = [];
  const logs = [];
  const broker = new UnityBroker({
    hiveRoot: () => hive,
    agent: (id) => (id === 'a1' ? { unity, cwd: ws, extraDirs: [] } : null),
    notify: (id, subject, body) => notes.push({ id, subject, body }),
    log: (e) => logs.push(e),
    editorRoot: () => path.join(home, 'Editor'),
    resultsRoot: resultsRoot && (() => resultsRoot(home)),
    bwrapPath: bwrap,
    home: path.join(home, 'userhome'),
    killGraceSec: 1,
    agentCooldownSec: () => 0,
    unityProcesses: () => [],
    ...(journal ? { earlyoomJournal: journal } : {}),
    startDisplay: async () => {
      if (displayError) return { error: displayError };
      displays.started++;
      return { display: 42, socket: '/nonexistent/X42', stop: async () => { displays.stopped++; } };
    }
  });
  const request = (name, body) => {
    const f = path.join(queue, name);
    fs.writeFileSync(f, JSON.stringify(body));
    return f;
  };
  return { home, hive, ws, proj, queue, broker, notes, logs, request, displays };
}

test('a valid request runs, lists its outputs, archives to .done and tells the agent', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t);
  const f = h.request('r1.json', { project: h.proj, executeMethod: 'ProbeUI.Run', args: ['-quit'], env: { PROBE: '1' } });
  const out = await h.broker.handle('a1', f);
  assert.equal(out.status, 'done');
  const resDir = path.join(h.hive, 'agents', 'a1', 'unity-results', 'r1');
  const result = JSON.parse(fs.readFileSync(path.join(resDir, 'result.json'), 'utf8'));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.outputs, ['shot.png']);
  assert.equal(result.logPath, path.join(resDir, 'unity.log'));
  const log = fs.readFileSync(result.logPath, 'utf8');
  assert.match(log, new RegExp(`-batchmode -force-vulkan -projectPath ${h.proj} -logFile .*-executeMethod ProbeUI.Run -quit`));
  assert.match(log, /DISPLAY=:42 XAUTHORITY=$/m, 'Unity sees only the private display, no X cookie');
  assert.deepEqual(h.displays, { started: 1, stopped: 1 });
  assert.equal(fs.existsSync(path.join(h.queue, '.done', 'r1.json')), true);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].id, 'a1');
  assert.match(h.notes[0].body, /result\.json/);
  assert.deepEqual(h.logs.map((e) => e.kind), ['unity-run-start', 'unity-run']);
});

test('Burst and ILPP pid files are cleared before a run and the run leaves none behind', { skip: process.platform !== 'linux' }, async (t) => {
  // Stand-in for Burst SIGKILLing the stored pid: a pid file present at start is fatal.
  const h = harness(t, { unityScript: '#!/bin/sh\n[ -e "$4/Library/burst.pid" ] && exit 137\n[ -e "$4/Library/ilpp.pid" ] && exit 137\nmkdir -p "$4/Library"\necho 305 > "$4/Library/burst.pid"\necho 335 > "$4/Library/ilpp.pid"\nexit 0\n' });
  fs.mkdirSync(path.join(h.proj, 'Library'), { recursive: true });
  fs.writeFileSync(path.join(h.proj, 'Library', 'burst.pid'), '304');
  fs.writeFileSync(path.join(h.proj, 'Library', 'ilpp.pid'), '334');
  for (const id of ['p1', 'p2']) {
    const out = await h.broker.handle('a1', h.request(`${id}.json`, { project: h.proj, args: ['-quit'] }));
    assert.equal(out.status, 'done');
    const result = JSON.parse(fs.readFileSync(path.join(h.hive, 'agents', 'a1', 'unity-results', id, 'result.json'), 'utf8'));
    assert.equal(result.exitCode, 0, `${id}: ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(path.join(h.proj, 'Library', 'burst.pid')), false, `${id} left burst.pid`);
    assert.equal(fs.existsSync(path.join(h.proj, 'Library', 'ilpp.pid')), false, `${id} left ilpp.pid`);
  }
  assert.deepEqual(clearSandboxPidFiles(h.proj), [], 'nothing left to clear');
});

test('a rejected request gets a result with a plain reason and lands in .failed', async (t) => {
  const h = harness(t);
  const f = h.request('bad.json', { project: h.proj, args: ['-projectPath', '/etc'] });
  const out = await h.broker.handle('a1', f);
  assert.equal(out.result.ok, false);
  assert.match(out.result.reason, /argument "-projectPath" is not allowed/);
  assert.equal(fs.existsSync(path.join(h.queue, '.failed', 'bad.json')), true);
  assert.equal(h.notes.length, 1);
  const outside = h.request('out.json', { project: os.tmpdir() });
  assert.match((await h.broker.handle('a1', outside)).result.reason, /outside this agent's workspace/);
});

test('a Library hardlinked to another tree (cp -al) is refused before Unity starts', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { unityScript: '#!/bin/sh\ntouch "$4/unity-ran"\nexit 0\n' });
  const lib = path.join(h.proj, 'Library');
  fs.mkdirSync(path.join(lib, 'Artifacts'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'SourceAssetDB'), 'lmdb');
  fs.writeFileSync(path.join(lib, 'ArtifactDB'), 'lmdb');
  assert.equal(sharedLibraryReason(h.proj), null, 'a real copy passes');
  const other = path.join(h.ws, 'Other', 'Library');
  fs.cpSync(lib, other, { recursive: true });
  assert.equal(sharedLibraryReason(h.proj), null, 'cp -a style copy shares nothing');
  fs.rmSync(path.join(other, 'SourceAssetDB'));
  fs.linkSync(path.join(lib, 'SourceAssetDB'), path.join(other, 'SourceAssetDB'));
  assert.match(sharedLibraryReason(h.proj), /hardlinked to another tree \(SourceAssetDB have/);
  const out = await h.broker.handle('a1', h.request('lnk.json', { project: h.proj, args: ['-quit'] }));
  assert.equal(out.result.ok, false);
  assert.match(out.result.reason, /hardlinked to another tree.*cp -a --reflink=auto/);
  assert.equal(fs.existsSync(path.join(h.proj, 'unity-ran')), false, 'Unity never ran');
  assert.equal(fs.existsSync(path.join(h.queue, '.failed', 'lnk.json')), true);
  assert.equal(sharedLibraryReason(path.join(h.ws, 'NoLibrary')), null, 'no Library is not a refusal');
});

test('the Unity flag off rejects, whatever the file says about who asked', async (t) => {
  const h = harness(t, { unity: false });
  const f = h.request('r.json', { project: h.proj, agentId: 'someone-else', unity: true });
  const out = await h.broker.handle('a1', f);
  assert.match(out.result.reason, /Unity broker is off/);
});

test('a run past its timeout has its process group killed', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { unityScript: '#!/bin/sh\nsleep 30 &\nsleep 30\n' });
  const f = h.request('slow.json', { project: h.proj, timeoutSec: 1 });
  const started = Date.now();
  const out = await h.broker.handle('a1', f);
  assert.equal(out.result.ok, false);
  assert.match(out.result.reason, /timed out after 1s/);
  assert.ok(Date.now() - started < 10000, 'the group died on SIGTERM, well before the sleeps');
  assert.deepEqual(h.displays, { started: 1, stopped: 1 }, 'the display goes down on timeout too');
});

test('a second request on a busy project waits in the queue', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { unityScript: '#!/bin/sh\nsleep 1\n' });
  const a = h.broker.handle('a1', h.request('a.json', { project: h.proj }));
  const second = h.request('b.json', { project: h.proj });
  const b = await h.broker.handle('a1', second);
  assert.equal(b.status, 'deferred');
  assert.equal(fs.existsSync(second), true);
  await a;
});

test('Unity always gets -batchmode and -force-vulkan from the harness', () => {
  assert.deepEqual(unityCommand('/U', '/p', '/l', 'A.B', ['-quit']),
    ['/U', '-batchmode', '-force-vulkan', '-projectPath', '/p', '-logFile', '/l', '-executeMethod', 'A.B', '-quit']);
  assert.deepEqual(unityCommand('/U', '/p', '/l', undefined, []), ['/U', '-batchmode', '-force-vulkan', '-projectPath', '/p', '-logFile', '/l']);
  assert.equal(buildUnityArgs(['-force-vulkan'], '/r').ok, false, 'not an agent-supplied flag');
  assert.match(unityPromptText('/q', '/r'), /-force-vulkan/);
});

test('Unity env: private DISPLAY wins, the X cookie and Wayland socket are dropped', () => {
  const env = unityEnv({ DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', KEEP: '1' }, { PROBE: 'x' }, 7, '/out');
  assert.equal(env.DISPLAY, ':7');
  assert.equal('XAUTHORITY' in env, false);
  assert.equal('WAYLAND_DISPLAY' in env, false);
  assert.equal(env.KEEP, '1');
  assert.equal(env.PROBE, 'x');
  assert.equal(env.MD_UNITY_OUT, '/out');
  assert.equal(unityEnv({}, { LBS_NO_TELEMETRY: '0' }, 7, '/out').LBS_NO_TELEMETRY, '1', 'games stay silent');
});

test('the display helper line parses, and display :0 is never accepted', () => {
  assert.deepEqual(parseDisplayLine('DISPLAY 3 1234\n'), { ok: true, display: 3, serverPid: 1234 });
  assert.match(parseDisplayLine('DISPLAY 0 1234').reason, /:0/);
  assert.deepEqual(parseDisplayLine('ERROR python3-xlib is not installed'), { ok: false, reason: 'python3-xlib is not installed' });
  assert.equal(parseDisplayLine('garbage').ok, false);
  assert.equal(parseDisplayLine('').ok, false);
});

test('Xvfb is preferred over Xephyr when both are on PATH', (t) => {
  const a = tmp('md-unity-path-a-');
  const b = tmp('md-unity-path-b-');
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(a, 'Xephyr'), '', { mode: 0o755 });
  assert.equal(pickDisplayServer(`${a}:${b}`), path.join(a, 'Xephyr'));
  fs.writeFileSync(path.join(b, 'Xvfb'), '', { mode: 0o755 });
  assert.equal(pickDisplayServer(`${a}:${b}`), path.join(b, 'Xvfb'));
  fs.writeFileSync(path.join(a, 'notexec'), '', { mode: 0o644 });
  assert.equal(findOnPath('notexec', a), null);
  assert.equal(pickDisplayServer(''), null);
});

test('no private display means no run: the request fails and Unity never starts', async (t) => {
  const h = harness(t, { displayError: 'neither Xvfb nor Xephyr is installed', unityScript: '#!/bin/sh\ntouch "$MD_UNITY_OUT/ran"\n' });
  const out = await h.broker.handle('a1', h.request('nod.json', { project: h.proj }));
  assert.equal(out.result.ok, false);
  assert.match(out.result.reason, /could not start a private display, so Unity was not run: neither Xvfb nor Xephyr/);
  assert.deepEqual(out.result.outputs, []);
});

test('the real helper reports a server that never made its socket, and leaves nothing running', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = tmp('md-unity-helper-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { UNITY_DISPLAY_HELPER } = loadTs('src/main/unityDisplayHelper.ts');
  const helper = path.join(dir, 'unity-display.py');
  fs.writeFileSync(helper, UNITY_DISPLAY_HELPER);
  // A stand-in "Xvfb": reports display 98765 on -displayfd, then idles like a server.
  const server = path.join(dir, 'Xvfb');
  fs.writeFileSync(server, '#!/bin/sh\nfd=$2\necho 98765 >&$fd\nexec sleep 60\n', { mode: 0o755 });
  const r = await startPrivateDisplay(helper, server, process.env, 10);
  assert.match(r.error, /display :98765 has no socket/);
  const left = require('node:child_process').spawnSync('pgrep', ['-f', server]).stdout.toString().trim();
  await new Promise((res) => setTimeout(res, 500));
  const after = require('node:child_process').spawnSync('pgrep', ['-f', server]).stdout.toString().trim();
  assert.equal(after, '', `stand-in server still running (${left})`);
});

test('each run gets a private PlayerPrefs folder laid over the shared one', () => {
  const settings = 'PlayerSettings:\n  companyName: DefaultCompany\n  productName: SphereSurvivors\n';
  assert.equal(playerPrefsDir('/home/me', settings), '/home/me/.config/unity3d/DefaultCompany/SphereSurvivors');
  assert.equal(playerPrefsDir('/home/me', '  companyName: ../x\n  productName: Game\n'), null, 'a path-like name is refused');
  assert.equal(playerPrefsDir('/home/me', 'nothing here'), null);
  const argv = bwrapArgv({ project: '/p', resultsDir: '/r', userDirs: ['/home/me/.config/unity3d'], gpuNodes: [], x11Socket: null, unshareNet: true,
    overlays: [{ src: '/r/player-prefs', dst: '/home/me/.config/unity3d/DefaultCompany/SphereSurvivors' }], command: ['unity'] });
  const user = argv.indexOf('/home/me/.config/unity3d');
  const over = argv.indexOf('/r/player-prefs');
  assert.ok(user > 0 && over > user, 'the overlay is bound after the shared user dir, so it wins');
  assert.equal(argv[over + 1], '/home/me/.config/unity3d/DefaultCompany/SphereSurvivors');
});

test('with a scratch root, results land under <root>/<agent>/unity-results, not the hive', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { resultsRoot: (home) => path.join(home, 'scratch') });
  const out = await h.broker.handle('a1', h.request('r1.json', { project: h.proj, args: ['-quit'] }));
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(out.resultPath, path.join(h.home, 'scratch', 'a1', 'unity-results', 'r1', 'result.json'));
  assert.deepEqual(out.result.outputs, ['shot.png']);
  assert.equal(fs.existsSync(path.join(h.hive, 'agents', 'a1', 'unity-results')), false);
});

test('a scratch root that cannot be created falls back to the agent folder', () => {
  const home = tmp('md-unity-base-');
  try {
    const blocker = path.join(home, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    assert.equal(unityResultsBase('/hive/agents/a1', 'a1', path.join(blocker, 'scratch')), '/hive/agents/a1/unity-results');
    assert.equal(unityResultsBase('/hive/agents/a1', 'a1', null), '/hive/agents/a1/unity-results');
    assert.equal(unityResultsBase('/hive/agents/a1', 'a1', path.join(home, 's')), path.join(home, 's', 'a1', 'unity-results'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a scratch root reached through a symlink binds and reports its real path', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { resultsRoot: (home) => path.join(home, 'scratch-link') });
  const real = path.join(h.home, 'scratch-real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(h.home, 'scratch-link'));
  const argLog = path.join(h.home, 'bwrap-args');
  fs.writeFileSync(path.join(h.home, 'bwrap'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argLog}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const out = await h.broker.handle('a1', h.request('r1.json', { project: h.proj, args: ['-quit'] }));
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  const resDir = path.join(real, 'a1', 'unity-results', 'r1');
  assert.equal(out.resultPath, path.join(resDir, 'result.json'));
  const argv = fs.readFileSync(argLog, 'utf8').split('\n');
  const i = argv.findIndex((a, k) => a === '--bind' && argv[k + 1] === resDir);
  assert.notEqual(i, -1, `bwrap binds ${resDir}: ${argv.join(' ')}`);
  assert.equal(argv[i + 2], resDir);
  assert.equal(argv.some((a) => a.includes('scratch-link')), false, 'no bwrap arg names the symlink');
  assert.equal(unityResultsBase('/hive/agents/a1', 'a1', path.join(h.home, 'scratch-link'), false), path.join(real, 'a1', 'unity-results'),
    'the prompt path agents see matches where results land');
});

test('an existing results name in the scratch root, symlink or not, is never reused', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { resultsRoot: (home) => path.join(home, 'scratch') });
  const elsewhere = path.join(h.home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(h.home, 'scratch', 'a1', 'unity-results'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(h.home, 'scratch', 'a1', 'unity-results', 'r1'));
  const out = await h.broker.handle('a1', h.request('r1.json', { project: h.proj }));
  assert.equal(out.result.ok, true, 'an existing name gets a fresh -2 folder, never the symlink');
  assert.match(out.resultPath, /unity-results\/r1-2\/result\.json$/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a results folder that cannot be made releases the project instead of holding it until restart', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.hive, 'agents', 'a1', 'unity-results'), 'not a folder');
  const first = await h.broker.handle('a1', h.request('r1.json', { project: h.proj }));
  assert.equal(first.status, 'deferred');
  assert.match(first.reason, /could not prepare the results folder/);
  const second = await h.broker.handle('a1', h.request('r2.json', { project: h.proj }));
  assert.doesNotMatch(second.reason ?? '', /holds/);
});

// A -runTests run whose filter matched nothing exits 0 with no results.xml (or total="0");
// that must not read as green.
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n';
function runTestsResult(t, xml) {
  // $6 is the log path; results.xml goes where -testResults points (the arg after it).
  const script = '#!/bin/sh\necho log > "$6"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-testResults" ]; then OUT="$2"; fi; shift; done\n'
    + (xml === null ? '' : `cat > "$OUT" <<'XMLEOF'\n${xml}\nXMLEOF\n`) + 'exit 0\n';
  return harness(t, { unityScript: script });
}
async function runTests(h, id, args) {
  const out = await h.broker.handle('a1', h.request(`${id}.json`, { project: h.proj, args }));
  return out.result;
}
const RUN_ARGS = ['-runTests', '-testPlatform', 'EditMode', '-testFilter', 'Ns.Foo', '-quit'];

test('testRunProblem: only -runTests requests are judged', () => {
  assert.equal(testRunProblem(['-quit'], '/nonexistent'), null);
  assert.equal(testRunProblem(undefined, '/nonexistent'), null);
  assert.match(testRunProblem(['-runTests', '-quit'], '/nonexistent'), /no tests ran/);
});

test('-runTests with no results.xml is ok:false "no tests ran"', { skip: process.platform !== 'linux' }, async (t) => {
  const r = await runTests(runTestsResult(t, null), 'z1', RUN_ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 0);
  assert.match(r.reason, /^no tests ran/);
  assert.match(r.reason, /namespace-qualified/);
});

test('-runTests whose <test-run> total is 0 is ok:false "no tests ran"', { skip: process.platform !== 'linux' }, async (t) => {
  const r = await runTests(runTestsResult(t, XML_HEAD + '<test-run id="2" testcasecount="0" result="Passed" total="0" passed="0" failed="0">'), 'z2', RUN_ARGS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no tests ran/);
});

test('-runTests that ran tests stays ok', { skip: process.platform !== 'linux' }, async (t) => {
  const r = await runTests(runTestsResult(t, XML_HEAD + '<test-run id="2" testcasecount="3" result="Passed" total="3" passed="3" failed="0">'), 'z3', RUN_ARGS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, undefined);
});

test('-runTests with an explicit -testResults name is judged by that file', { skip: process.platform !== 'linux' }, async (t) => {
  const h = runTestsResult(t, XML_HEAD + '<test-run total="2" passed="2">');
  const r = await runTests(h, 'z4', ['-runTests', '-testResults', 'mine.xml', '-quit']);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.outputs.includes('mine.xml'), true);
});

test('a failing exit code keeps its own reason on a -runTests run', { skip: process.platform !== 'linux' }, async (t) => {
  const h = harness(t, { unityScript: '#!/bin/sh\necho log > "$6"\nexit 2\n' });
  const r = await runTests(h, 'z5', RUN_ARGS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Unity exited with code 2/);
});

test('a non-runTests request with no results.xml is unaffected', { skip: process.platform !== 'linux' }, async (t) => {
  const r = await runTests(harness(t), 'z6', ['-quit']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

// earlyoom (-m 10 --prefer Unity) SIGTERMs batch Unity mid-import; the broker must say so,
// not "the -testFilter matched nothing". Contract: BrokerDeps.earlyoomJournal(sinceMs) returns
// the system journal text since that epoch-ms (the app runs `journalctl --since`); the broker
// asks only when a -runTests run ends without results or with a non-zero exit/signal.
const OOM_LINE = 'Nov 23 19:31:02 devbox earlyoom[1432]: sending SIGTERM to process 88123 uid 1000 "Unity": oom_score 812, VmRSS 11204 MiB, cgroup /user.slice';
const OOM_REASON = /killed by earlyoom \(low memory\)/;
function unityScriptThat(tail, xml) {
  return '#!/bin/sh\necho log > "$6"\nwhile [ $# -gt 0 ]; do if [ "$1" = "-testResults" ]; then OUT="$2"; fi; shift; done\n'
    + (xml ? `cat > "$OUT" <<'XMLEOF'\n${xml}\nXMLEOF\n` : '') + tail + '\n';
}
function journalStub(text) {
  const calls = [];
  const fn = async (sinceMs) => { calls.push(sinceMs); if (text instanceof Error) throw text; return text; };
  fn.calls = calls;
  return fn;
}
function assertEarlyoom(r) {
  assert.equal(r.ok, false);
  assert.match(r.reason, OOM_REASON);
  assert.match(r.reason, /not a test failure/);
  assert.match(r.reason, /retry when memory is free/);
  assert.ok(r.reason.includes('sending SIGTERM to process 88123'), `reason quotes the journal line: ${r.reason}`);
  assert.doesNotMatch(r.reason, /matched nothing|namespace-qualified/);
}
const LINUX = { skip: process.platform !== 'linux' };

test('earlyoom: Unity killed by SIGTERM with an earlyoom journal line reports earlyoom', LINUX, async (t) => {
  const j = journalStub(OOM_LINE + '\n');
  const h = harness(t, { unityScript: unityScriptThat('kill -TERM $$'), journal: j });
  assertEarlyoom(await runTests(h, 'o1', RUN_ARGS));
});

test('earlyoom: Unity exiting 143 (SIGTERM through bwrap) with an earlyoom line reports earlyoom', LINUX, async (t) => {
  const h = harness(t, { unityScript: unityScriptThat('exit 143'), journal: journalStub(OOM_LINE) });
  const r = await runTests(h, 'o2', RUN_ARGS);
  assertEarlyoom(r);
  assert.equal(r.exitCode, 143);
});

test('earlyoom: a graceful exit 0 with no results.xml but an earlyoom line still reports earlyoom (the scorp-edit-2 case)', LINUX, async (t) => {
  const h = harness(t, { unityScript: unityScriptThat('exit 0'), journal: journalStub(OOM_LINE) });
  assertEarlyoom(await runTests(h, 'o3', RUN_ARGS));
});

test('earlyoom: SIGKILL lines count too', LINUX, async (t) => {
  const line = OOM_LINE.replace('SIGTERM', 'SIGKILL');
  const h = harness(t, { unityScript: unityScriptThat('kill -KILL $$'), journal: journalStub(line) });
  const r = await runTests(h, 'o4', RUN_ARGS);
  assert.match(r.reason, OOM_REASON);
  assert.ok(r.reason.includes('sending SIGKILL'));
});

test('earlyoom: the journal is asked from this run\'s start, not from the epoch', LINUX, async (t) => {
  const j = journalStub(OOM_LINE);
  const h = harness(t, { unityScript: unityScriptThat('exit 0'), journal: j });
  const before = Date.now();
  await runTests(h, 'o5', RUN_ARGS);
  assert.equal(j.calls.length, 1);
  assert.ok(j.calls[0] >= before - 1000 && j.calls[0] <= Date.now(), `sinceMs ${j.calls[0]} is the run start`);
});

test('no earlyoom line: exit 0 with no results.xml still says the filter matched nothing', LINUX, async (t) => {
  const h = harness(t, { unityScript: unityScriptThat('exit 0'), journal: journalStub('Nov 23 19:31:02 host kernel: unrelated\n') });
  const r = await runTests(h, 'n1', RUN_ARGS);
  assert.match(r.reason, /^no tests ran: the -testFilter matched nothing/);
  assert.doesNotMatch(r.reason, /earlyoom/);
});

test('no earlyoom line: exit 0 with total="0" still says the filter matched nothing', LINUX, async (t) => {
  const xml = XML_HEAD + '<test-run total="0" passed="0" failed="0"></test-run>';
  const h = harness(t, { unityScript: unityScriptThat('exit 0', xml), journal: journalStub('') });
  assert.match((await runTests(h, 'n2', RUN_ARGS)).reason, /matched nothing/);
});

test('no earlyoom line: a SIGTERM kill keeps "Unity was killed by SIGTERM" and never claims earlyoom', LINUX, async (t) => {
  const h = harness(t, { unityScript: unityScriptThat('kill -TERM $$'), journal: journalStub('') });
  const r = await runTests(h, 'n3', RUN_ARGS);
  assert.match(r.reason, /killed by SIGTERM|exited with code 143/);
  assert.doesNotMatch(r.reason, /earlyoom|matched nothing/);
});

test('an earlyoom line for some other process does not blame earlyoom for an empty filter result', LINUX, async (t) => {
  const other = 'Nov 23 19:31:02 devbox earlyoom[1432]: sending SIGTERM to process 555 uid 1000 "chrome": oom_score 700';
  const h = harness(t, { unityScript: unityScriptThat('exit 0'), journal: journalStub(other) });
  assert.match((await runTests(h, 'n4', RUN_ARGS)).reason, /matched nothing/);
});

test('a green run never reads the journal or mentions earlyoom', LINUX, async (t) => {
  const xml = XML_HEAD + '<test-run total="3" passed="3" failed="0"></test-run>';
  const j = journalStub(OOM_LINE);
  const h = harness(t, { unityScript: unityScriptThat('exit 0', xml), journal: j });
  const r = await runTests(h, 'g1', RUN_ARGS);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(j.calls, []);
});

test('a journal that throws falls back to the plain reason', LINUX, async (t) => {
  const h = harness(t, { unityScript: unityScriptThat('exit 0'), journal: journalStub(new Error('journalctl missing')) });
  const r = await runTests(h, 'e1', RUN_ARGS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /matched nothing/);
});

test('earlyoomJournalArgs selects by identifier (-t) and greps the message, never the word earlyoom', () => {
  const args = earlyoomJournalArgs(1_700_000_000_500);
  const t = args.indexOf('-t');
  assert.ok(t >= 0 && args[t + 1] === 'earlyoom');
  assert.equal(args[args.indexOf('--grep') + 1], 'sending SIG');
  assert.ok(args.includes('@1700000000'));
});

test('a broker-launched Unity (and so LightBaker under it) runs at the background nice and IO class', { skip: process.platform !== 'linux' }, async (t) => {
  const { BACKGROUND_PRIORITY } = loadTs('src/main/agentScope.ts');
  const h = harness(t, { unityScript: '#!/bin/sh\ncut -d")" -f2 /proc/$$/stat | cut -d" " -f18 > "$MD_UNITY_OUT/nice.txt"\n(ionice -p $$ || echo none) > "$MD_UNITY_OUT/ionice.txt"\nexit 0\n' });
  const out = await h.broker.handle('a1', h.request('prio.json', { project: h.proj, args: ['-quit'] }));
  assert.equal(out.status, 'done');
  const resDir = path.join(h.hive, 'agents', 'a1', 'unity-results', 'prio');
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const ownNice = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
  assert.equal(Number(fs.readFileSync(path.join(resDir, 'nice.txt'), 'utf8').trim()), Math.min(19, ownNice + BACKGROUND_PRIORITY.nice));
  const io = fs.readFileSync(path.join(resDir, 'ionice.txt'), 'utf8').trim();
  if (io === 'none') { t.diagnostic('ionice unavailable; IO class not checked'); return; }
  assert.match(io, BACKGROUND_PRIORITY.ioClass === 3 ? /^idle/ : new RegExp(`^best-effort: prio ${BACKGROUND_PRIORITY.ioLevel}$`));
});
