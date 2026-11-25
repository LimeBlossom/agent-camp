'use strict';

// camp-snip-hotkey-cinnamon: the snip hotkey must fire with Camp unfocused on
// Cinnamon/X11. Two traps hid the old Super+Shift+S default: an applet spice
// bound it (not gsettings), and the menu's bare-Super overlay key swallows every
// Super combo before XGrabKey sees it, while globalShortcut.register still says yes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SPICES = path.join(__dirname, 'fixtures', 'cinnamon-spices');

const snip = loadTs('src/shared/snip.ts');
const { DEFAULT_SNIP_HOTKEY, gtkAccelerators, shortcutClash, superBlockedReason, migratedSnipHotkey } = snip;
const { readCinnamonBindings } = loadTs('src/main/cinnamonKeys.ts');
const { createSnipHotkey } = loadTs('src/main/snipHotkey.ts');

function fakeShortcuts() {
  const live = new Map();
  return { live, register(acc, cb) { live.set(acc, cb); return true; }, unregister(acc) { live.delete(acc); } };
}

const NO_DESKTOP = { clashes: new Map(), superOverlay: null };

test('GTK keybinding values parse to canonical accelerators, "::" separating several and empty slots', () => {
  assert.deepEqual(gtkAccelerators('<Shift><Super>s'), ['Super+Shift+S']);
  assert.deepEqual(gtkAccelerators('<Primary><Alt>F9'), ['Ctrl+Alt+F9']);
  assert.deepEqual(gtkAccelerators('<Control><Shift>Print'), ['Ctrl+Shift+PrintScreen']);
  assert.deepEqual(gtkAccelerators('<Super>n::<Shift><Super>c'), ['Super+N', 'Super+Shift+C']);
  assert.deepEqual(gtkAccelerators('<Super>grave'), ['Super+`'], 'keysym names become the character');
  assert.deepEqual(gtkAccelerators('::'), []);
  assert.deepEqual(gtkAccelerators(''), []);
  assert.deepEqual(gtkAccelerators('Super_L::Super_R'), ['Super', 'Super']);
});

test('applet spice keybindings are read from the spices folder, skipping broken files and cleared slots', () => {
  const desk = readCinnamonBindings(SPICES);
  assert.match(desk.clashes.get('Super+Shift+S') ?? '', /sound@cinnamon\.org.*Show menu/);
  assert.match(desk.clashes.get('Super+N') ?? '', /notifications@cinnamon\.org/);
  assert.match(desk.clashes.get('Ctrl+Alt+F9') ?? '', /Clear notifications/, 'a second binding after :: is read');
  assert.equal(desk.clashes.has('Super+Shift+C'), false, 'the default is not live once the user changed the value');
  assert.equal(desk.clashes.has('Super+C'), false, 'a cleared "::" slot binds nothing');
  assert.match(desk.superOverlay ?? '', /menu@cinnamon\.org/, 'the bare Super_L overlay key is recognised');
});

test('a missing spices folder (another desktop) means no desktop bindings, not a throw', () => {
  const desk = readCinnamonBindings(path.join(SPICES, 'no-such-dir'));
  assert.equal(desk.clashes.size, 0);
  assert.equal(desk.superOverlay, null);
});

test('the clash check reports a spice binding the built-in table does not list', () => {
  const desk = readCinnamonBindings(SPICES);
  assert.equal(shortcutClash('Super+Shift+S'), null, 'the built-in table alone misses it');
  assert.match(shortcutClash('shift+super+s', desk) ?? '', /sound@cinnamon\.org/);
  assert.equal(shortcutClash(DEFAULT_SNIP_HOTKEY, desk), null, 'the new default is free on this desktop');
});

test('any Super accelerator is dead while a bare-Super overlay key is bound', () => {
  const desk = readCinnamonBindings(SPICES);
  assert.match(superBlockedReason('Super+Shift+F11', desk) ?? '', /Super/);
  assert.match(superBlockedReason('Meta+Alt+K', desk) ?? '', /menu@cinnamon\.org/);
  assert.equal(superBlockedReason('Ctrl+Alt+Shift+S', desk), null);
  assert.equal(superBlockedReason('Super+Shift+F11', NO_DESKTOP), null, 'no overlay key, no block');
});

test('arming a Super accelerator under a Super overlay is refused with the reason, not silently armed', () => {
  const desk = readCinnamonBindings(SPICES);
  const api = fakeShortcuts();
  const lines = [];
  const status = createSnipHotkey(api, (l) => lines.push(l)).arm('Super+Shift+F11', () => {}, desk);
  assert.equal(status.registered, false);
  assert.match(status.error ?? '', /Super/);
  assert.deepEqual([...api.live.keys()], [], 'a grab that can never fire is not taken');
  assert.ok(lines.some((l) => /NOT armed/.test(l)), `not logged: ${JSON.stringify(lines)}`);
});

test('arming passes desktop clashes through as a warning', () => {
  const desk = { clashes: new Map([['Ctrl+Alt+Shift+S', 'Cinnamon applet x: y']]), superOverlay: null };
  const status = createSnipHotkey(fakeShortcuts(), () => {}).arm('Ctrl+Alt+Shift+S', () => {}, desk);
  assert.equal(status.registered, true);
  assert.match(status.clash ?? '', /applet x/);
});

test('a saved old default is migrated to the new one when this desktop kills it, and left alone otherwise', () => {
  const desk = readCinnamonBindings(SPICES);
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Super+Shift+S' }, desk), DEFAULT_SNIP_HOTKEY);
  assert.equal(migratedSnipHotkey({ snipHotkey: 'shift+super+s' }, desk), DEFAULT_SNIP_HOTKEY, 'any spelling');
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Super+Shift+S' }, NO_DESKTOP), null, 'it works here, keep the choice');
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Super+Alt+K' }, desk), null, "a user's own choice is refused at arm, not rewritten");
  assert.equal(migratedSnipHotkey({}, desk), null, 'unset already means the new default');
  assert.equal(migratedSnipHotkey({ snipHotkey: '' }, desk), null, 'off stays off');
});

test('the previous default Ctrl+Alt+Shift+S moves to Shift+F12 on any desktop', () => {
  const desk = readCinnamonBindings(SPICES);
  assert.equal(DEFAULT_SNIP_HOTKEY, 'Shift+F12');
  for (const d of [desk, NO_DESKTOP]) {
    assert.equal(migratedSnipHotkey({ snipHotkey: 'Ctrl+Alt+Shift+S' }, d), 'Shift+F12');
    assert.equal(migratedSnipHotkey({ snipHotkey: 'shift+alt+ctrl+s' }, d), 'Shift+F12', 'any spelling');
  }
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Shift+F12' }, desk), null, 'already the default');
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Ctrl+Alt+Shift+K' }, desk), null, 'a neighbouring own choice is kept');
  assert.equal(shortcutClash('Shift+F12', desk), null, 'free on this desktop');
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Ctrl+Alt+Shift+S', snipDefaultsVersion: 1 }, desk), null, 'chosen again after the one-time move, it sticks');
  assert.equal(migratedSnipHotkey({ snipHotkey: 'Super+Shift+S', snipDefaultsVersion: 1 }, desk), 'Shift+F12', 'a dead Super default still moves');
});

test('arming records the defaults version so the replaced-default move runs once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const arm = src.slice(src.indexOf('function armSnipHotkey'), src.indexOf("ipcMain.handle('snip:setHotkey'"));
  assert.match(arm, /writeConfig\(\{ snipDefaultsVersion: SNIP_DEFAULTS_VERSION \}\)/);
  assert.ok(arm.indexOf('migratedSnipHotkey') < arm.indexOf('snipDefaultsVersion: SNIP_DEFAULTS_VERSION'), 'migrate before stamping');
});

// --- wiring (source reads, the house pattern for main) ---

test('main reads the Cinnamon spices, migrates the saved hotkey and arms with the desktop bindings', () => {
  const index = read('src/main/index.ts');
  assert.match(index, /readCinnamonBindings\(/, 'main never reads the spice keybindings');
  assert.match(index, /migratedSnipHotkey\(/, 'a saved old default is never migrated');
  const arms = index.split('\n').filter((l) => l.includes('snipHotkey.arm('));
  assert.ok(arms.length >= 2, `expected startup and settings arm calls, saw ${arms.length}`);
  for (const line of arms) assert.match(line, /onSnipHotkey,\s*(desktop|cinnamonBindings\(\))\)/, `arm without desktop bindings: ${line.trim()}`);
});
