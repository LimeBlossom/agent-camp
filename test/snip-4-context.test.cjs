'use strict';

// camp-snip-to-card step 4: what was under the snip. Window title, WM_CLASS,
// PID, process name and command line from X11 and /proc, then capped logs
// chosen by app: Unity -> Editor.log, Camp -> its own log and hive/log.jsonl,
// anything else -> journalctl --user for that PID. Nothing outside that list is
// read, secrets are masked, and the private games folder never appears.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const ctxMod = loadTs('src/main/snipContext.ts');
const {
  parseStackingIds, parseXwininfo, parseWindowProps, windowUnderRect, unityProjectPath,
  classifyApp, redactSecrets, withholdPrivate, PRIVATE_PATH_PREFIXES, tailText,
  SNIP_LOG_MAX_LINES, SNIP_LOG_MAX_BYTES, SNIP_CMDLINE_MAX, windowStack, collectSnipContext
} = ctxMod;

const PRIVATE = PRIVATE_PATH_PREFIXES[0];
const HOME = '/home/user';
const USER_DATA = '/home/user/.config/munder-difflin';
const HIVE = '/home/user/HarnessAgents/hive';
const CAMP_PID = 4242;

test('the stacking list parses bottom to top', () => {
  const out = '_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x300000b, 0x3000003, 0x3e00004\n';
  assert.deepEqual(parseStackingIds(out), ['0x300000b', '0x3000003', '0x3e00004']);
  assert.deepEqual(parseStackingIds('_NET_CLIENT_LIST_STACKING:  not found.\n'), []);
});

test('xwininfo gives the window geometry and whether it is on screen', () => {
  const out = [
    'xwininfo: Window id: 0x3e00004 "camp"',
    '  Absolute upper-left X:  0',
    '  Absolute upper-left Y:  32',
    '  Relative upper-left X:  0',
    '  Width: 3440',
    '  Height: 1368',
    '  Map State: IsViewable'
  ].join('\n');
  assert.deepEqual(parseXwininfo(out, '0x3e00004'), { id: '0x3e00004', x: 0, y: 32, width: 3440, height: 1368, viewable: true });
  assert.equal(parseXwininfo(out.replace('IsViewable', 'IsUnMapped'), '0x3e00004').viewable, false);
  assert.equal(parseXwininfo('X Error: BadWindow', '0x1'), null);
});

test('window properties: UTF-8 title with escaped quotes, both WM_CLASS parts, PID', () => {
  const out = [
    '_NET_WM_NAME(UTF8_STRING) = "Main - BetaGame - Unity 6 \\"dev\\" <Vulkan>"',
    'WM_NAME(STRING) = "fallback"',
    'WM_CLASS(STRING) = "Unity", "Unity"',
    '_NET_WM_PID(CARDINAL) = 1667901'
  ].join('\n');
  assert.deepEqual(parseWindowProps(out), {
    title: 'Main - BetaGame - Unity 6 "dev" <Vulkan>', wmClass: ['Unity', 'Unity'], pid: 1667901
  });
  assert.deepEqual(parseWindowProps('WM_NAME(STRING) = "xterm"\n_NET_WM_PID:  not found.\n'), { title: 'xterm' });
});

test('the window under the snip is the topmost visible one holding its centre', () => {
  const stack = [ // topmost first
    { id: 'hidden', x: 0, y: 0, width: 5000, height: 2000, viewable: false },
    { id: 'small', x: 900, y: 900, width: 100, height: 100, viewable: true },
    { id: 'editor', x: 0, y: 0, width: 3440, height: 1440, viewable: true },
    { id: 'desktop', x: 0, y: 0, width: 5040, height: 1440, viewable: true }
  ];
  assert.equal(windowUnderRect(stack, { x: 100, y: 100, width: 200, height: 200 }).id, 'editor');
  assert.equal(windowUnderRect(stack, { x: 920, y: 920, width: 40, height: 40 }).id, 'small');
  assert.equal(windowUnderRect(stack, { x: 4000, y: 100, width: 10, height: 10 }).id, 'desktop');
  assert.equal(windowUnderRect([], { x: 0, y: 0, width: 10, height: 10 }), null);
});

test('the Unity project comes from -projectPath in any case', () => {
  assert.equal(unityProjectPath(['/opt/Unity/Editor/Unity', '-projectpath', '/g/BetaGame', '-useHub']), '/g/BetaGame');
  assert.equal(unityProjectPath(['Unity', '-projectPath', '/g/HH']), '/g/HH');
  assert.equal(unityProjectPath(['Unity', '-batchmode']), null);
});

test('apps are told apart: Unity, Camp itself, anything else', () => {
  assert.equal(classifyApp({ pid: 10, wmClass: ['Unity', 'Unity'], processName: 'Unity' }, CAMP_PID), 'unity');
  assert.equal(classifyApp({ pid: CAMP_PID, wmClass: ['electron', 'Electron'] }, CAMP_PID), 'camp');
  assert.equal(classifyApp({ pid: 77, wmClass: ['munder-difflin', 'munder-difflin'] }, CAMP_PID), 'camp');
  assert.equal(classifyApp({ pid: 77, wmClass: ['gnome-terminal-server', 'Gnome-terminal'], processName: 'gnome-terminal-' }, CAMP_PID), 'other');
});

test('secrets in command lines and logs are masked', () => {
  const masked = redactSecrets([
    'tool --token=abc123def --api-key sk-ant-REALKEY0123456789abcd',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'password=hunter2 and ghp_0123456789abcdefghijABCDEFGHIJ012345',
    'normal line stays'
  ].join('\n'));
  for (const leak of ['abc123def', 'sk-ant-REALKEY', 'eyJhbGci', 'hunter2', 'ghp_0123456789']) {
    assert.ok(!masked.includes(leak), `${leak} leaked: ${masked}`);
  }
  assert.match(masked, /normal line stays/);
});

test('the private games folder is withheld under any mount point', () => {
  assert.deepEqual(PRIVATE.split('/'), ['Storage', 'Games', 'Other']);
  assert.equal(withholdPrivate(`/media/user/${PRIVATE}/x.bin`), '[withheld: private folder]');
});

test('anything naming the private folder is withheld, line by line', () => {
  const text = `ok line\nrunning ${PRIVATE}/Some Game/game.x86_64 --fullscreen\nok again`;
  const out = withholdPrivate(text);
  assert.ok(!out.includes(PRIVATE), out);
  assert.ok(!out.includes('Some Game'), 'the rest of the line still names the private file');
  assert.match(out, /ok line/);
  assert.match(out, /ok again/);
});

test('log tails are capped by lines and by bytes', () => {
  const lines = Array.from({ length: SNIP_LOG_MAX_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
  const t = tailText(lines, SNIP_LOG_MAX_LINES, SNIP_LOG_MAX_BYTES);
  assert.equal(t.split('\n').length, SNIP_LOG_MAX_LINES);
  assert.match(t, new RegExp(`line ${SNIP_LOG_MAX_LINES + 49}$`), 'the tail keeps the newest lines');
  const fat = tailText('y'.repeat(SNIP_LOG_MAX_BYTES * 3), SNIP_LOG_MAX_LINES, SNIP_LOG_MAX_BYTES);
  assert.ok(Buffer.byteLength(fat) <= SNIP_LOG_MAX_BYTES, `${Buffer.byteLength(fat)} bytes`);
});

// --- collection, with X11, /proc, files and journalctl all faked ------------

function fakeHost({ props, procs = {}, files = {}, journal = '', failRun = {} }) {
  const reads = [];
  const runs = [];
  const deps = {
    campPid: CAMP_PID, home: HOME, userData: USER_DATA, hiveRoot: HIVE,
    run: async (cmd, args) => {
      runs.push([cmd, ...args]);
      if (failRun[cmd]) throw new Error(failRun[cmd]);
      if (cmd === 'xprop' && args[0] === '-root') return '_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1, 0x2\n';
      if (cmd === 'xwininfo') {
        const id = args[1];
        const geo = id === '0x2' ? [0, 0, 3440, 1440] : [0, 0, 5040, 1440];
        return `  Absolute upper-left X:  ${geo[0]}\n  Absolute upper-left Y:  ${geo[1]}\n  Width: ${geo[2]}\n  Height: ${geo[3]}\n  Map State: IsViewable\n`;
      }
      if (cmd === 'xprop') return props;
      if (cmd === 'journalctl') return journal;
      throw new Error(`unexpected command ${cmd}`);
    },
    readText: (p) => { reads.push(p); return Object.hasOwn(files, p) ? files[p] : Object.hasOwn(procs, p) ? procs[p] : null; }
  };
  return { deps, reads, runs };
}

const RECT = { x: 100, y: 100, width: 300, height: 200 };

test('the window stack comes from X11, topmost first', async () => {
  const { deps } = fakeHost({ props: '' });
  const stack = await windowStack(deps);
  assert.deepEqual(stack.map((w) => w.id), ['0x2', '0x1']);
});

test('a Unity snip carries the window facts, the project path and the Editor.log tail', async () => {
  const pid = 31337;
  const editorLog = `${HOME}/.config/unity3d/Editor.log`;
  const { deps, reads } = fakeHost({
    props: `_NET_WM_NAME(UTF8_STRING) = "Main - BetaGame - Unity"\nWM_CLASS(STRING) = "Unity", "Unity"\n_NET_WM_PID(CARDINAL) = ${pid}\n`,
    procs: {
      [`/proc/${pid}/comm`]: 'Unity\n',
      [`/proc/${pid}/cmdline`]: ['/opt/Unity/Editor/Unity', '-projectpath', '/g/BetaGame', '-licensingToken=SECRETVALUE1234'].join('\0') + '\0'
    },
    files: { [editorLog]: 'compile ok\nNullReferenceException at Foo.cs:12\n' }
  });
  const stack = await windowStack(deps);
  const ctx = await collectSnipContext(stack, RECT, deps);
  assert.equal(ctx.kind, 'unity');
  assert.equal(ctx.window.title, 'Main - BetaGame - Unity');
  assert.deepEqual(ctx.window.wmClass, ['Unity', 'Unity']);
  assert.equal(ctx.window.pid, pid);
  assert.equal(ctx.window.processName, 'Unity');
  assert.match(ctx.window.cmdline, /-projectpath \/g\/BetaGame/);
  assert.ok(!ctx.window.cmdline.includes('SECRETVALUE1234'), 'a token in the command line leaked');
  assert.equal(ctx.unityProject, '/g/BetaGame');
  assert.equal(ctx.logs.length, 1);
  assert.match(ctx.logs[0].source, /Editor\.log/);
  assert.match(ctx.logs[0].text, /NullReferenceException/);
  assert.deepEqual(new Set(reads), new Set([`/proc/${pid}/comm`, `/proc/${pid}/cmdline`, editorLog]));
});

test('a Camp snip carries its own renderer log and the hive log', async () => {
  const { deps, reads } = fakeHost({
    props: `WM_CLASS(STRING) = "munder-difflin", "munder-difflin"\n_NET_WM_PID(CARDINAL) = ${CAMP_PID}\n`,
    files: { [`${USER_DATA}/renderer.log`]: 'renderer says hi\n', [`${HIVE}/log.jsonl`]: '{"kind":"app-start"}\n' }
  });
  const ctx = await collectSnipContext(await windowStack(deps), RECT, deps);
  assert.equal(ctx.kind, 'camp');
  assert.deepEqual(ctx.logs.map((l) => l.text.trim()), ['renderer says hi', '{"kind":"app-start"}']);
  const fileReads = reads.filter((p) => !p.startsWith('/proc/'));
  assert.deepEqual(new Set(fileReads), new Set([`${USER_DATA}/renderer.log`, `${HIVE}/log.jsonl`]));
});

test('any other app gets recent journalctl --user lines for its PID, and reads no files', async () => {
  const pid = 555;
  const { deps, reads, runs } = fakeHost({
    props: `WM_CLASS(STRING) = "firefox", "firefox"\n_NET_WM_PID(CARDINAL) = ${pid}\n`,
    procs: { [`/proc/${pid}/comm`]: 'firefox\n', [`/proc/${pid}/cmdline`]: 'firefox\0' },
    journal: 'Nov 19 20:15 firefox[555]: something\n'
  });
  const ctx = await collectSnipContext(await windowStack(deps), RECT, deps);
  assert.equal(ctx.kind, 'other');
  const j = runs.find((r) => r[0] === 'journalctl');
  assert.ok(j, 'journalctl was not run');
  assert.ok(j.includes('--user') && j.includes(`_PID=${pid}`) && j.includes('--no-pager'), j.join(' '));
  assert.match(ctx.logs[0].text, /something/);
  assert.ok(reads.every((p) => p.startsWith(`/proc/${pid}/`)), `read beyond /proc: ${reads.join(', ')}`);
});

test('an app running from the private folder: its title, command line and logs never name it', async () => {
  const pid = 666;
  const { deps } = fakeHost({
    props: `_NET_WM_NAME(UTF8_STRING) = "${PRIVATE}/Hidden/game"\nWM_CLASS(STRING) = "game", "Game"\n_NET_WM_PID(CARDINAL) = ${pid}\n`,
    procs: { [`/proc/${pid}/comm`]: 'game\n', [`/proc/${pid}/cmdline`]: `${PRIVATE}/Hidden/game\0--windowed\0` },
    journal: `Nov 19 game[666]: loading ${PRIVATE}/Hidden/data.pak\n`
  });
  const ctx = await collectSnipContext(await windowStack(deps), RECT, deps);
  const all = JSON.stringify(ctx);
  assert.ok(!all.includes(PRIVATE), 'the private path leaked into the context');
  assert.ok(!all.includes('Hidden'), 'a name under the private path leaked');
});

test('X11 failing does not throw: the context says what is missing', async () => {
  const { deps } = fakeHost({ props: '', failRun: { xprop: 'xprop: unable to open display' } });
  const ctx = await collectSnipContext([], RECT, deps);
  assert.equal(ctx.kind, 'other');
  assert.ok(ctx.errors.length > 0);
});

test('a huge command line is capped', async () => {
  const pid = 777;
  const { deps } = fakeHost({
    props: `WM_CLASS(STRING) = "x", "X"\n_NET_WM_PID(CARDINAL) = ${pid}\n`,
    procs: { [`/proc/${pid}/comm`]: 'x\n', [`/proc/${pid}/cmdline`]: `x\0${'a'.repeat(SNIP_CMDLINE_MAX * 3)}\0` }
  });
  const ctx = await collectSnipContext(await windowStack(deps), RECT, deps);
  assert.ok(ctx.window.cmdline.length <= SNIP_CMDLINE_MAX, `${ctx.window.cmdline.length} chars`);
});
