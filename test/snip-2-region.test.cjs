'use strict';

// camp-snip-to-card step 2: drag a rectangle over the frozen screen, Esc files
// nothing, and the PNG lands in the hive under card-attachments.
// The overlay itself is Electron UI and gets no GUI smoke here (card boundary);
// these pin the geometry it relies on and the session around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { dragRect, MIN_SNIP_PX, cropRect, globalRect, displaySlices } = loadTs('src/shared/snip.ts');
const { createSnipSession } = loadTs('src/main/snipSession.ts');
const { fileSnipCard, SNIP_ATTACH_DIR } = loadTs('src/main/snipCard.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// Dual-monitor layout: a 3440x1440 ultrawide at the origin and a
// 1600x900 monitor to its right, 540 px down.
const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, scaleFactor: 1 },
  { id: 2, bounds: { x: 3440, y: 540, width: 1600, height: 900 }, scaleFactor: 1 }
];

test('a drag in any direction gives the same rectangle', () => {
  const want = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(dragRect({ x: 10, y: 20 }, { x: 110, y: 70 }), want);
  assert.deepEqual(dragRect({ x: 110, y: 70 }, { x: 10, y: 20 }), want);
  assert.deepEqual(dragRect({ x: 10, y: 70 }, { x: 110, y: 20 }), want);
});

test('a click or a sliver is not a snip', () => {
  assert.equal(dragRect({ x: 5, y: 5 }, { x: 5, y: 5 }), null);
  assert.equal(dragRect({ x: 5, y: 5 }, { x: 5 + MIN_SNIP_PX - 1, y: 300 }), null);
  assert.ok(dragRect({ x: 5, y: 5 }, { x: 5 + MIN_SNIP_PX, y: 5 + MIN_SNIP_PX }));
});

test('the crop scales to device pixels and stays inside the captured image', () => {
  assert.deepEqual(cropRect({ x: 10, y: 10, width: 100, height: 40 }, 2, { width: 1000, height: 1000 }),
    { x: 20, y: 20, width: 200, height: 80 });
  assert.deepEqual(cropRect({ x: 950, y: 980, width: 100, height: 100 }, 1, { width: 1000, height: 1000 }),
    { x: 950, y: 980, width: 50, height: 20 }, 'clamped to the image edge');
});

test('a rectangle on the second monitor maps to global X11 pixels for the window lookup', () => {
  assert.deepEqual(globalRect(DISPLAYS[1], { x: 100, y: 50, width: 200, height: 100 }),
    { x: 3540, y: 590, width: 200, height: 100 });
  assert.deepEqual(globalRect(DISPLAYS[0], { x: 100, y: 50, width: 200, height: 100 }),
    { x: 100, y: 50, width: 200, height: 100 });
});

test('one whole-desktop capture is sliced into one frozen image per monitor', () => {
  // X11 can hand back a single source covering the virtual desktop (5040x1440).
  assert.deepEqual(displaySlices({ width: 5040, height: 1440 }, DISPLAYS), [
    { displayId: 1, crop: { x: 0, y: 0, width: 3440, height: 1440 } },
    { displayId: 2, crop: { x: 3440, y: 540, width: 1600, height: 900 } }
  ]);
});

// --- the session around the overlay -----------------------------------------

function deps(over = {}) {
  const calls = { pickRegion: 0, askNote: 0, file: [], context: 0, log: [] };
  const d = {
    stack: async () => [],
    pickRegion: async () => { calls.pickRegion++; return { rect: { x: 1, y: 1, width: 50, height: 50 }, png: Buffer.from('png') }; },
    context: async () => { calls.context++; return { window: {}, kind: 'other', logs: [], errors: [] }; },
    askNote: async () => { calls.askNote++; return 'Broken button\nmore'; },
    file: (input) => { calls.file.push(input); return { ok: true, cardId: 'snip-x' }; },
    log: (l) => calls.log.push(l),
    now: () => new Date('2026-11-19T20:15:02Z'),
    ...over
  };
  return { d, calls };
}

test('the window stack is read before the overlay opens, and the context sees that stack and the drag', async () => {
  const order = [];
  const stack = [{ id: '0x2', x: 0, y: 0, width: 10, height: 10, viewable: true }];
  const rect = { x: 3540, y: 590, width: 200, height: 100 };
  let seen;
  const { d } = deps({
    stack: async () => { order.push('stack'); return stack; },
    pickRegion: async () => { order.push('overlay'); return { rect, png: Buffer.from('p') }; },
    context: async (s, r) => { order.push('context'); seen = [s, r]; return { window: {}, kind: 'other', logs: [], errors: [] }; },
    askNote: async () => { order.push('note'); return 'n'; }
  });
  await createSnipSession(d).start();
  assert.deepEqual(order, ['stack', 'overlay', 'context', 'note'], 'the overlay would be the window under the snip');
  assert.equal(seen[0], stack);
  assert.deepEqual(seen[1], rect);
});

test('Esc on the overlay ends the snip: no note window, nothing filed', async () => {
  const { d, calls } = deps({ pickRegion: async () => null });
  const out = await createSnipSession(d).start();
  assert.deepEqual(out, { status: 'cancelled', at: 'region' });
  assert.equal(calls.askNote, 0);
  assert.equal(calls.file.length, 0);
});

test('a second press while a snip is open does not open a second overlay', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { d, calls } = deps({ pickRegion: async () => { calls.pickRegion++; await gate; return null; } });
  const session = createSnipSession(d);
  const first = session.start();
  assert.equal(session.busy(), true);
  assert.deepEqual(await session.start(), { status: 'busy' });
  release();
  await first;
  assert.equal(calls.pickRegion, 1);
  assert.equal(session.busy(), false, 'the session frees itself once the snip ends');
});

test('a failure inside the snip is logged, reported, and frees the session', async () => {
  const { d, calls } = deps({ pickRegion: async () => { throw new Error('capture failed'); } });
  const session = createSnipSession(d);
  const out = await session.start();
  assert.equal(out.status, 'failed');
  assert.match(out.error, /capture failed/);
  assert.ok(calls.log.some((l) => /capture failed/.test(l)));
  assert.equal(session.busy(), false);
});

test('a cancelled snip leaves the hive untouched; a filed one writes its PNG under card-attachments', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-snip-region-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  const before = JSON.stringify(hive.tasks());
  const real = (over) => deps({ file: (input) => fileSnipCard(hive, input), ...over }).d;

  await createSnipSession(real({ pickRegion: async () => null })).start();
  await createSnipSession(real({ askNote: async () => null })).start();
  assert.equal(fs.existsSync(path.join(hive.root(), SNIP_ATTACH_DIR)), false, 'a cancel wrote attachments');
  assert.equal(JSON.stringify(hive.tasks()), before, 'a cancel changed tasks.json');

  const out = await createSnipSession(real({})).start();
  assert.equal(out.status, 'filed');
  const png = path.join(hive.root(), SNIP_ATTACH_DIR, out.cardId, 'snip.png');
  assert.equal(fs.readFileSync(png, 'utf8'), 'png');
});

test('the overlay view handles Esc and hands the drag to main', () => {
  const main = read('src/renderer/src/main.tsx');
  assert.match(main, /SnipOverlay/, 'main.tsx does not route the snip overlay view');
  const overlay = read('src/renderer/src/snip/SnipOverlay.tsx');
  assert.match(overlay, /'Escape'/, 'the overlay does not handle Esc');
  assert.match(overlay, /dragRect\(/, 'the overlay does not use the shared drag geometry');
  assert.match(read('src/preload/index.ts'), /snipRegion:|snipCancel:/, 'no preload bridge for the overlay');
});
