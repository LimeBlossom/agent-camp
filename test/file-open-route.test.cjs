'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { fileOpenRoute, isExternalMediaPath, mediaOpenNotice, VIEWER_MAX_TEXT_BYTES } = loadTs('src/shared/fileOpenRoute.ts');
const MB = 1024 * 1024;

test('allowlisted types open in the system app at any size', () => {
  assert.equal(fileOpenRoute('/h/a/preview.html', 5.6 * MB), 'system');
  assert.equal(fileOpenRoute('/h/a/page.HTM', 100), 'system');
  assert.equal(fileOpenRoute('/h/a/clip.mp4', 300 * 1024), 'system', 'a small video must not land in the viewer');
  assert.equal(fileOpenRoute('/h/a/clip.mp4', 50 * MB), 'system');
  assert.equal(fileOpenRoute('/h/a/notes.md', 10 * 1024), 'system');
  assert.equal(fileOpenRoute('/h/a/shot.png', 6 * MB), 'system');
  assert.equal(fileOpenRoute('/h/a/big.json', VIEWER_MAX_TEXT_BYTES + 1), 'system');
});

test('other files open in the viewer when small, else are revealed', () => {
  assert.equal(fileOpenRoute('/h/a/main.ts', VIEWER_MAX_TEXT_BYTES), 'viewer');
  assert.equal(fileOpenRoute('/h/a/run.sh', 1024), 'viewer', 'a script is shown, never run');
  assert.equal(fileOpenRoute('/h/a/run.sh', 3 * MB), 'reveal');
  assert.equal(fileOpenRoute('/h/a/App.AppImage', 50 * MB), 'reveal');
  assert.equal(fileOpenRoute('/h/a/noext', 3 * MB), 'reveal');
});

test('pictures and videos route to the default app; SVG and executables do not', () => {
  for (const p of ['/h/a/shot.png', '/h/a/S.JPG', '/h/a/a.jpeg', '/h/a/a.gif', '/h/a/a.webp', '/h/a/clip.mp4', '/h/a/c.webm', './x.png?v=2']) {
    assert.equal(isExternalMediaPath(p), true, p);
  }
  for (const p of ['/h/a/logo.svg', '/h/a/App.AppImage', '/h/a/run.sh', '/h/a/x.desktop', '/h/a/noext', '/h/a/png']) {
    assert.equal(isExternalMediaPath(p), false, p);
  }
});

test('a media open that reached the system app is silent; anything else is a short notice', () => {
  assert.equal(mediaOpenNotice({ ok: true, route: 'system', path: '/h/a/x.png' }), null);
  assert.equal(mediaOpenNotice({ ok: false, error: 'not found' }), 'Could not open: not found');
  assert.equal(mediaOpenNotice({ ok: false, error: 'outside the linked folders' }), 'Could not open: outside the linked folders');
  assert.equal(mediaOpenNotice({ ok: true, route: 'viewer' }), 'Could not open: unknown error');
  assert.equal(mediaOpenNotice(null), 'Could not open: unknown error');
});
