'use strict';

// Board moves (pin / take / archive) walk the actor to a stand tile at the task
// board. The stands must follow the active theme's board, not the office's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { writeFixturePack } = require('../test-support/theme-pack-fixture.cjs');

const { THEMES } = loadTs('src/renderer/src/scene/office/themeRegistry.ts');
const { scanThemePacks, readThemePackAsset } = loadTs('src/main/themePacks.ts');
const { loadInstalledThemePacks } = loadTs('src/renderer/src/scene/office/themePacks.ts');

// A camp theme comes from a theme pack; the placeholder fixture pack stands in.
const packsReady = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-board-stands-'));
  writeFixturePack(dir);
  const packs = scanThemePacks(dir);
  await loadInstalledThemePacks({
    themePacks: async () => packs,
    themePackAsset: async (id, rel) => readThemePackAsset(dir, id, rel),
  });
})();
const { boardLayout, boardStandTiles } = loadTs('src/renderer/src/scene/office/boardLayout.ts');

const TILE_ID_MASK = 0x1fffffff;

/** Same rule as TiledMapRenderer.parseCollisionLayer: any tile on `collision` blocks. */
function walkabilityOf(mapRaw) {
  const map = JSON.parse(mapRaw);
  const layer = map.layers.find((l) => l.name === 'collision');
  return {
    tileSize: map.tilewidth,
    isWalkable: (x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height
      && (!layer || (layer.data[y * map.width + x] & TILE_ID_MASK) === 0),
  };
}

function themeById(id) {
  const theme = Object.values(THEMES).find((t) => t.id === id);
  assert.ok(theme, `theme ${id} is registered`);
  return theme;
}

function standsFor(theme, sprites) {
  const { tileSize, isWalkable } = walkabilityOf(theme.mapRaw);
  const layout = boardLayout(theme.propStyle, sprites);
  return { stands: boardStandTiles(theme.anchors.boards, tileSize, layout, isWalkable), layout, tileSize, isWalkable };
}

test('camp: every board-move stand sits next to the camp board, not at the office tiles', async () => {
  await packsReady;
  const camp = themeById('meadow');
  const board = camp.anchors.boards;
  const { stands } = standsFor(camp, true);
  const officeTiles = ['8,11', '9,11', '12,11'];
  for (const [kind, t] of Object.entries(stands)) {
    assert.ok(!officeTiles.includes(`${t.x},${t.y}`), `${kind} stand ${t.x},${t.y} is an office tile`);
    assert.ok(t.x >= board.x && t.x <= board.x + 7, `${kind} stand x ${t.x} is beside the board at ${board.x}`);
    assert.ok(t.y > board.y && t.y <= board.y + 3, `${kind} stand y ${t.y} is just below the board at ${board.y}`);
  }
});

test('office: derived stands are the tiles the office always used', () => {
  const { stands } = standsFor(themeById('office'), false);
  assert.deepEqual(stands, { pin: { x: 8, y: 11 }, take: { x: 9, y: 11 }, archive: { x: 12, y: 11 } });
});

test('every theme: stands are walkable, below the drawn board, left to right pin, take, archive', async () => {
  await packsReady;
  assert.ok(THEMES.meadow, 'the fixture camp pack is registered');
  for (const theme of Object.values(THEMES)) {
    for (const sprites of theme.propStyle === 'camp' ? [true, false] : [false]) {
      const { stands, layout, tileSize, isWalkable } = standsFor(theme, sprites);
      const label = `${theme.id}${sprites ? ' (sprites)' : ''}`;
      const boardBottomRow = Math.floor((theme.anchors.boards.y * tileSize + layout.bottom - 1) / tileSize);
      for (const [kind, t] of Object.entries(stands)) {
        assert.ok(isWalkable(t.x, t.y), `${label}: ${kind} stand ${t.x},${t.y} is walkable`);
        assert.ok(t.y > boardBottomRow, `${label}: ${kind} stand row ${t.y} is below the board (row ${boardBottomRow})`);
      }
      assert.ok(stands.pin.x <= stands.take.x && stands.take.x <= stands.archive.x,
        `${label}: pin ${stands.pin.x} <= take ${stands.take.x} <= archive ${stands.archive.x}`);
    }
  }
});

test('OfficeFloor derives the board-move stands instead of hardcoding them', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  assert.match(src, /boardStandTiles\(/);
  assert.doesNotMatch(src, /_STAND: Tile = \{ x: \d+, y: \d+ \}/);
});
