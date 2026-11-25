// Registers installed theme packs (shared/themePack.ts) as office themes.
// Pack files arrive as bytes over IPC and become blob: URLs: same-origin, so
// canvas reads of sprite pixels and WebGL uploads are never tainted.

import {
  brandingPack,
  parseHexColor,
  type InstalledThemePack,
  type PackLines,
} from '@shared/themePack';
import { DEFAULT_BRANDING, branding, setBranding, type Branding } from '@/branding';
import { createAnimDataCast, type PackAssetSource } from './animDataCast';
import type { BreakSpot, ThemeLines } from './cafeteriaLines';
import {
  OFFICE_THEME,
  registerTheme,
  unregisterTheme,
  type ThemeConfig,
  type ThemeId,
  type TilesetEntry,
} from './themeRegistry';

/** The preload calls this module needs (window.cth implements them). */
export interface ThemePackApi {
  themePacks(): Promise<InstalledThemePack[]>;
  themePackAsset(id: string, rel: string): Promise<Uint8Array | null>;
}

export interface ThemeChoice { id: ThemeId; label: string; blurb: string; built: boolean; swatch: string }

// TV-show office themes. Only `office` and `brooklyn99` have a real map + cast;
// the rest render via the loader's office fallback until their content lands.
// `built: false` shows a "soon" tag and a fallback note on switch.
const BUILT_IN_CHOICES: ThemeChoice[] = [
  { id: 'office',        label: 'The Office',         blurb: 'Dunder Mifflin \u2014 the original floor', built: true,  swatch: '#6b5a4a' },
  { id: 'friends',       label: 'Friends',            blurb: 'Central Perk coffee house',                built: false, swatch: '#9a5a32' },
  { id: 'brooklyn99',    label: 'Brooklyn Nine-Nine', blurb: 'The 99th precinct bullpen',                built: true,  swatch: '#3a5a7a' },
  { id: 'siliconvalley', label: 'Silicon Valley',     blurb: 'The Hacker Hostel',                        built: false, swatch: '#4a6a4a' },
  { id: 'got',           label: 'Game of Thrones',    blurb: 'The Red Keep throne room',                 built: false, swatch: '#6a2630' },
  { id: 'hogwarts',      label: 'Harry Potter',       blurb: 'Hogwarts great hall',                      built: false, swatch: '#39305a' },
];
const PACK_SWATCH = '#7a7a7a';

const loaded = new Map<string, ThemeChoice>();

/** The theme picker's entries: the built-in themes, then installed packs. */
export function themeChoices(): ThemeChoice[] {
  return [...BUILT_IN_CHOICES, ...loaded.values()];
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

function assetSource(api: ThemePackApi, id: string): PackAssetSource {
  const urls = new Map<string, Promise<string>>();
  const bytes = async (rel: string): Promise<Uint8Array> => {
    const b = await api.themePackAsset(id, rel);
    if (!b) throw new Error(`theme pack '${id}': cannot read ${rel}`);
    return b;
  };
  return {
    url(rel) {
      let p = urls.get(rel);
      if (!p) {
        const type = MIME[rel.split('.').pop()!.toLowerCase()] ?? '';
        p = bytes(rel).then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type })));
        p.catch(() => urls.delete(rel));
        urls.set(rel, p);
      }
      return p;
    },
    async text(rel) {
      return new TextDecoder().decode(await bytes(rel));
    },
  };
}

function themeLines(lines: PackLines): ThemeLines {
  return {
    scene: { ...lines.scene },
    solo: {
      spots: (lines.solo?.spots ?? {}) as Partial<Record<BreakSpot, readonly string[]>>,
      byCharacter: lines.solo?.byCharacter ?? {},
      heart: lines.solo?.heart ?? [],
    },
    exchanges: lines.exchanges ?? [],
    keyedExchanges: lines.keyedExchanges ?? {},
  };
}

/** A ThemeConfig for a pack. Rejects when an atlas, prop, bubble frame or font
 *  cannot be read; cast sheets load later, member by member. */
export async function themeFromPack(pack: InstalledThemePack, assets: PackAssetSource): Promise<ThemeConfig> {
  const m = pack.manifest;
  const L = m.layout;
  const [tileUrls, props, bubble] = await Promise.all([
    Promise.all(m.tilesets.map((t) => assets.url(t.image))),
    m.props
      ? Promise.all([m.props.board, m.props.counter, m.props.stump, m.props.berry].map((p) => assets.url(p)))
      : null,
    m.bubble ? Promise.all([assets.url(m.bubble.frame), assets.url(m.bubble.font)]) : null,
  ]);
  // A tileset with only `image` keeps the map's own entry (embedded); one with
  // metadata replaces it, named after `name` or the image file.
  const tilesets: TilesetEntry[] = m.tilesets.map(({ image, name, ...meta }, i) => (
    Object.keys(meta).length === 0
      ? { url: tileUrls[i], embedded: true }
      : { url: tileUrls[i], ...meta, image: name ?? image.replace(/^.*\//, '').replace(/\.[^.]*$/, '') }));
  const noteColors = Object.fromEntries(Object.entries(m.palette?.noteColors ?? {}).map(([k, c]) => [k, parseHexColor(c)]));
  const b = m.bubble;
  return {
    id: m.id,
    mapRaw: pack.mapRaw,
    tilesets,
    primarySeatNames: L.primarySeatNames,
    cafeSeatNames: L.cafeSeatNames,
    cafeStands: L.cafeStands,
    coffee: L.coffee,
    anchors: L.anchors,
    errandSpots: L.errandSpots,
    monitor: L.monitor,
    palette: {
      background: m.palette?.background ? parseHexColor(m.palette.background) : OFFICE_THEME.palette.background,
      noteColors: { ...OFFICE_THEME.palette.noteColors, ...noteColors },
    },
    cast: createAnimDataCast(m.cast, assets),
    ...(L.cafeSeatLift !== undefined ? { cafeSeatLift: L.cafeSeatLift } : {}),
    ...(m.propStyle ? { propStyle: m.propStyle } : {}),
    ...(props ? { propSprites: { board: props[0], counter: props[1], stump: props[2], berry: props[3] } } : {}),
    ...(bubble && b ? {
      bubble: {
        frame: bubble[0],
        font: bubble[1],
        style: {
          border: b.border, fontSize: b.fontSize, textColor: b.textColor, padX: b.padX, padY: b.padY, offsetY: b.offsetY,
          puffFill: b.puffFill ? parseHexColor(b.puffFill) : undefined,
          puffOutline: b.puffOutline ? parseHexColor(b.puffOutline) : undefined,
        },
      },
    } : {}),
    ...(m.lines ? { lines: themeLines(m.lines) } : {}),
  };
}

/** Registers every installed pack as a theme and applies the app branding. Packs
 *  from an earlier call are dropped first. Never throws: a pack that cannot load
 *  is skipped with a warning, and no packs means the built-in themes and the
 *  default branding. */
export async function loadInstalledThemePacks(
  api: ThemePackApi | undefined,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Promise<{ registered: string[]; branding: Branding }> {
  for (const id of loaded.keys()) unregisterTheme(id);
  loaded.clear();
  setBranding(null);
  let packs: InstalledThemePack[] = [];
  try {
    packs = (await api?.themePacks()) ?? [];
  } catch (e) {
    warn(`[themePacks] could not list theme packs: ${(e as Error).message}`);
  }
  const registered: InstalledThemePack[] = [];
  const sources = new Map<string, PackAssetSource>();
  for (const pack of packs) {
    try {
      const assets = assetSource(api!, pack.id);
      registerTheme(await themeFromPack(pack, assets));
      const m = pack.manifest;
      loaded.set(pack.id, { id: pack.id, label: m.displayName, blurb: m.blurb ?? '', built: true, swatch: m.swatch ?? PACK_SWATCH });
      sources.set(pack.id, assets);
      registered.push(pack);
    } catch (e) {
      warn(`[themePacks] skipping theme pack '${pack.id}': ${(e as Error).message}`);
    }
  }
  const brand = brandingPack(registered);
  if (brand) {
    const b = brand.manifest.branding!;
    let logo = DEFAULT_BRANDING.logo;
    if (b.logo) {
      try {
        logo = await sources.get(brand.id)!.url(b.logo);
      } catch (e) {
        warn(`[themePacks] '${brand.id}' logo unavailable, using the default: ${(e as Error).message}`);
      }
    }
    setBranding({ title: b.title ?? DEFAULT_BRANDING.title, logo });
  }
  return { registered: registered.map((p) => p.id), branding: branding() };
}
