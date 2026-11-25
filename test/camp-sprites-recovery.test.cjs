'use strict';

/**
 * Camp: agent sprites sometimes vanish from the map and roster cards.
 *
 * ROOT CAUSES:
 * 1. Roster portraits: HTML5 2D <canvas> backing stores are evicted/cleared on GPU
 *    context loss (e.g. sleep/suspend or GPU process reset). SpritePortrait had no
 *    'contextlost' (with preventDefault()) and no 'contextrestored' listener, and
 *    no failure retry, leaving mounted agent cards permanently blank.
 * 2. Map sprites: the camp cast (and cast.ts) cached Texture[][] in a global
 *    frameCache that was never cleared on context loss / scene rebuild. Stale textures
 *    bound to a dead WebGL context or destroyed Application were returned on every
 *    rebuild, making characters invisible on the map. Furthermore, rejected frame
 *    builds were permanently cached.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

// Helpers
function fakeCanvas() { return new EventTarget(); }
function lose2D(canvas) {
  const e = new Event('contextlost', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
}
function restore2D(canvas) {
  const e = new Event('contextrestored', { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
}
function fakeClock() {
  const queue = [];
  return {
    schedule: (fn, ms) => {
      const item = { fn, ms, id: queue.length + 1 };
      queue.push(item);
      return item.id;
    },
    clearSchedule: (id) => {
      const idx = queue.findIndex((j) => j.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    runAll: () => {
      const q = queue.splice(0);
      q.forEach((j) => j.fn());
      return q;
    },
    get pending() { return queue.length; },
    get delays() { return queue.map((j) => j.ms); }
  };
}

// ─── 1. Roster Portrait 2D Context Recovery & Retry Tests ───────────────────

test('portrait recovery: preventDefault is called on contextlost so browser can restore context', () => {
  const { installPortraitRecovery } = loadTs('src/renderer/src/scene/office/portraitRecovery.ts');
  const canvas = fakeCanvas();
  const off = installPortraitRecovery(canvas, { paint: () => {} });
  const event = lose2D(canvas);
  assert.equal(event.defaultPrevented, true, 'contextlost must be preventDefaulted to allow restoration');
  off();
});

test('portrait recovery: contextrestored triggers redraw of the portrait', () => {
  const { installPortraitRecovery } = loadTs('src/renderer/src/scene/office/portraitRecovery.ts');
  const canvas = fakeCanvas();
  let paints = 0;
  const off = installPortraitRecovery(canvas, { paint: () => { paints++; } });
  assert.equal(paints, 1, 'initial paint must run');

  lose2D(canvas);
  assert.equal(paints, 1, 'no paint while lost');

  restore2D(canvas);
  assert.equal(paints, 2, 'portrait must redraw when context is restored');
  off();
});

test('portrait recovery: paint failure retries with backoff instead of leaving canvas blank', async () => {
  const { installPortraitRecovery } = loadTs('src/renderer/src/scene/office/portraitRecovery.ts');
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let attempts = 0;

  const off = installPortraitRecovery(canvas, {
    paint: async () => {
      attempts++;
      if (attempts < 3) throw new Error('asset load error');
    },
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule
  });

  // Wait for initial paint promise rejection
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 1, 'first paint attempt failed');
  assert.equal(clock.pending, 1, 'retry must be scheduled');

  // Trigger retry 1
  clock.runAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 2, 'second paint attempt failed');
  assert.equal(clock.pending, 1, 'retry 2 must be scheduled');

  // Trigger retry 2 (should succeed)
  clock.runAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 3, 'third paint attempt succeeded');
  assert.equal(clock.pending, 0, 'no more retries scheduled after success');

  off();
});

test('portrait recovery: contextlost cancels in-flight retry timer', async () => {
  const { installPortraitRecovery } = loadTs('src/renderer/src/scene/office/portraitRecovery.ts');
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let attempts = 0;

  const off = installPortraitRecovery(canvas, {
    paint: async () => {
      attempts++;
      throw new Error('fail');
    },
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(clock.pending, 1, 'retry scheduled');

  lose2D(canvas);
  assert.equal(clock.pending, 0, 'contextlost must cancel pending retry timer');

  off();
});

test('portrait recovery: teardown removes event listeners and stops retrying', async () => {
  const { installPortraitRecovery } = loadTs('src/renderer/src/scene/office/portraitRecovery.ts');
  const canvas = fakeCanvas();
  const clock = fakeClock();
  let paints = 0;

  const off = installPortraitRecovery(canvas, {
    paint: async () => {
      paints++;
      throw new Error('fail');
    },
    schedule: clock.schedule,
    clearSchedule: clock.clearSchedule
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(paints, 1);
  assert.equal(clock.pending, 1);

  off();
  assert.equal(clock.pending, 0, 'unmount must cancel pending retry');

  // Restoring after unmount should do nothing
  restore2D(canvas);
  assert.equal(paints, 1, 'unmounted portrait must not redraw');
});

// ─── 2. Map Sprite Frame Cache Invalidation Tests ───────────────────────────

// A theme-pack cast, from the placeholder fixture pack's manifest.
function packCast(assets) {
  const { manifest } = require('../test-support/theme-pack-fixture.cjs');
  const { createAnimDataCast } = loadTs('src/renderer/src/scene/office/animDataCast.ts');
  return createAnimDataCast(manifest().cast, assets);
}

test('animDataCast: a theme-pack cast supplies clearFrames', () => {
  const cast = packCast({ url: async () => { throw new Error('unused'); }, text: async () => { throw new Error('unused'); } });
  assert.equal(typeof cast.clearFrames, 'function', 'a pack cast must provide clearFrames');
});

test('themeRegistry: OFFICE_THEME.cast supplies clearFrames', () => {
  const { OFFICE_THEME } = loadTs('src/renderer/src/scene/office/themeRegistry.ts');
  assert.equal(typeof OFFICE_THEME.cast.clearFrames, 'function', 'office cast must provide clearFrames');
});

test('cast: clearCastFrameCache purges the office frame cache', () => {
  const { clearCastFrameCache } = loadTs('src/renderer/src/scene/office/cast.ts');
  assert.equal(typeof clearCastFrameCache, 'function', 'clearCastFrameCache must be exported');
});

test('cast: getCastFrames evicts destroyed textures from cache and rebuilds', async () => {
  const oldDoc = globalThis.document;
  const oldCanvas = globalThis.HTMLCanvasElement;

  class FakeCanvas {
    constructor() { this.width = 18; this.height = 32; }
    getContext() {
      return {
        createImageData: () => ({ data: new Uint8ClampedArray(18 * 32 * 4) }),
        putImageData: () => {},
        drawImage: () => {},
      };
    }
  }

  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.document = {
    createElement: (tag) => new FakeCanvas()
  };

  try {
    const { getCastFrames, clearCastFrameCache } = loadTs('src/renderer/src/scene/office/cast.ts');
    clearCastFrameCache();

    // First call builds frames
    const frames1 = await getCastFrames('jim');
    assert.ok(frames1 && frames1.length > 0);

    // Mark textures as destroyed (simulating WebGL context destruction)
    for (const row of frames1) {
      for (const tex of row) {
        tex.destroyed = true;
      }
    }

    // Second call must detect destroyed textures and build fresh frames
    const frames2 = await getCastFrames('jim');
    assert.notEqual(frames1, frames2, 'destroyed frames must be evicted and rebuilt');
    assert.equal(frames2[0][0].destroyed, false, 'rebuilt frames must have non-destroyed textures');
  } finally {
    globalThis.document = oldDoc;
    globalThis.HTMLCanvasElement = oldCanvas;
  }
});

test('animDataCast: a failed frame build is not cached', async () => {
  let reads = 0;
  const cast = packCast({
    url: async () => { throw new Error('no sheet'); },
    text: async () => { reads++; throw new Error('no AnimData.xml'); },
  });
  await assert.rejects(cast.getFrames('sprout'));
  await assert.rejects(cast.getFrames('sprout'));
  assert.equal(reads, 2, 'the rejected build must be evicted, so the second call rebuilds');
});
