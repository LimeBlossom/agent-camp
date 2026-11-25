'use strict';

// camp-snip-to-card step 3: right after the snip, one small Camp window with the
// preview and a note field. Enter submits, Esc discards, and it only ever opens
// from the human's own keypress.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { noteKeyAction, snipTitle, SNIP_TITLE_MAX, centeredBounds } = loadTs('src/shared/snip.ts');
const { createSnipSession } = loadTs('src/main/snipSession.ts');

test('Enter submits, Shift+Enter is a new line, Esc discards, other keys type', () => {
  assert.equal(noteKeyAction({ key: 'Enter' }), 'submit');
  assert.equal(noteKeyAction({ key: 'Enter', shiftKey: true }), null);
  assert.equal(noteKeyAction({ key: 'Escape' }), 'discard');
  assert.equal(noteKeyAction({ key: 'a' }), null);
});

test('Enter while an input method is composing does not submit half a word', () => {
  assert.equal(noteKeyAction({ key: 'Enter', isComposing: true }), null);
});

test('the card title is the first non-blank line of the note', () => {
  assert.equal(snipTitle('\n  Save button does nothing  \nsecond line', 'Snip: Unity'), 'Save button does nothing');
  assert.equal(snipTitle('   \n ', 'Snip: Unity'), 'Snip: Unity', 'an empty note still files, titled after the app');
  const long = 'x'.repeat(SNIP_TITLE_MAX + 40);
  const t = snipTitle(long, 'f');
  assert.ok(t.length <= SNIP_TITLE_MAX, `title is ${t.length} chars`);
});

test('the note window opens centred on the monitor where the snip was taken', () => {
  assert.deepEqual(centeredBounds({ x: 3440, y: 540, width: 1600, height: 900 }, { width: 520, height: 420 }),
    { x: 3440 + 540, y: 540 + 240, width: 520, height: 420 });
  assert.deepEqual(centeredBounds({ x: 0, y: 0, width: 400, height: 300 }, { width: 520, height: 420 }),
    { x: 0, y: 0, width: 400, height: 300 }, 'never larger than the work area');
});

test('the note window gets the snip and the app context, and its text reaches filing untouched', async () => {
  const seen = [];
  const filed = [];
  const ctx = { window: { title: 'Unity 6 - Main' }, kind: 'unity', logs: [], errors: [] };
  const session = createSnipSession({
    stack: async () => [],
    pickRegion: async () => ({ rect: { x: 0, y: 0, width: 40, height: 40 }, png: Buffer.from('img') }),
    context: async () => ctx,
    askNote: async (png, c) => { seen.push([png.toString(), c]); return 'Title line\n\nDetails'; },
    file: (input) => { filed.push(input); return { ok: true, cardId: 'snip-1' }; },
    log: () => {},
    now: () => new Date('2026-11-19T20:15:02Z')
  });
  assert.deepEqual(await session.start(), { status: 'filed', cardId: 'snip-1' });
  assert.deepEqual(seen, [['img', ctx]]);
  assert.equal(filed[0].note, 'Title line\n\nDetails');
  assert.equal(filed[0].png.toString(), 'img');
  assert.equal(filed[0].context, ctx);
});

test('the note view uses the shared key rules and shows the snip preview', () => {
  assert.match(read('src/renderer/src/main.tsx'), /SnipNote/, 'main.tsx does not route the note view');
  const note = read('src/renderer/src/snip/SnipNote.tsx');
  assert.match(note, /noteKeyAction\(/, 'the note window has its own key rules');
  assert.match(note, /<img/, 'no snip preview');
  assert.match(note, /<textarea/, 'no note field');
});

test('snip windows open from the hotkey and nowhere else', () => {
  const mainDir = path.join(root, 'src/main');
  const starts = [];
  for (const f of fs.readdirSync(mainDir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(mainDir, f), 'utf8');
    for (const m of src.matchAll(/snipSession\.start\(/g)) starts.push({ f, at: m.index, src });
  }
  assert.equal(starts.length, 1, `snipSession.start( is called ${starts.length} times: ${starts.map((s) => s.f).join(', ')}`);
  const { src, at } = starts[0];
  const line = src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
  assert.match(line, /const onSnipHotkey = /, 'the one start() call is not the hotkey callback');
  const uses = [...src.matchAll(/onSnipHotkey/g)].length - 1;
  const asArmArg = [...src.matchAll(/\.arm\([^;\n]*onSnipHotkey(,[^;\n]*)?\)/g)].length;
  assert.ok(uses >= 1, 'the hotkey callback is never armed');
  assert.equal(asArmArg, uses, 'onSnipHotkey is used somewhere other than as the armed callback');
});
