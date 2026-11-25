// Theme packs: office themes installed at run time from <userData>/themes/<id>/.
// Each pack folder holds a manifest.json (ThemePackManifest) and the files it
// names, all as paths relative to the pack folder. The main process validates a
// pack and serves its files; the renderer turns it into a ThemeConfig.

export const THEME_PACK_FORMAT = 1;
export const DEFAULT_APP_TITLE = 'Munder Difflin';

/** Themes compiled into the app. A pack may not take one of these ids. */
export const BUILT_IN_THEME_IDS = ['office', 'friends', 'brooklyn99', 'siliconvalley', 'got', 'hogwarts'] as const;

const PACK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** PMD-style animation sheet names, by the role the floor plays them in. */
export const DEFAULT_PMD_ANIMS = { walk: 'Walk', work: 'Attack', idle: 'DeepBreath', sit: 'Sit', nap: 'Sleep' } as const;
export type PmdRole = keyof typeof DEFAULT_PMD_ANIMS;

export interface PackTile { x: number; y: number }
export type PackFacing = 'up' | 'down' | 'left' | 'right';

/** One tileset atlas. With only `image`, the map's own tileset entry at the same
 *  index supplies the metadata; otherwise these fields replace it. */
export interface PackTileset {
  image: string;
  name?: string;
  firstgid?: number;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  tilecount?: number;
}

export interface PackErrandSpot {
  kind: 'water' | 'window' | 'dispenser' | 'fridge' | 'shelf' | 'bin' | 'smoke';
  stand: PackTile;
  facing: PackFacing;
  fx: PackTile;
  duration: number;
  godOnly?: boolean;
}

export interface PackLayout {
  primarySeatNames: string[];
  cafeSeatNames: string[];
  cafeStands: Array<[string, 'coffee' | 'vending']>;
  coffee: {
    trayTile: PackTile; trayStand: PackTile; machineStand: PackTile;
    sinkTile: PackTile; sinkStand: PackTile; maxCups: number;
  };
  anchors: { calendar: PackTile; boards: PackTile; clock?: PackTile; askBoard?: PackTile };
  errandSpots: PackErrandSpot[];
  monitor: { offTopLeftGid: number; onGids: Array<[number, number, number]>; animate?: boolean };
  cafeSeatLift?: number;
}

/** Colours are '#rrggbb'. Unset entries keep the office palette. */
export interface PackPalette { background?: string; noteColors?: Record<string, string> }

export interface PackBubble {
  frame: string;
  font: string;
  border?: number;
  fontSize?: number;
  textColor?: string;
  padX?: number;
  padY?: number;
  offsetY?: number;
  puffFill?: string;
  puffOutline?: string;
}

export interface PackCastMember { name: string; displayName: string; shirt: string; blurb: string }

/** How PMD sheets are cut into the floor's fixed frame grid. */
export interface PackSprites {
  canvas?: number;
  feetRow?: number;
  anims?: Partial<Record<PmdRole, string>>;
  counts?: Partial<Record<PmdRole, number>>;
}

export interface PackSpriteStyle {
  animSpeed?: Partial<Record<'walk' | 'type' | 'read' | 'idle' | 'sit' | 'nap', number>>;
  seatedCrop?: boolean;
  scale?: number;
  idleBehaviour?: {
    pauseSeconds: [number, number];
    napChance: number;
    napSeconds: [number, number];
    holdScale: number;
  };
}

/** Member sprites live in sprites/<name>/: AnimData.xml, portrait.png and one
 *  `<Anim>-Anim.png` sheet per role in `sprites.anims`. */
export interface PackCast {
  format: 'pmd-animdata';
  boss: string;
  default: string;
  members: PackCastMember[];
  portrait?: { w: number; h: number };
  sprites?: PackSprites;
  spriteStyle?: PackSpriteStyle;
}

export type PackExchange = string[];
export interface PackLines {
  /** Office i18n key -> the line this theme says instead. */
  scene?: Record<string, string>;
  solo?: {
    spots?: Partial<Record<'coffee' | 'vending' | 'snack' | 'table', string[]>>;
    byCharacter?: Record<string, string[]>;
    heart?: string[];
  };
  exchanges?: PackExchange[];
  keyedExchanges?: Record<string, PackExchange[]>;
}

export interface PackBranding { title?: string; logo?: string }

export interface ThemePackManifest {
  format: typeof THEME_PACK_FORMAT;
  id: string;
  displayName: string;
  blurb?: string;
  swatch?: string;
  map: string;
  tilesets: PackTileset[];
  layout: PackLayout;
  palette?: PackPalette;
  propStyle?: 'office' | 'camp';
  props?: { board: string; counter: string; stump: string; berry: string };
  bubble?: PackBubble;
  cast: PackCast;
  lines?: PackLines;
  branding?: PackBranding;
}

/** A validated pack as the main process hands it to the renderer. */
export interface InstalledThemePack {
  id: string;
  manifest: ThemePackManifest;
  mapRaw: string;
}

export type ManifestResult = { ok: true; manifest: ThemePackManifest } | { ok: false; error: string };

/** A pack-relative file path: no absolute paths, backslashes or `.`/`..` segments. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function isValidPackId(id: unknown): id is string {
  return typeof id === 'string' && PACK_ID.test(id);
}

export function isBuiltInThemeId(id: string): boolean {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(id);
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** '#rrggbb' -> 0xrrggbb. */
export function parseHexColor(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

class ManifestError extends Error {}

function fail(msg: string): never { throw new ManifestError(msg); }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, at: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${at} must be a number`));
const str = (v: unknown, at: string): string => (typeof v === 'string' && v ? v : fail(`${at} must be a non-empty string`));
const path = (v: unknown, at: string): string => (isSafeRelativePath(v) ? v : fail(`${at} must be a path inside the pack, got ${JSON.stringify(v)}`));
const color = (v: unknown, at: string): string => (typeof v === 'string' && HEX.test(v) ? v : fail(`${at} must be a '#rrggbb' colour`));
const tile = (v: unknown, at: string): PackTile => {
  if (!isObj(v)) fail(`${at} must be a tile {x, y}`);
  num(v.x, `${at}.x`); num(v.y, `${at}.y`);
  return v as unknown as PackTile;
};
const strings = (v: unknown, at: string): string[] => {
  if (!Array.isArray(v)) fail(`${at} must be a list of strings`);
  v.forEach((s, i) => str(s, `${at}[${i}]`));
  return v as string[];
};
const optional = <T>(v: unknown, check: (v: unknown) => T): T | undefined => (v === undefined ? undefined : check(v));

function checkLayout(v: unknown): void {
  if (!isObj(v)) fail('layout must be an object');
  strings(v.primarySeatNames, 'layout.primarySeatNames');
  strings(v.cafeSeatNames, 'layout.cafeSeatNames');
  if (!Array.isArray(v.cafeStands)) fail('layout.cafeStands must be a list');
  v.cafeStands.forEach((s, i) => {
    if (!Array.isArray(s) || typeof s[0] !== 'string' || (s[1] !== 'coffee' && s[1] !== 'vending')) {
      fail(`layout.cafeStands[${i}] must be [spawn-point name, 'coffee' | 'vending']`);
    }
  });
  const c = v.coffee;
  if (!isObj(c)) fail('layout.coffee must be an object');
  for (const k of ['trayTile', 'trayStand', 'machineStand', 'sinkTile', 'sinkStand']) tile(c[k], `layout.coffee.${k}`);
  num(c.maxCups, 'layout.coffee.maxCups');
  const a = v.anchors;
  if (!isObj(a)) fail('layout.anchors must be an object');
  tile(a.calendar, 'layout.anchors.calendar');
  tile(a.boards, 'layout.anchors.boards');
  optional(a.clock, (t) => tile(t, 'layout.anchors.clock'));
  optional(a.askBoard, (t) => tile(t, 'layout.anchors.askBoard'));
  if (!Array.isArray(v.errandSpots)) fail('layout.errandSpots must be a list');
  v.errandSpots.forEach((e, i) => {
    if (!isObj(e)) fail(`layout.errandSpots[${i}] must be an object`);
    str(e.kind, `layout.errandSpots[${i}].kind`);
    tile(e.stand, `layout.errandSpots[${i}].stand`);
    tile(e.fx, `layout.errandSpots[${i}].fx`);
    num(e.duration, `layout.errandSpots[${i}].duration`);
  });
  const m = v.monitor;
  if (!isObj(m)) fail('layout.monitor must be an object');
  num(m.offTopLeftGid, 'layout.monitor.offTopLeftGid');
  if (!Array.isArray(m.onGids) || !m.onGids.every((g) => Array.isArray(g) && g.length === 3 && g.every((n) => typeof n === 'number'))) {
    fail('layout.monitor.onGids must be a list of [gid, dx, dy]');
  }
  optional(v.cafeSeatLift, (n) => num(n, 'layout.cafeSeatLift'));
}

function checkCast(v: unknown): void {
  if (!isObj(v)) fail('cast must be an object');
  if (v.format !== 'pmd-animdata') fail(`cast.format must be 'pmd-animdata'`);
  if (!Array.isArray(v.members) || v.members.length === 0) fail('cast.members must list at least one member');
  const names = new Set<string>();
  v.members.forEach((m, i) => {
    if (!isObj(m)) fail(`cast.members[${i}] must be an object`);
    const name = str(m.name, `cast.members[${i}].name`);
    if (!isValidPackId(name)) fail(`cast.members[${i}].name must be lowercase letters, digits or dashes`);
    if (names.has(name)) fail(`cast.members has '${name}' twice`);
    names.add(name);
    str(m.displayName, `cast.members[${i}].displayName`);
    color(m.shirt, `cast.members[${i}].shirt`);
    if (typeof m.blurb !== 'string') fail(`cast.members[${i}].blurb must be a string`);
  });
  if (!names.has(str(v.boss, 'cast.boss'))) fail(`cast.boss '${v.boss}' is not a cast member`);
  if (!names.has(str(v.default, 'cast.default'))) fail(`cast.default '${v.default}' is not a cast member`);
  optional(v.portrait, (p) => { if (!isObj(p)) fail('cast.portrait must be {w, h}'); num(p.w, 'cast.portrait.w'); num(p.h, 'cast.portrait.h'); });
  optional(v.sprites, (s) => {
    if (!isObj(s)) fail('cast.sprites must be an object');
    optional(s.canvas, (n) => num(n, 'cast.sprites.canvas'));
    optional(s.feetRow, (n) => num(n, 'cast.sprites.feetRow'));
    optional(s.anims, (a) => { if (!isObj(a)) fail('cast.sprites.anims must be an object'); Object.entries(a).forEach(([k, n]) => path(`${n}-Anim.png`, `cast.sprites.anims.${k}`)); });
    optional(s.counts, (c) => { if (!isObj(c)) fail('cast.sprites.counts must be an object'); Object.entries(c).forEach(([k, n]) => num(n, `cast.sprites.counts.${k}`)); });
  });
  optional(v.spriteStyle, (s) => { if (!isObj(s)) fail('cast.spriteStyle must be an object'); });
}

function checkLines(v: unknown): void {
  if (!isObj(v)) fail('lines must be an object');
  optional(v.scene, (s) => { if (!isObj(s)) fail('lines.scene must be an object'); Object.entries(s).forEach(([k, l]) => str(l, `lines.scene.${k}`)); });
  optional(v.solo, (s) => {
    if (!isObj(s)) fail('lines.solo must be an object');
    optional(s.spots, (p) => { if (!isObj(p)) fail('lines.solo.spots must be an object'); Object.entries(p).forEach(([k, l]) => strings(l, `lines.solo.spots.${k}`)); });
    optional(s.byCharacter, (p) => { if (!isObj(p)) fail('lines.solo.byCharacter must be an object'); Object.entries(p).forEach(([k, l]) => strings(l, `lines.solo.byCharacter.${k}`)); });
    optional(s.heart, (l) => strings(l, 'lines.solo.heart'));
  });
  const exchanges = (l: unknown, at: string) => { if (!Array.isArray(l)) fail(`${at} must be a list`); l.forEach((e, i) => strings(e, `${at}[${i}]`)); };
  optional(v.exchanges, (l) => exchanges(l, 'lines.exchanges'));
  optional(v.keyedExchanges, (p) => { if (!isObj(p)) fail('lines.keyedExchanges must be an object'); Object.entries(p).forEach(([k, l]) => exchanges(l, `lines.keyedExchanges.${k}`)); });
}

/** Checks a parsed manifest.json against the pack folder it came from. Never throws. */
export function validateThemePackManifest(raw: unknown, dirName: string): ManifestResult {
  try {
    if (!isObj(raw)) fail('manifest must be a JSON object');
    if (raw.format !== THEME_PACK_FORMAT) fail(`format must be ${THEME_PACK_FORMAT}, got ${JSON.stringify(raw.format)}`);
    const id = str(raw.id, 'id');
    if (!isValidPackId(id)) fail(`id '${id}' must be lowercase letters, digits or dashes`);
    if (id !== dirName) fail(`id '${id}' does not match its folder name '${dirName}'`);
    if (isBuiltInThemeId(id)) fail(`id '${id}' is a built-in theme`);
    str(raw.displayName, 'displayName');
    optional(raw.blurb, (b) => (typeof b === 'string' ? b : fail('blurb must be a string')));
    optional(raw.swatch, (s) => color(s, 'swatch'));
    path(raw.map, 'map');
    if (!Array.isArray(raw.tilesets) || raw.tilesets.length === 0) fail('tilesets must list at least one tileset');
    raw.tilesets.forEach((t, i) => { if (!isObj(t)) fail(`tilesets[${i}] must be an object`); path(t.image, `tilesets[${i}].image`); });
    checkLayout(raw.layout);
    optional(raw.palette, (p) => {
      if (!isObj(p)) fail('palette must be an object');
      optional(p.background, (c) => color(c, 'palette.background'));
      optional(p.noteColors, (n) => { if (!isObj(n)) fail('palette.noteColors must be an object'); Object.entries(n).forEach(([k, c]) => color(c, `palette.noteColors.${k}`)); });
    });
    optional(raw.propStyle, (s) => (s === 'office' || s === 'camp' ? s : fail(`propStyle must be 'office' or 'camp'`)));
    optional(raw.props, (p) => { if (!isObj(p)) fail('props must be an object'); for (const k of ['board', 'counter', 'stump', 'berry']) path(p[k], `props.${k}`); });
    optional(raw.bubble, (b) => {
      if (!isObj(b)) fail('bubble must be an object');
      path(b.frame, 'bubble.frame'); path(b.font, 'bubble.font');
      for (const k of ['border', 'fontSize', 'padX', 'padY', 'offsetY']) optional(b[k], (n) => num(n, `bubble.${k}`));
      for (const k of ['textColor', 'puffFill', 'puffOutline']) optional(b[k], (c) => color(c, `bubble.${k}`));
    });
    checkCast(raw.cast);
    optional(raw.lines, checkLines);
    optional(raw.branding, (b) => {
      if (!isObj(b)) fail('branding must be an object');
      optional(b.title, (t) => str(t, 'branding.title'));
      optional(b.logo, (l) => path(l, 'branding.logo'));
    });
    return { ok: true, manifest: raw as unknown as ThemePackManifest };
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, error: e.message };
    return { ok: false, error: `manifest check failed: ${(e as Error).message}` };
  }
}

/** Every file a valid manifest names, pack-relative. */
export function packFiles(m: ThemePackManifest): string[] {
  const anims = { ...DEFAULT_PMD_ANIMS, ...m.cast.sprites?.anims };
  return [
    m.map,
    ...m.tilesets.map((t) => t.image),
    ...(m.props ? [m.props.board, m.props.counter, m.props.stump, m.props.berry] : []),
    ...(m.bubble ? [m.bubble.frame, m.bubble.font] : []),
    ...(m.branding?.logo ? [m.branding.logo] : []),
    ...m.cast.members.flatMap((c) => [
      memberFile(c.name, 'AnimData.xml'),
      memberFile(c.name, 'portrait.png'),
      ...Object.values(anims).map((a) => memberFile(c.name, `${a}-Anim.png`)),
    ]),
  ];
}

export function memberFile(name: string, file: string): string {
  return `sprites/${name}/${file}`;
}

/** The pack that brands the app: the first, in id order, with any branding. */
export function brandingPack<T extends { id: string; manifest: ThemePackManifest }>(packs: readonly T[]): T | undefined {
  return [...packs].sort((a, b) => a.id.localeCompare(b.id)).find((p) => p.manifest.branding?.title || p.manifest.branding?.logo);
}

export function appTitleFor(packs: ReadonlyArray<{ id: string; manifest: ThemePackManifest }>): string {
  return brandingPack(packs)?.manifest.branding?.title ?? DEFAULT_APP_TITLE;
}
