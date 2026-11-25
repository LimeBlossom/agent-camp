'use strict';

// snip-20261123-193808: Camp went fully blank (cream window #FFF8E7) under memory
// pressure when the renderer died without any render-process-gone / unresponsive
// handler. Main must log a log.jsonl event (reason, exitCode) and automatically
// reload the window, capped so a crash loop cannot spin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const REPO_ROOT = path.resolve(__dirname, '..');
const RECOVERY_MODULE = 'src/main/rendererRecovery.ts';
const INDEX_PATH = path.join(REPO_ROOT, 'src/main/index.ts');

function loadRecovery() {
  return loadTs(RECOVERY_MODULE);
}

function makeFakeWindow() {
  const win = new EventEmitter();
  const webContents = new EventEmitter();
  let destroyed = false;
  let wcDestroyed = false;
  let reloadCalls = 0;

  webContents.session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {}
  };
  webContents.setWindowOpenHandler = () => {};
  webContents.send = () => {};
  webContents.isDestroyed = () => wcDestroyed;
  webContents.reload = () => { reloadCalls += 1; };
  webContents.destroy = () => { wcDestroyed = true; };

  win.webContents = webContents;
  win.isDestroyed = () => destroyed;
  win.isMinimized = () => false;
  win.isMaximized = () => false;
  win.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  win.show = () => {};
  win.focus = () => {};
  win.destroy = () => {
    destroyed = true;
    wcDestroyed = true;
    win.emit('closed');
  };

  return {
    win,
    webContents,
    get reloadCalls() { return reloadCalls; },
    markDestroyed() { destroyed = true; wcDestroyed = true; }
  };
}

function createCreateWindowHarness(t) {
  const hiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-renderer-recovery-'));
  t.after(() => rmTree(hiveDir));
  const realHive = new HiveManager(() => hiveDir);
  realHive.ensureHive();

  const source = fs.readFileSync(INDEX_PATH, 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const fnNode = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'createWindow');
  assert.ok(fnNode, 'createWindow must exist in src/main/index.ts');
  const fnJs = ts.transpileModule(fnNode.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;

  let recoveryExports = {};
  if (fs.existsSync(path.join(REPO_ROOT, RECOVERY_MODULE))) {
    recoveryExports = loadRecovery();
  }

  const created = [];
  const loadViewCalls = [];

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      const fake = makeFakeWindow();
      Object.assign(this, fake.win);
      this._fake = fake;
      created.push(fake);
    }
    isDestroyed() { return this._fake.win.isDestroyed(); }
    isMinimized() { return false; }
    isMaximized() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1200, height: 800 }; }
    show() {}
    focus() {}
  }

  const context = vm.createContext({
    ...recoveryExports,
    BrowserWindow: FakeBrowserWindow,
    DEFAULT_WIN: { width: 1200, height: 800 },
    MIN_WIN: { width: 600, height: 400 },
    brandTitle: () => 'Munder Difflin',
    floorSeq: 0,
    allWindows: new Set(),
    mainWindow: null,
    allowQuit: false,
    rendererReadyForHires: false,
    isDev: false,
    process: { env: {} },
    __dirname: path.join(REPO_ROOT, 'src/main'),
    join: path.join,
    persist: { getKv: () => null, setKv: () => {} },
    clampBounds: (v) => v ?? null,
    floorCascade: () => null,
    readConfig: () => ({}),
    debounce: (fn) => fn,
    ptyManager: { countByOwner: () => 0, list: () => [], attachWebContents: () => {}, killByOwner: () => {} },
    dialog: { showMessageBoxSync: () => 1 },
    shell: { openExternal: () => {} },
    keepRendererConsoleLine: () => false,
    appendFileSync: () => {},
    app: { getPath: () => hiveDir },
    loadRendererView: (win) => { loadViewCalls.push(win); },
    syncKeepAwake: () => {},
    hive: {
      enabled: () => true,
      appendLog: (ev) => realHive.appendLog(ev)
    },
    console: { log() {}, warn() {}, error() {} }
  });
  vm.runInContext(fnJs, context);

  async function readLogEvents() {
    await realHive.flushWrites();
    const raw = fs.readFileSync(path.join(realHive.root(), 'log.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  return {
    createWindow: (opts) => context.createWindow(opts),
    created,
    loadViewCalls,
    readLogEvents,
    setAllowQuit(v) { context.allowQuit = v; }
  };
}

// --- Unit tests for src/main/rendererRecovery.ts ---

test('render-process-gone logs reason and exitCode and reloads the window automatically', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fake = makeFakeWindow();
  const logs = [];
  let reloads = 0;

  attachRendererRecovery(fake.win, {
    reload: () => { reloads += 1; },
    log: (ev) => logs.push(ev),
    maxReloads: 3,
    windowMs: 60_000,
    now: () => 1_000_000
  });

  fake.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  assert.equal(reloads, 1, 'OOM renderer disappearance must trigger an automatic reload');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, 'oom');
  assert.equal(logs[0].exitCode, 137);

  fake.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 });
  assert.equal(reloads, 2, 'crashed renderer (e.g. SIGBUS) must trigger an automatic reload');
  assert.equal(logs.length, 2);
  assert.equal(logs[1].reason, 'crashed');
  assert.equal(logs[1].exitCode, 7);
});

test('render-process-gone with clean-exit logs the event but does not reload', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fake = makeFakeWindow();
  const logs = [];
  let reloads = 0;

  attachRendererRecovery(fake.win, {
    reload: () => { reloads += 1; },
    log: (ev) => logs.push(ev),
    maxReloads: 3,
    windowMs: 60_000,
    now: () => 1_000_000
  });

  fake.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  assert.equal(reloads, 0, 'clean-exit must not trigger a reload');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, 'clean-exit');
  assert.equal(logs[0].exitCode, 0);
});

test('unresponsive window logs an event (reason, exitCode) and reloads automatically', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fake = makeFakeWindow();
  const logs = [];
  let reloads = 0;

  attachRendererRecovery(fake.win, {
    reload: () => { reloads += 1; },
    log: (ev) => logs.push(ev),
    maxReloads: 3,
    windowMs: 60_000,
    now: () => 1_000_000
  });

  fake.win.emit('unresponsive');
  assert.equal(reloads, 1, 'unresponsive window must trigger an automatic reload');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].reason, 'unresponsive');
  assert.ok('exitCode' in logs[0], 'unresponsive event should include exitCode field (null)');
  assert.equal(logs[0].exitCode, null);
});

test('crash-loop cap stops automatic reloads after maxReloads within windowMs while still logging', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fake = makeFakeWindow();
  const logs = [];
  let reloads = 0;
  let now = 1_000_000;

  attachRendererRecovery(fake.win, {
    reload: () => { reloads += 1; },
    log: (ev) => logs.push(ev),
    maxReloads: 3,
    windowMs: 60_000,
    now: () => now
  });

  for (let i = 0; i < 5; i += 1) {
    now += 1_000;
    fake.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
  }

  assert.equal(reloads, 3, 'reloads must stop at maxReloads inside windowMs');
  assert.equal(logs.length, 5, 'all 5 crashes must still be logged');
  assert.equal(logs[3].reloaded, false);
  assert.equal(logs[4].reloaded, false);

  now += 500;
  fake.win.emit('unresponsive');
  assert.equal(reloads, 3, 'unresponsive inside the same capped window must also stay capped');
  assert.equal(logs.length, 6);
  assert.equal(logs[5].reason, 'unresponsive');
  assert.equal(logs[5].reloaded, false);
});

test('rolling crash-loop window expires old reloads so recovery works again later', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fake = makeFakeWindow();
  const logs = [];
  let reloads = 0;
  let now = 1_000_000;

  attachRendererRecovery(fake.win, {
    reload: () => { reloads += 1; },
    log: (ev) => logs.push(ev),
    maxReloads: 2,
    windowMs: 60_000,
    now: () => now
  });

  fake.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  now += 5_000;
  fake.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  now += 5_000;
  fake.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  assert.equal(reloads, 2, 'third crash inside 60s window is capped');

  // Advance past the 60s window from the first crash (at 1_000_000).
  now = 1_060_001;
  fake.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  assert.equal(reloads, 3, 'after the oldest crash ages out of windowMs, reload works again');
});

test('destroyed or quitting windows never reload on render-process-gone or unresponsive', () => {
  const { attachRendererRecovery } = loadRecovery();
  const fakeDestroyed = makeFakeWindow();
  let reloadsDestroyed = 0;
  attachRendererRecovery(fakeDestroyed.win, {
    reload: () => { reloadsDestroyed += 1; },
    log: () => {},
    maxReloads: 3,
    windowMs: 60_000
  });
  fakeDestroyed.markDestroyed();
  fakeDestroyed.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
  fakeDestroyed.win.emit('unresponsive');
  assert.equal(reloadsDestroyed, 0, 'destroyed window must not reload');

  const fakeQuitting = makeFakeWindow();
  let reloadsQuitting = 0;
  let quitting = false;
  attachRendererRecovery(fakeQuitting.win, {
    reload: () => { reloadsQuitting += 1; },
    log: () => {},
    isQuitting: () => quitting,
    maxReloads: 3,
    windowMs: 60_000
  });
  quitting = true;
  fakeQuitting.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
  fakeQuitting.win.emit('unresponsive');
  assert.equal(reloadsQuitting, 0, 'quitting app must not reload');
});

// --- Main-process wiring tests against src/main/index.ts ---

test('createWindow in src/main/index.ts logs to log.jsonl and reloads on render-process-gone and unresponsive', async (t) => {
  const h = createCreateWindowHarness(t);
  const win = h.createWindow();
  const fake = h.created[0];
  assert.equal(h.loadViewCalls.length, 1, 'initial createWindow loads renderer once');
  const reloads = () => (h.loadViewCalls.length - 1) + fake.reloadCalls;

  win.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
  assert.equal(reloads(), 1, 'render-process-gone must reload the window');

  win.emit('unresponsive');
  assert.equal(reloads(), 2, 'unresponsive must reload the window');

  const events = await h.readLogEvents();
  const goneEv = events.find((e) => e.reason === 'oom' && e.exitCode === 137);
  assert.ok(goneEv, `log.jsonl must record render-process-gone reason+exitCode; got ${JSON.stringify(events)}`);
  const hungEv = events.find((e) => e.reason === 'unresponsive');
  assert.ok(hungEv, `log.jsonl must record unresponsive event; got ${JSON.stringify(events)}`);
});

test('createWindow in src/main/index.ts caps crash-loop reloads while still logging to log.jsonl', async (t) => {
  const h = createCreateWindowHarness(t);
  const win = h.createWindow();
  const fake = h.created[0];
  const reloads = () => (h.loadViewCalls.length - 1) + fake.reloadCalls;

  for (let i = 0; i < 10; i += 1) {
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 });
  }

  const totalReloads = reloads();
  assert.ok(totalReloads >= 1 && totalReloads < 10, `expected bounded reloads in a 10-crash loop, got ${totalReloads}`);

  const events = await h.readLogEvents();
  const crashEvents = events.filter((e) => e.reason === 'crashed' && e.exitCode === 7);
  assert.equal(crashEvents.length, 10, 'all 10 crashes must be logged to log.jsonl even after reload cap');
});

test('src/main/index.ts logs child-process-gone events to log.jsonl', () => {
  const src = fs.readFileSync(INDEX_PATH, 'utf8');
  assert.ok(/app\.on\(\s*['"]child-process-gone['"]/.test(src), 'src/main/index.ts must handle child-process-gone');
  const idx = src.indexOf('child-process-gone');
  const slice = src.slice(idx, idx + 400);
  assert.ok(/appendLog/.test(slice), 'child-process-gone handler must log to log.jsonl via appendLog');
});
