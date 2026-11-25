'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts tests
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-ui-fast-reload-userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userDataDir } }
};

const { writeConfig, readConfig } = loadTs('src/main/config.ts');
const { resolveRendererHtml, getRendererLoadTarget, loadRendererView } = loadTs('src/main/campRenderer.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

test.after(() => rmTree(userDataDir));

function tmpDir(prefix = 'md-camp-ui-fast-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── 1. Loose Renderer Resolution Contract ───────────────────────────────────

test('resolveRendererHtml: resolves index.html inside directory when configured via campRendererDir in config', (t) => {
  const dir = tmpDir();
  t.after(() => rmTree(dir));

  const looseHtml = path.join(dir, 'index.html');
  fs.writeFileSync(looseHtml, '<html><body>Fast Reload UI</body></html>', 'utf8');

  writeConfig({ campRendererDir: dir });
  t.after(() => writeConfig({ campRendererDir: undefined }));

  const resolved = resolveRendererHtml();
  assert.equal(resolved, looseHtml, 'must resolve to loose index.html inside campRendererDir');
});

test('resolveRendererHtml: resolves index.html inside directory from CAMP_RENDERER_DIR env var when config is unset', (t) => {
  const dir = tmpDir();
  t.after(() => rmTree(dir));

  const looseHtml = path.join(dir, 'index.html');
  fs.writeFileSync(looseHtml, '<html><body>Fast Reload UI Env</body></html>', 'utf8');

  const oldEnv = process.env.CAMP_RENDERER_DIR;
  process.env.CAMP_RENDERER_DIR = dir;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.CAMP_RENDERER_DIR;
    else process.env.CAMP_RENDERER_DIR = oldEnv;
  });

  const resolved = resolveRendererHtml();
  assert.equal(resolved, looseHtml, 'must resolve to loose index.html from CAMP_RENDERER_DIR');
});

test('resolveRendererHtml: campRendererDir in config takes precedence over CAMP_RENDERER_DIR env var', (t) => {
  const dir1 = tmpDir('cfg-');
  const dir2 = tmpDir('env-');
  t.after(() => { rmTree(dir1); rmTree(dir2); });

  const html1 = path.join(dir1, 'index.html');
  const html2 = path.join(dir2, 'index.html');
  fs.writeFileSync(html1, '<html><body>Config UI</body></html>', 'utf8');
  fs.writeFileSync(html2, '<html><body>Env UI</body></html>', 'utf8');

  writeConfig({ campRendererDir: dir1 });
  const oldEnv = process.env.CAMP_RENDERER_DIR;
  process.env.CAMP_RENDERER_DIR = dir2;
  t.after(() => {
    writeConfig({ campRendererDir: undefined });
    if (oldEnv === undefined) delete process.env.CAMP_RENDERER_DIR;
    else process.env.CAMP_RENDERER_DIR = oldEnv;
  });

  const resolved = resolveRendererHtml();
  assert.equal(resolved, html1, 'configured campRendererDir must take precedence over env var');
});

test('resolveRendererHtml: accepts direct path to custom .html file', (t) => {
  const dir = tmpDir();
  t.after(() => rmTree(dir));

  const customHtml = path.join(dir, 'custom-view.html');
  fs.writeFileSync(customHtml, '<html><body>Direct File</body></html>', 'utf8');

  const resolved = resolveRendererHtml(customHtml);
  assert.equal(resolved, customHtml, 'direct file path must be returned when file exists');
});

test('resolveRendererHtml: falls back to bundled renderer when configured directory does not exist', (t) => {
  const missingDir = path.join(os.tmpdir(), `nonexistent-dir-${Date.now()}`);

  writeConfig({ campRendererDir: missingDir });
  t.after(() => writeConfig({ campRendererDir: undefined }));

  const resolved = resolveRendererHtml();
  assert.ok(
    resolved.endsWith(path.join('renderer', 'index.html')),
    `missing directory must fall back to bundled renderer index.html, got ${resolved}`
  );
  assert.notEqual(resolved, path.join(missingDir, 'index.html'));
});

test('resolveRendererHtml: falls back to bundled renderer when directory exists but contains no index.html', (t) => {
  const emptyDir = tmpDir();
  t.after(() => rmTree(emptyDir));

  writeConfig({ campRendererDir: emptyDir });
  t.after(() => writeConfig({ campRendererDir: undefined }));

  const resolved = resolveRendererHtml();
  assert.ok(
    resolved.endsWith(path.join('renderer', 'index.html')),
    `empty directory without index.html must fall back to bundled renderer, got ${resolved}`
  );
});

test('resolveRendererHtml: falls back to bundled renderer when config and env var are unset', () => {
  const oldEnv1 = process.env.CAMP_RENDERER_DIR;
  const oldEnv2 = process.env.CAMP_RENDERER_PATH;
  delete process.env.CAMP_RENDERER_DIR;
  delete process.env.CAMP_RENDERER_PATH;
  writeConfig({ campRendererDir: undefined, campRendererPath: undefined });

  try {
    const resolved = resolveRendererHtml();
    assert.ok(
      resolved.endsWith(path.join('renderer', 'index.html')),
      `default resolution must point to bundled renderer index.html, got ${resolved}`
    );
  } finally {
    if (oldEnv1 !== undefined) process.env.CAMP_RENDERER_DIR = oldEnv1;
    if (oldEnv2 !== undefined) process.env.CAMP_RENDERER_PATH = oldEnv2;
  }
});

// ─── 2. Dynamic Update Without App Restart ───────────────────────────────────

test('dynamic reload: updating campRendererDir in config updates resolveRendererHtml immediately', (t) => {
  const dirA = tmpDir('dirA-');
  const dirB = tmpDir('dirB-');
  t.after(() => { rmTree(dirA); rmTree(dirB); });

  const htmlA = path.join(dirA, 'index.html');
  const htmlB = path.join(dirB, 'index.html');
  fs.writeFileSync(htmlA, '<html>Version A</html>', 'utf8');
  fs.writeFileSync(htmlB, '<html>Version B</html>', 'utf8');

  writeConfig({ campRendererDir: dirA });
  assert.equal(resolveRendererHtml(), htmlA);

  writeConfig({ campRendererDir: dirB });
  assert.equal(resolveRendererHtml(), htmlB, 'modifying config must immediately redirect resolveRendererHtml');

  writeConfig({ campRendererDir: undefined });
});

// ─── 3. Window View Loading & Desktop Popups ────────────────────────────────

test('getRendererLoadTarget: returns dev URL with query param when rendererUrl is provided', () => {
  const target = getRendererLoadTarget({
    rendererUrl: 'http://localhost:5173',
    view: 'askme'
  });
  assert.equal(target.type, 'url');
  assert.ok(target.url.includes('http://localhost:5173'));
  assert.ok(target.url.includes('view=askme'));
});

test('getRendererLoadTarget: returns loose file path and preserves view query for desktop popups', (t) => {
  const dir = tmpDir();
  t.after(() => rmTree(dir));

  const looseHtml = path.join(dir, 'index.html');
  fs.writeFileSync(looseHtml, '<html><body>Ask Me Popup</body></html>', 'utf8');

  const target = getRendererLoadTarget({
    customPath: dir,
    view: 'askme'
  });
  assert.equal(target.type, 'file');
  assert.equal(target.path, looseHtml);
  assert.deepEqual(target.options?.query, { view: 'askme' });
});

test('loadRendererView: calls loadFile on BrowserWindow with resolved loose path and query', (t) => {
  const dir = tmpDir();
  t.after(() => rmTree(dir));

  const looseHtml = path.join(dir, 'index.html');
  fs.writeFileSync(looseHtml, '<html><body>Strip Popup</body></html>', 'utf8');

  let loadedFile = null;
  let loadedOpts = null;
  const mockWin = {
    loadFile(filePath, opts) {
      loadedFile = filePath;
      loadedOpts = opts;
      return Promise.resolve();
    },
    loadURL() {
      assert.fail('should not call loadURL for loose local file');
    }
  };

  loadRendererView(mockWin, { customPath: dir, view: 'strip' });
  assert.equal(loadedFile, looseHtml);
  assert.deepEqual(loadedOpts, { query: { view: 'strip' } });
});

// ─── 4. PTY Session Survival Across Reload ──────────────────────────────────

test('PTY survival: live PTY session remains active in ptyManager across window reload', async (t) => {
  const mgr = new PtyManager();
  const mockWebContents = {
    id: 99,
    isDestroyed: () => false,
    send: () => {}
  };

  const ptyId = 'survive-test-pty';
  const spawnRes = mgr.spawn({
    id: ptyId,
    cwd: process.cwd(),
    command: '/bin/sh',
    args: ['-c', 'while true; do sleep 1; done']
  }, mockWebContents);
  assert.equal(spawnRes.ok, true, `spawn failed: ${spawnRes.error}`);

  t.after(() => {
    try { mgr.kill(ptyId); } catch { /* cleanup */ }
  });

  const listBefore = mgr.list();
  assert.equal(listBefore.length, 1);
  assert.equal(listBefore[0].id, ptyId);
  const originalPid = listBefore[0].pid;
  assert.ok(originalPid > 0);

  // Simulate window reload (navigation/reload occurs, but window does NOT close).
  // killByOwner is ONLY called on window close, NOT on reload.
  // Verify session is still alive in mgr:
  const listAfter = mgr.list();
  assert.equal(listAfter.length, 1);
  assert.equal(listAfter[0].id, ptyId);
  assert.equal(listAfter[0].pid, originalPid, 'PTY PID must remain unchanged across reload');

  // Verify write and redraw succeed on surviving session
  const redrawRes = mgr.redraw(ptyId);
  assert.equal(redrawRes.ok, true, 'redraw on surviving PTY must succeed');

  const writeRes = mgr.write(ptyId, 'echo ping\n');
  assert.equal(writeRes.ok, true, 'write to surviving PTY must succeed');
});

test('PTY teardown isolation: killByOwner only targets closed window, not surviving sessions', async (t) => {
  const mgr = new PtyManager();
  const wc1 = { id: 1, isDestroyed: () => false, send: () => {} };
  const wc2 = { id: 2, isDestroyed: () => false, send: () => {} };

  mgr.spawn({ id: 'pty-1', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'sleep 10'] }, wc1);
  mgr.spawn({ id: 'pty-2', cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'sleep 10'] }, wc2);

  t.after(() => {
    try { mgr.kill('pty-1'); } catch {}
    try { mgr.kill('pty-2'); } catch {}
  });

  assert.equal(mgr.list().length, 2);
  assert.equal(mgr.countByOwner(wc1), 1);
  assert.equal(mgr.countByOwner(wc2), 1);

  // Close wc1:
  mgr.killByOwner(wc1);

  // Allow asynchronous process kill to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // wc2's session must survive
  const remaining = mgr.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'pty-2', 'session on surviving window must not be killed');
  assert.equal(mgr.countByOwner(wc2), 1);
  assert.equal(mgr.countByOwner(wc1), 0);
  try { mgr.kill('pty-2'); } catch {}
});
