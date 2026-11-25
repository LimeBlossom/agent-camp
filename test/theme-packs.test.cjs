'use strict';

// Office themes load at run time from theme packs in <userData>/themes/<id>/,
// each with a manifest.json. The repo ships only the built-in office themes and
// neutral branding; a pack adds its map, art, cast, scene lines and optional app
// branding. A missing folder or a broken pack must never break the floor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveObjectURL } = require('node:buffer');
const loadTs = require('../test-support/load-ts.cjs');
const { writeFixturePack, manifest, pngSize, MEMBERS } = require('../test-support/theme-pack-fixture.cjs');

const main = () => loadTs('src/main/themePacks.ts');
const renderer = () => loadTs('src/renderer/src/scene/office/themePacks.ts');
const registry = () => loadTs('src/renderer/src/scene/office/themeRegistry.ts');
const branding = () => loadTs('src/renderer/src/branding.ts');

function tmpThemes() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-theme-packs-'));
}
function collectWarnings() {
  const warnings = [];
  return { warn: (m) => warnings.push(String(m)), warnings };
}

// ─── main process: scanning <userData>/themes ───────────────────────────────

test('main: the themes folder is <userData>/themes', () => {
  assert.equal(main().themePacksDir('/home/u/.config/munder-difflin'), path.join('/home/u/.config/munder-difflin', 'themes'));
});

test('main: a missing themes folder yields no packs and does not throw', () => {
  const { warn, warnings } = collectWarnings();
  const packs = main().scanThemePacks(path.join(tmpThemes(), 'does-not-exist'), warn);
  assert.deepEqual(packs, []);
  assert.deepEqual(warnings, []);
});

test('main: a valid pack is listed with its manifest and map text', () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  const { warn, warnings } = collectWarnings();
  const packs = main().scanThemePacks(dir, warn);
  assert.deepEqual(warnings, []);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'meadow');
  assert.equal(packs[0].manifest.displayName, 'Meadow');
  assert.equal(JSON.parse(packs[0].mapRaw).width, 24);
});

const BROKEN = {
  'bad JSON': (d) => fs.writeFileSync(path.join(d, 'manifest.json'), '{ not json'),
  'no manifest': (d) => fs.rmSync(path.join(d, 'manifest.json')),
  'id differs from folder': (d) => edit(d, (m) => { m.id = 'elsewhere'; }),
  'unknown format': (d) => edit(d, (m) => { m.format = 99; }),
  'missing map file': (d) => fs.rmSync(path.join(d, 'maps/meadow.tmj')),
  'map path escapes the pack': (d) => edit(d, (m) => { m.map = '../outside.tmj'; }),
  'absolute tileset path': (d) => edit(d, (m) => { m.tilesets = [{ image: '/etc/passwd' }]; }),
  'cast boss not in members': (d) => edit(d, (m) => { m.cast.boss = 'nobody'; }),
  'member sheet missing': (d) => fs.rmSync(path.join(d, 'sprites/pebble/Sleep-Anim.png')),
  'no cast members': (d) => edit(d, (m) => { m.cast.members = []; }),
  'map is not a Tiled map': (d) => fs.writeFileSync(path.join(d, 'maps/meadow.tmj'), '{"width":0}'),
};
function edit(dir, fn) {
  const file = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(m);
  fs.writeFileSync(file, JSON.stringify(m));
}

for (const [label, breakIt] of Object.entries(BROKEN)) {
  test(`main: a pack with ${label} is skipped with a warning; a good pack beside it still loads`, () => {
    const dir = tmpThemes();
    breakIt(writeFixturePack(dir, { id: 'broken' }));
    writeFixturePack(dir, { id: 'meadow' });
    const { warn, warnings } = collectWarnings();
    const packs = main().scanThemePacks(dir, warn);
    assert.deepEqual(packs.map((p) => p.id), ['meadow']);
    assert.equal(warnings.length, 1, `one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /broken/);
  });
}

test('main: a pack may not take a built-in theme id', () => {
  const dir = tmpThemes();
  writeFixturePack(dir, { id: 'office' });
  const { warn, warnings } = collectWarnings();
  assert.deepEqual(main().scanThemePacks(dir, warn), []);
  assert.match(warnings[0], /office/);
});

test('main: pack assets are served only from inside the pack', () => {
  const dir = tmpThemes();
  const pack = writeFixturePack(dir);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(pack, 'props', 'link.png'));
  const { readThemePackAsset } = main();
  const logo = readThemePackAsset(dir, 'meadow', 'branding/logo.png');
  assert.ok(logo && pngSize(Buffer.from(logo)).width === 32, 'a file inside the pack is served');
  for (const [id, rel] of [
    ['meadow', '../secret.txt'], ['meadow', 'props/../../secret.txt'], ['meadow', '/etc/passwd'],
    ['meadow', 'props/link.png'], ['meadow', 'props'], ['meadow', 'nope.png'],
    ['../meadow', 'manifest.json'], ['nobody', 'manifest.json'],
  ]) {
    assert.equal(readThemePackAsset(dir, id, rel), null, `${id} ${rel} is refused`);
  }
});

test('main: the app title is neutral without a branded pack and the pack title with one', () => {
  const { scanThemePacks, appTitle } = main();
  assert.equal(appTitle([]), 'Munder Difflin');
  const dir = tmpThemes();
  writeFixturePack(dir, { id: 'plain', branding: false });
  assert.equal(appTitle(scanThemePacks(dir)), 'Munder Difflin');
  writeFixturePack(dir, { id: 'meadow' });
  assert.equal(appTitle(scanThemePacks(dir)), 'Meadow Camp');
});

// ─── renderer: registering packs as themes ──────────────────────────────────

/** Browser bits the cast builder touches, faked: <img> reads the real PNG size
 *  from its blob URL, canvases record draws and report opaque pixels. */
function withFakeDom(fn) {
  const saved = { document: globalThis.document, Image: globalThis.Image, HTMLCanvasElement: globalThis.HTMLCanvasElement };
  const draws = [];
  class FakeCanvas {
    constructor() { this.width = 0; this.height = 0; }
    getContext() {
      const canvas = this;
      return {
        imageSmoothingEnabled: true,
        drawImage: (...args) => draws.push(args),
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) }),
        isContextLost: () => false,
      };
    }
  }
  class FakeImage {
    set src(url) {
      this._src = url;
      const blob = resolveObjectURL(url);
      if (!blob) { setImmediate(() => this.onerror?.(new Error(`no blob for ${url}`))); return; }
      blob.arrayBuffer().then((buf) => {
        const { width, height } = pngSize(Buffer.from(buf));
        Object.assign(this, { width, height, naturalWidth: width, complete: true });
        this.onload?.();
      });
    }
    get src() { return this._src; }
  }
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.Image = FakeImage;
  globalThis.document = { createElement: () => new FakeCanvas() };
  return Promise.resolve(fn(draws)).finally(() => Object.assign(globalThis, saved));
}

/** The preload API the renderer uses, backed by the real main-process scan. */
function apiFor(themesDir) {
  const m = main();
  return {
    themePacks: async () => m.scanThemePacks(themesDir),
    themePackAsset: async (id, rel) => {
      const buf = m.readThemePackAsset(themesDir, id, rel);
      return buf ? new Uint8Array(buf) : null;
    },
  };
}

test('renderer: with no packs installed the floor is the office and branding is neutral', async () => {
  const { loadInstalledThemePacks } = renderer();
  const { getTheme, OFFICE_THEME } = registry();
  const result = await loadInstalledThemePacks(apiFor(path.join(tmpThemes(), 'missing')));
  assert.deepEqual(result.registered, []);
  assert.equal(getTheme('sample-pack'), OFFICE_THEME, 'an uninstalled pack id falls back to the office');
  const b = branding().branding();
  assert.equal(b.title, 'Munder Difflin');
  assert.equal(b.logo, branding().DEFAULT_BRANDING.logo);
  assert.doesNotMatch(b.logo, /poke/i);
});

test('renderer: the preload API failing leaves the office and neutral branding', async () => {
  const { loadInstalledThemePacks } = renderer();
  const result = await loadInstalledThemePacks({
    themePacks: async () => { throw new Error('ipc down'); },
    themePackAsset: async () => null,
  });
  assert.deepEqual(result.registered, []);
  assert.equal(branding().branding().title, 'Munder Difflin');
});

test('renderer: a valid pack registers as a theme with its map, art, layout and palette', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    const { getTheme, OFFICE_THEME } = registry();
    const { resolveThemeMap, themeTilesetUrls } = loadTs('src/renderer/src/scene/office/themeLoader.ts');
    const result = await loadInstalledThemePacks(apiFor(dir));
    assert.deepEqual(result.registered, ['meadow']);
    const theme = getTheme('meadow');
    assert.equal(theme.id, 'meadow');
    const map = resolveThemeMap(theme);
    assert.equal(map.width, 24);
    assert.equal(map.tilesets[0].firstgid, 1, 'a tileset with no inline metadata keeps the map entry');
    const [tileUrl] = themeTilesetUrls(theme);
    const tileBlob = resolveObjectURL(tileUrl);
    assert.ok(tileBlob, 'tileset URL is a blob URL of the pack file');
    assert.equal(pngSize(Buffer.from(await tileBlob.arrayBuffer())).width, 64);
    assert.deepEqual(theme.primarySeatNames, ['desk-ceo', 'pc-1', 'pc-2']);
    assert.deepEqual(theme.anchors.askBoard, { x: 16, y: 3 });
    assert.equal(theme.cafeSeatLift, 6);
    assert.equal(theme.propStyle, 'camp');
    assert.ok(theme.propSprites && resolveObjectURL(theme.propSprites.board));
    assert.ok(theme.bubble && resolveObjectURL(theme.bubble.font));
    assert.equal(theme.palette.noteColors.todo, 0xd9822b);
    assert.equal(theme.palette.noteColors.doing, OFFICE_THEME.palette.noteColors.doing);
    assert.equal(theme.palette.background, OFFICE_THEME.palette.background);
    assert.equal(theme.monitor.animate, false);
  });
});

test('renderer: a pack cast supplies names, blurbs, boss and AnimData frames', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async (draws) => {
    const { loadInstalledThemePacks } = renderer();
    await loadInstalledThemePacks(apiFor(dir));
    const { cast } = registry().getTheme('meadow');
    assert.deepEqual(cast.members.map((m) => [m.name, m.displayName, m.blurb]),
      MEMBERS.map((m) => [m.name, m.displayName, m.blurb]));
    assert.equal(cast.bossCharacter, 'sprout');
    assert.equal(cast.defaultCharacter, 'pebble');
    assert.equal(typeof cast.clearFrames, 'function');
    assert.deepEqual(cast.spriteStyle.animFrames.walk, [0, 1, 2, 3]);
    assert.deepEqual(cast.spriteStyle.animFrames.sit, [18]);
    assert.equal(cast.spriteStyle.idleBehaviour.holdScale, 2);
    const frames = await cast.getFrames('sprout');
    assert.equal(frames.length, 3, 'down, up and right rows');
    for (const row of frames) assert.equal(row.length, 4 + 8 + 6 + 3 + 2);
    const fallback = await cast.getFrames('not-in-the-cast');
    assert.equal(fallback.length, 3, 'an unknown name draws the default member');
    draws.length = 0;
    await cast.portrait.paint(new globalThis.HTMLCanvasElement().getContext('2d'), 'pebble', 2);
    assert.equal(draws.length, 1, 'the portrait is painted');
    assert.equal(draws[0][1], 0);
    assert.equal(draws[0][3], 36, 'portrait fills portrait.w * scale');
  });
});

test('renderer: a broken pack cast rejects without poisoning the frame cache', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    let failAsset = true;
    const api = apiFor(dir);
    await loadInstalledThemePacks({
      ...api,
      themePackAsset: async (id, rel) => (failAsset && /Walk-Anim/.test(rel) ? null : api.themePackAsset(id, rel)),
    });
    const { cast } = registry().getTheme('meadow');
    await assert.rejects(cast.getFrames('sprout'));
    failAsset = false;
    const frames = await cast.getFrames('sprout');
    assert.equal(frames.length, 3, 'a later call rebuilds instead of returning the cached rejection');
  });
});

test('renderer: a branded pack sets the app title and logo', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    const result = await loadInstalledThemePacks(apiFor(dir));
    const b = branding().branding();
    assert.equal(b.title, 'Meadow Camp');
    assert.equal(result.branding.title, 'Meadow Camp');
    const blob = resolveObjectURL(b.logo);
    assert.ok(blob, 'logo is a blob URL of the pack logo');
    assert.equal(pngSize(Buffer.from(await blob.arrayBuffer())).width, 32);
  });
});

test('renderer: an unbranded pack keeps the neutral branding', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir, { branding: false });
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    await loadInstalledThemePacks(apiFor(dir));
    assert.equal(branding().branding().title, 'Munder Difflin');
  });
});

test('renderer: a pack whose art fails to load is skipped, not registered', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    const api = apiFor(dir);
    const warnings = [];
    const result = await loadInstalledThemePacks({
      ...api, themePackAsset: async (id, rel) => (rel.startsWith('tilesets/') ? null : api.themePackAsset(id, rel)),
    }, (m) => warnings.push(String(m)));
    assert.deepEqual(result.registered, []);
    assert.equal(registry().getTheme('meadow').id, 'office');
    assert.match(warnings.join('\n'), /meadow/);
  });
});

test('renderer: the theme picker lists built-in themes plus installed packs', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks, themeChoices } = renderer();
    const before = themeChoices().map((c) => c.id);
    assert.ok(before.includes('office'));
    assert.ok(!before.includes('sample-pack'), 'no entry for an uninstalled pack');
    await loadInstalledThemePacks(apiFor(dir));
    const meadow = themeChoices().find((c) => c.id === 'meadow');
    assert.deepEqual(meadow, { id: 'meadow', label: 'Meadow', blurb: 'A placeholder camp for tests', built: true, swatch: '#7aa85a' });
  });
});

test('renderer: camp break lines come from the pack, the office keeps its own', async () => {
  const dir = tmpThemes();
  writeFixturePack(dir);
  await withFakeDom(async () => {
    const { loadInstalledThemePacks } = renderer();
    await loadInstalledThemePacks(apiFor(dir));
    const { lines } = registry().getTheme('meadow');
    assert.equal(lines.scene['office.cheer.0'], 'Meadow cheer!');
    const { pickSoloLine, pickExchange } = loadTs('src/renderer/src/scene/office/cafeteriaLines.ts');
    const pack = manifest().lines;
    const allowed = new Set([...Object.values(pack.solo.spots).flat(), ...pack.solo.byCharacter.sprout, ...pack.solo.heart]
      .map((l) => l[0].toUpperCase() + l.slice(1)));
    for (let seed = 0; seed < 40; seed++) {
      const line = pickSoloLine('sprout', 'coffee', seed, lines);
      assert.ok(allowed.has(line), `"${line}" comes from the pack`);
    }
    assert.deepEqual(pickExchange('sprout', 4, lines), ['Sprout asks', 'Pebble answers']);
    assert.deepEqual(pickExchange('pebble', 3, lines), ['Meadow hi', 'Meadow hello']);
    const office = pickSoloLine('jim', 'coffee', 1);
    assert.ok(!allowed.has(office), 'no lines means the office pools');
  });
});
