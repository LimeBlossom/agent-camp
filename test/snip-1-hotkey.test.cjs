'use strict';

// camp-snip-to-card step 1: one global shortcut, owned by main, set in Camp
// settings, and a failed registration is logged and shown, never silent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { DEFAULT_SNIP_HOTKEY, canonicalAccelerator, shortcutClash, snipHotkeyOf } = loadTs('src/shared/snip.ts');
const { createSnipHotkey } = loadTs('src/main/snipHotkey.ts');

function fakeShortcuts({ refuse = [], throwOn = {} } = {}) {
  const live = new Map();
  return {
    live,
    register(acc, cb) {
      if (throwOn[acc]) throw new Error(throwOn[acc]);
      if (refuse.includes(acc)) return false;
      live.set(acc, cb);
      return true;
    },
    unregister(acc) { live.delete(acc); }
  };
}

test('the default is Shift+F12, which clashes with nothing known in Cinnamon or Unity', () => {
  assert.equal(DEFAULT_SNIP_HOTKEY, 'Shift+F12');
  assert.ok(!DEFAULT_SNIP_HOTKEY.includes('Super'), "Cinnamon's menu takes the bare Super key, so no Super combo reaches a global grab");
  assert.equal(shortcutClash(DEFAULT_SNIP_HOTKEY), null);
});

test('known Cinnamon and Unity bindings are reported as clashes, whatever the spelling', () => {
  assert.match(shortcutClash('Shift+Print'), /cinnamon/i, 'Cinnamon area screenshot');
  assert.match(shortcutClash('super+s'), /cinnamon/i, 'Cinnamon show desklets');
  assert.match(shortcutClash('Super+Shift+Left'), /cinnamon/i, 'Cinnamon move to monitor');
  assert.match(shortcutClash('Control+Shift+S'), /unity/i, 'Unity Save As');
  assert.match(shortcutClash('CmdOrCtrl+P'), /unity/i, 'Unity Play');
});

test('accelerators compare by meaning: modifier order, case and aliases do not matter', () => {
  assert.equal(canonicalAccelerator('shift+super+s'), 'Super+Shift+S');
  assert.equal(canonicalAccelerator('Meta+Shift+S'), 'Super+Shift+S');
  assert.equal(canonicalAccelerator('Shift+Control+Alt+x'), 'Ctrl+Alt+Shift+X');
  assert.equal(canonicalAccelerator('CommandOrControl+Shift+S'), 'Ctrl+Shift+S');
});

test('the configured hotkey: unset means the default, an empty string means off', () => {
  assert.equal(snipHotkeyOf({}), DEFAULT_SNIP_HOTKEY);
  assert.equal(snipHotkeyOf({ snipHotkey: undefined }), DEFAULT_SNIP_HOTKEY);
  assert.equal(snipHotkeyOf({ snipHotkey: '' }), '');
  assert.equal(snipHotkeyOf({ snipHotkey: 'Ctrl+Alt+Shift+K' }), 'Ctrl+Alt+Shift+K');
});

test('arming registers the shortcut and the press runs the callback', () => {
  const api = fakeShortcuts();
  const lines = [];
  let presses = 0;
  const hotkey = createSnipHotkey(api, (l) => lines.push(l));
  const status = hotkey.arm('Super+Shift+S', () => { presses++; });
  assert.deepEqual({ accelerator: status.accelerator, registered: status.registered, error: status.error },
    { accelerator: 'Super+Shift+S', registered: true, error: undefined });
  api.live.get('Super+Shift+S')();
  assert.equal(presses, 1);
  assert.deepEqual(hotkey.status(), status);
});

test('a refused registration is logged and reported, never silent', () => {
  const api = fakeShortcuts({ refuse: ['Super+Shift+S'] });
  const lines = [];
  const hotkey = createSnipHotkey(api, (l) => lines.push(l));
  const status = hotkey.arm('Super+Shift+S', () => {});
  assert.equal(status.registered, false);
  assert.match(status.error ?? '', /Super\+Shift\+S/);
  assert.match(status.error ?? '', /taken|in use|refused/i);
  assert.ok(lines.some((l) => l.includes('Super+Shift+S')), `nothing logged: ${JSON.stringify(lines)}`);
  assert.equal(hotkey.status().registered, false, 'settings reads the failure back');
});

test('an accelerator that throws in globalShortcut is caught, logged and reported', () => {
  const api = fakeShortcuts({ throwOn: { 'Shift+F12': 'Error processing argument' } });
  const lines = [];
  const hotkey = createSnipHotkey(api, (l) => lines.push(l));
  const status = hotkey.arm('Shift+F12', () => {});
  assert.equal(status.registered, false);
  assert.match(status.error ?? '', /Error processing argument/);
  assert.ok(lines.length > 0, 'the throw was not logged');
});

test('re-arming swaps the shortcut: the old one is released, an empty one turns it off', () => {
  const api = fakeShortcuts();
  const hotkey = createSnipHotkey(api, () => {});
  hotkey.arm('Super+Shift+S', () => {});
  hotkey.arm('Ctrl+Alt+Shift+K', () => {});
  assert.deepEqual([...api.live.keys()], ['Ctrl+Alt+Shift+K']);
  const off = hotkey.arm('', () => {});
  assert.deepEqual([...api.live.keys()], []);
  assert.equal(off.registered, false);
  assert.equal(off.error, undefined, 'turning it off is not an error');
});

test('a clashing choice still registers, with the clash attached as a warning', () => {
  const api = fakeShortcuts();
  const status = createSnipHotkey(api, () => {}).arm('Ctrl+Shift+S', () => {});
  assert.equal(status.registered, true);
  assert.match(status.clash ?? '', /unity/i);
});

// --- wiring (source reads, the house pattern for main/preload/SettingsModal) ---

test('main arms the configured hotkey at startup through the real globalShortcut', () => {
  const index = read('src/main/index.ts');
  assert.match(index, /createSnipHotkey\(\s*globalShortcut/, 'the hotkey is not built on globalShortcut');
  assert.match(index, /snipHotkeyOf\(readConfig\(\)\)/, 'startup does not read the configured hotkey');
  assert.match(index, /ipcMain\.handle\('snip:setHotkey'/, 'no IPC to change it');
  assert.match(index, /ipcMain\.handle\('snip:hotkeyStatus'/, 'no IPC to read its status');
});

test('settings shows the hotkey and its registration status, and saves it immediately like Free Flow', () => {
  const preload = read('src/preload/index.ts');
  assert.match(preload, /snipSetHotkey:/);
  assert.match(preload, /snipHotkeyStatus:/);
  const modal = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(modal, /window\.cth\.snipHotkeyStatus\(/, 'settings does not read the status');
  assert.match(modal, /window\.cth\.snipSetHotkey\(/, 'settings cannot change the hotkey');
  assert.match(modal, /snipStatus\??\.error/, 'a registration failure is not shown');
  assert.doesNotMatch(modal, /stage\(\{ snipHotkey:/, 'staging would leave the armed key and the field disagreeing');
});
