'use strict';

// Builds a small theme pack on disk for tests: placeholder art (flat-colour PNGs
// with real dimensions), a walkable map, an AnimData cast of two members and
// optional branding. Nothing here is drawn from any real game.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A w x h RGBA PNG filled with one colour. */
function png(w, h, rgba = [120, 180, 90, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgba).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Width and height from a PNG's IHDR. */
function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const FRAME = 24;
const ANIMS = { Walk: 4, Attack: 6, DeepBreath: 3, Sit: 2, Sleep: 2 };

function animDataXml() {
  const anims = Object.entries(ANIMS).map(([name]) =>
    `<Anim><Name>${name}</Name><FrameWidth>${FRAME}</FrameWidth><FrameHeight>${FRAME}</FrameHeight></Anim>`);
  anims.push('<Anim><Name>Idle</Name><CopyOf>DeepBreath</CopyOf></Anim>');
  return `<?xml version="1.0" ?>\n<AnimData><ShadowSize>1</ShadowSize><Anims>${anims.join('')}</Anims></AnimData>\n`;
}

const MAP_W = 24;
const MAP_H = 16;

function mapJson() {
  const n = MAP_W * MAP_H;
  const layer = (id, name, fill) => ({
    id, name, type: 'tilelayer', width: MAP_W, height: MAP_H, x: 0, y: 0, opacity: 1, visible: name !== 'collision',
    data: Array.from({ length: n }, () => fill),
  });
  const point = (id, name, tx, ty) => ({ id, name, point: true, x: tx * 16, y: ty * 16, width: 0, height: 0, rotation: 0, type: '', visible: true });
  return {
    compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down', type: 'map',
    version: '1.10', tiledversion: '1.10.2', width: MAP_W, height: MAP_H, tilewidth: 16, tileheight: 16,
    nextlayerid: 6, nextobjectid: 20,
    layers: [
      layer(1, 'floor', 1),
      layer(2, 'collision', 0),
      { id: 3, name: 'spawn-points', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown',
        objects: [
          point(1, 'desk-ceo', 3, 3), point(2, 'pc-1', 6, 10), point(3, 'pc-2', 9, 10),
          point(4, 'cafe-seat-1', 18, 10), point(5, 'cafe-seat-2', 19, 10),
          point(6, 'cafe-stand-coffee', 18, 12), point(7, 'cafe-stand-vending', 20, 12),
        ] },
      { id: 4, name: 'zones', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true, draworder: 'topdown',
        objects: [{ id: 10, name: 'cafeteria', x: 256, y: 128, width: 96, height: 96, rotation: 0, type: '', visible: true }] },
    ],
    tilesets: [{ firstgid: 1, name: 'meadow', image: '../tilesets/meadow.png', imagewidth: 64, imageheight: 64,
      columns: 4, tilecount: 16, tilewidth: 16, tileheight: 16, margin: 0, spacing: 0 }],
  };
}

const MEMBERS = [
  { name: 'sprout', displayName: 'Sprout', shirt: '#6a9a4a', blurb: 'Keeps the meadow tidy.' },
  { name: 'pebble', displayName: 'Pebble', shirt: '#8a8a9a', blurb: 'Steady, sits by the pond.' },
];

function manifest({ id = 'meadow', branding = true } = {}) {
  return {
    format: 1,
    id,
    displayName: 'Meadow',
    blurb: 'A placeholder camp for tests',
    swatch: '#7aa85a',
    map: 'maps/meadow.tmj',
    tilesets: [{ image: 'tilesets/meadow.png' }],
    layout: {
      primarySeatNames: ['desk-ceo', 'pc-1', 'pc-2'],
      cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2'],
      cafeStands: [['cafe-stand-coffee', 'coffee'], ['cafe-stand-vending', 'vending']],
      coffee: { trayTile: { x: 18, y: 13 }, trayStand: { x: 18, y: 14 }, machineStand: { x: 19, y: 14 },
        sinkTile: { x: 20, y: 13 }, sinkStand: { x: 20, y: 14 }, maxCups: 3 },
      anchors: { calendar: { x: 4, y: 2 }, boards: { x: 8, y: 3 }, askBoard: { x: 16, y: 3 } },
      errandSpots: [{ kind: 'water', stand: { x: 7, y: 8 }, facing: 'left', fx: { x: 6, y: 8 }, duration: 6 }],
      monitor: { offTopLeftGid: 2, onGids: [[3, 0, 0]], animate: false },
      cafeSeatLift: 6,
    },
    palette: { noteColors: { todo: '#d9822b' } },
    propStyle: 'camp',
    props: { board: 'props/board.png', counter: 'props/counter.png', stump: 'props/stump.png', berry: 'props/berry.png' },
    bubble: { frame: 'props/bubble.png', font: 'fonts/meadow.ttf' },
    cast: {
      format: 'pmd-animdata',
      boss: 'sprout',
      default: 'pebble',
      portrait: { w: 18, h: 18 },
      spriteStyle: {
        animSpeed: { walk: 0.12, type: 0.1, read: 0.1, idle: 0.06, sit: 0.05, nap: 0.03 },
        idleBehaviour: { pauseSeconds: [10, 25], napChance: 0.3, napSeconds: [45, 90], holdScale: 2 },
      },
      members: MEMBERS,
    },
    lines: {
      scene: { 'office.cheer.0': 'Meadow cheer!' },
      solo: {
        spots: { coffee: ['meadow coffee'], vending: ['meadow vending'], snack: ['meadow snack'], table: ['meadow table'] },
        byCharacter: { sprout: ['sprout line'] },
        heart: ['meadow heart'],
      },
      exchanges: [['meadow hi', 'meadow hello']],
      keyedExchanges: { sprout: [['sprout asks', 'pebble answers']] },
    },
    ...(branding ? { branding: { title: 'Meadow Camp', logo: 'branding/logo.png' } } : {}),
  };
}

/** Writes a valid pack to `<themesDir>/<id>/` and returns its directory. */
function writeFixturePack(themesDir, opts = {}) {
  const m = manifest(opts);
  const dir = path.join(themesDir, m.id);
  const put = (rel, data) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  put('manifest.json', JSON.stringify(m, null, 2));
  put(m.map, JSON.stringify(mapJson()));
  put('tilesets/meadow.png', png(64, 64));
  for (const p of ['board', 'counter', 'stump', 'berry']) put(`props/${p}.png`, png(16, 16, [200, 160, 90, 255]));
  put('props/bubble.png', png(48, 48, [248, 248, 248, 255]));
  put('fonts/meadow.ttf', Buffer.from('not a real font, tests never parse it'));
  if (m.branding) put(m.branding.logo, png(32, 32, [90, 140, 200, 255]));
  for (const member of MEMBERS) {
    const base = `sprites/${member.name}`;
    put(`${base}/AnimData.xml`, animDataXml());
    for (const [anim, cols] of Object.entries(ANIMS)) {
      const rows = anim === 'DeepBreath' ? 1 : 8;
      put(`${base}/${anim}-Anim.png`, png(cols * FRAME, rows * FRAME));
    }
    put(`${base}/portrait.png`, png(40, 40, [250, 220, 120, 255]));
  }
  return dir;
}

module.exports = { writeFixturePack, manifest, png, pngSize, MEMBERS, ANIMS, FRAME };
