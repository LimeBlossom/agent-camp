// Theme loader — resolves a ThemeConfig into a ready-to-render map.
//
// Phase 0 keeps this thin: it parses the theme's Tiled JSON and patches the
// appended tileset atlases with their inline metadata (the same patch the
// office scene did inline as resolveMap()). The async `loadTheme` signature is
// deliberate headroom for later phases, where a show bundle may be fetched and
// validated before it's handed to the scene; on any failure it falls back to
// the office theme so a bad/absent bundle never breaks the floor (report §E).

import type { TiledMap } from './TiledMapRenderer';
import {
  getTheme,
  OFFICE_THEME,
  type ThemeConfig,
  type ThemeId,
} from './themeRegistry';
import { Texture } from 'pixi.js';
import type { BubbleStyle } from './bubbleStyle';

export interface PropTextures { board: Texture; counter: Texture; stump: Texture; berry: Texture }

/** One prop image as a texture. Goes through a canvas rather than Assets.load:
 *  Vite inlines small PNGs as data: URLs, which Assets cannot pick a parser for. */
function loadPropTexture(url: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d')!.drawImage(img, 0, 0);
      const tex = Texture.from(c);
      tex.source.scaleMode = 'nearest';
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`prop sprite failed to load: ${url.slice(0, 60)}`));
    img.src = url;
  });
}

/** Loads a theme's bubble frame and font, or null when it has none or either
 *  fails (the bubbles then keep the drawn cloud). */
export async function loadBubbleStyle(theme: ThemeConfig): Promise<BubbleStyle | null> {
  const b = theme.bubble;
  console.info(`[theme] probe: bubble for '${theme.id}': ${b ? 'configured' : 'none'}`);
  if (!b) return null;
  try {
    const family = `theme-${theme.id}-bubble`;
    const face = await new FontFace(family, `url(${b.font})`).load();
    console.info(`[theme] probe: font loaded from ${b.font.slice(0, 80)}`);
    document.fonts.add(face);
    const frame = await loadPropTexture(b.frame);
    console.info(`[theme] bubble style loaded (font ${face.family}, status ${face.status})`);
    const own = Object.fromEntries(Object.entries(b.style ?? {}).filter(([, v]) => v !== undefined));
    return {
      frame, border: 16, fontSize: 16, textColor: '#303030',
      padX: 16, padY: 14, offsetY: -26, puffFill: 0xf8f8f8, puffOutline: 0x283030,
      ...own, fontFamily: `"${family}"`,
    };
  } catch (e) {
    console.warn('[theme] bubble style unavailable, using the drawn cloud:', e);
    return null;
  }
}

/** Loads a theme's prop sprites, or null when it has none or one fails to load
 *  (the props then fall back to their code-drawn shapes). */
export async function loadPropTextures(theme: ThemeConfig): Promise<PropTextures | null> {
  const s = theme.propSprites;
  if (!s) return null;
  try {
    const [board, counter, stump, berry] = await Promise.all(
      [s.board, s.counter, s.stump, s.berry].map(loadPropTexture));
    return { board, counter, stump, berry };
  } catch (e) {
    console.warn('[theme] prop sprites unavailable, using drawn props:', e);
    return null;
  }
}

/** Parse a theme's raw Tiled JSON and patch its tileset array.
 *  `embedded` atlases keep the map's own inline metadata; the rest are replaced
 *  by the theme's inline metadata (firstgid + image dimensions). The result's
 *  tileset order matches the texture-load order (texture[i] ↔ tilesets[i]). */
export function resolveThemeMap(theme: ThemeConfig): TiledMap {
  const m = JSON.parse(theme.mapRaw) as TiledMap;
  return {
    ...m,
    tilesets: theme.tilesets.map((t, i) => {
      if (t.embedded) return m.tilesets[i];
      // Strip the renderer-only fields (url/embedded); the rest is Tiled metadata.
      const { url: _url, embedded: _embedded, ...meta } = t;
      return meta as TiledMap['tilesets'][number];
    }),
  };
}

/** The ordered tileset image URLs to load as textures, matching the map's
 *  tileset order (so texture[i] lines up with tilesets[i]). */
export function themeTilesetUrls(theme: ThemeConfig): string[] {
  return theme.tilesets.map((t) => t.url);
}

/** Light validation: the theme's map must parse and carry sane dimensions. */
function isThemeRenderable(theme: ThemeConfig): boolean {
  try {
    const m = JSON.parse(theme.mapRaw) as TiledMap;
    return (
      typeof m.width === 'number' && m.width > 0 &&
      typeof m.height === 'number' && m.height > 0 &&
      Array.isArray(m.layers) && Array.isArray(m.tilesets)
    );
  } catch {
    return false;
  }
}

/** Resolve a theme id to a renderable ThemeConfig. Async by design (later
 *  phases may fetch a show bundle here); falls back to the office theme if the
 *  requested theme is missing or its map won't parse. */
export async function loadTheme(id: ThemeId): Promise<ThemeConfig> {
  const theme = getTheme(id);
  if (!isThemeRenderable(theme)) {
    console.warn(`[themeLoader] theme '${id}' is not renderable — falling back to 'office'`);
    return OFFICE_THEME;
  }
  return theme;
}
