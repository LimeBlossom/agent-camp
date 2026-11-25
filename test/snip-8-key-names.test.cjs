'use strict';

// camp-snip-key-validation steps 1-2: Electron refuses a key it has no name for
// ("conversion failure from Pause"), so the field names the bad key before Save
// and arm never hands it to globalShortcut.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { snipKeyError } = loadTs('src/shared/snip.ts');
const { createSnipHotkey } = loadTs('src/main/snipHotkey.ts');
const MODAL = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');

test('a key Electron has no name for is refused, naming the key', () => {
  const err = snipKeyError('Pause');
  assert.ok(err, 'Pause passed');
  assert.match(err, /Pause/);
  assert.match(snipKeyError('Ctrl+Shift+Pause') ?? '', /Pause/);
});

test('keys Electron names pass, in any spelling', () => {
  for (const acc of ['Shift+F12', 'Scrolllock', 'scrolllock', 'Ctrl+Alt+Shift+S', 'Ctrl+7', 'PrintScreen', 'Shift+num5', 'MediaPlayPause', 'Ctrl+,', '']) {
    assert.equal(snipKeyError(acc), null, acc);
  }
});

test('modifiers with no key, or two keys, are refused', () => {
  assert.ok(snipKeyError('Ctrl+Shift'), 'no key');
  assert.ok(snipKeyError('Ctrl+A+B'), 'two keys');
});

test('arm refuses a key Electron cannot name instead of throwing at globalShortcut', () => {
  const calls = [];
  const lines = [];
  const hk = createSnipHotkey({ register(acc) { calls.push(acc); return true; }, unregister() {} }, (l) => lines.push(l));
  const s = hk.arm('Pause', () => {});
  assert.equal(s.registered, false);
  assert.match(s.error ?? '', /Pause/);
  assert.deepEqual(calls, [], 'globalShortcut was asked for Pause');
});

test('the Settings field shows the key error and Save does not send it', () => {
  assert.match(MODAL, /snipKeyError\(snipHotkey\)/, 'the field never checks its key');
  const i = MODAL.indexOf('const saveAll');
  const body = MODAL.slice(i, MODAL.indexOf('\n  };', i));
  assert.match(body, /snipKeyError|snipFieldError/, 'saveAll sends a key Electron cannot register');
});
