'use strict';

// camp-snip-hotkey-cinnamon steps 5-6: the snip hotkey field saved only through
// its own inline Save or Enter, so the footer Save dropped it and closing threw
// the edit away. It now rides the one footer Save, and an edit counts as unsaved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const MODAL = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');
const { DEFAULT_SNIP_HOTKEY, snipHotkeyEdit } = loadTs('src/shared/snip.ts');

test('a typed accelerator that differs from the saved one is an edit to send', () => {
  assert.equal(snipHotkeyEdit('Ctrl+Alt+Shift+K', DEFAULT_SNIP_HOTKEY), 'Ctrl+Alt+Shift+K');
  assert.equal(snipHotkeyEdit('  ', DEFAULT_SNIP_HOTKEY), '', 'clearing the field turns it off');
});

test('the same shortcut in another spelling, or untouched, is not an edit', () => {
  assert.equal(snipHotkeyEdit('shift+alt+ctrl+s', 'Ctrl+Alt+Shift+S'), null);
  assert.equal(snipHotkeyEdit(DEFAULT_SNIP_HOTKEY, DEFAULT_SNIP_HOTKEY), null);
  assert.equal(snipHotkeyEdit('', ''), null, 'off and still off');
});

const saveAllBody = () => {
  const i = MODAL.indexOf('const saveAll');
  assert.ok(i > 0, 'saveAll is gone');
  return MODAL.slice(i, MODAL.indexOf('\n  };', i));
};

test('the footer Save sends a changed snip hotkey to main, which persists and re-arms it', () => {
  const body = saveAllBody();
  assert.match(body, /snipHotkeyEdit\(/, 'saveAll never checks the snip hotkey field');
  assert.match(body, /window\.cth\.snipSetHotkey\(/, 'saveAll never sends the snip hotkey');
  assert.match(body, /setSnipStatus\(/, 'the armed status is not shown after Save');
});

test('an unsaved snip hotkey edit makes the modal dirty, so closing asks first', () => {
  const dirtyLine = MODAL.split('\n').find((l) => /const dirty = /.test(l)) ?? '';
  assert.match(dirtyLine, /snip/i, `dirty ignores the snip field: ${dirtyLine.trim()}`);
});

test('the snip field has no Save of its own; Enter runs the footer Save', () => {
  assert.doesNotMatch(MODAL, /saveSnipHotkey/, 'the separate inline snip Save is still there');
  const i = MODAL.indexOf('value={snipHotkey}');
  assert.ok(i > 0, 'the snip field is gone');
  const field = MODAL.slice(i, MODAL.indexOf('/>', i));
  assert.match(field, /saveAll\(\)/, 'Enter in the snip field does not run the footer Save');
});
