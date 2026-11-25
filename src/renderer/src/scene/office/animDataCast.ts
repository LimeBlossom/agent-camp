// A theme-pack cast drawn from PMD-style sheets: one animation per PNG, with 8
// direction rows in the order down, down-right, right, up-right, up, up-left,
// left, down-left, and a frame size per animation listed in AnimData.xml. Every
// frame is re-centred on one shared canvas (PMD aligns animations by cell centre)
// and the canvas is cut at the feet, so the (0.5, 1) anchor CharacterSprite uses
// lands on the ground for every anim.

import { Texture } from 'pixi.js';
import type { CastMember } from './cast';
import type { SpriteStyle } from './CharacterSprite';
import type { ThemeCast } from './themeRegistry';
import { DEFAULT_PMD_ANIMS, memberFile, type PackCast, type PmdRole } from '@shared/themePack';

/** Reads pack files as URLs the renderer can load, or as text. */
export interface PackAssetSource {
  url(rel: string): Promise<string>;
  text(rel: string): Promise<string>;
}

// Fixed grid layout, whatever each sheet's own frame counts are: sampling to a
// fixed count is what lets one SpriteStyle serve the whole cast.
const DEFAULT_COUNTS: Record<PmdRole, number> = { walk: 4, work: 8, idle: 6, sit: 3, nap: 2 };
// Every frame sits on one fixed canvas with the standing feet on feetRow, so an
// animation that moves the sprite (Attack steps back, then lunges) has room on
// both sides of the ground line; the sprite's anchor points at feetRow.
const DEFAULT_CANVAS = 96;
const DEFAULT_FEET_ROW = 72;
const DEFAULT_PORTRAIT = { w: 18, h: 18 };

// App rows (down, up, right) -> PMD rows. Left is the mirrored right row.
const PMD_ROW = [0, 4, 2];

/** Frame size per animation name, following CopyOf references. */
export function parseAnimData(xml: string): Map<string, { w: number; h: number }> {
  const raw = new Map<string, { w: number; h: number; copyOf?: string }>();
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`))?.[1];
  for (const [, block] of xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const name = tag(block, 'Name');
    if (!name) continue;
    raw.set(name, { w: Number(tag(block, 'FrameWidth') ?? 0), h: Number(tag(block, 'FrameHeight') ?? 0), copyOf: tag(block, 'CopyOf') });
  }
  const out = new Map<string, { w: number; h: number }>();
  for (const [name, entry] of raw) {
    const target = entry.copyOf ? raw.get(entry.copyOf) : entry;
    out.set(name, { w: target?.w ?? 0, h: target?.h ?? 0 });
  }
  return out;
}

const range = (at: number, n: number): number[] => Array.from({ length: n }, (_, i) => at + i);

function layoutOf(counts: Record<PmdRole, number>) {
  const walkAt = 0;
  const workAt = walkAt + counts.walk;
  const idleAt = workAt + counts.work;
  const sitAt = idleAt + counts.idle;
  const napAt = sitAt + counts.sit;
  return { walkAt, workAt, idleAt, sitAt, napAt };
}

export function animDataSpriteStyle(cast: PackCast): SpriteStyle {
  const counts = { ...DEFAULT_COUNTS, ...cast.sprites?.counts };
  const canvas = cast.sprites?.canvas ?? DEFAULT_CANVAS;
  const feetRow = cast.sprites?.feetRow ?? DEFAULT_FEET_ROW;
  const at = layoutOf(counts);
  const s = cast.spriteStyle ?? {};
  return {
    animFrames: {
      walk: range(at.walkAt, counts.walk),
      type: range(at.workAt, counts.work),
      read: range(at.workAt, counts.work),
      idle: range(at.idleAt, counts.idle),
      sit: [at.sitAt],   // one held frame: the loop read as fidgeting
      nap: range(at.napAt, counts.nap),
    },
    animSpeed: s.animSpeed,
    seatedCrop: s.seatedCrop ?? false,
    scale: s.scale ?? 1.0,
    anchorY: (feetRow + 1) / canvas,
    idleBehaviour: s.idleBehaviour,
  };
}

interface Sheet { img: HTMLImageElement; w: number; h: number; cols: number; rows: number }

function loadImage(url: string, retries = 2): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryLoad = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => {
        if (attempts < retries) {
          attempts++;
          setTimeout(tryLoad, 100 * attempts);
        } else {
          reject(e);
        }
      };
      img.src = url;
    };
    tryLoad();
  });
}

/** `n` column indices spread over a sheet row, repeating when it has fewer. */
function sample(cols: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.floor((i * cols) / n) % cols);
}

function toTexture(src: HTMLCanvasElement): Texture {
  const tex = Texture.from(src);
  tex.source.scaleMode = 'nearest';
  return tex;
}

function hasDestroyedTextures(frames: Texture[][]): boolean {
  return frames.some((row) => row.some((tex) => tex.destroyed || tex.source?.destroyed));
}

export function createAnimDataCast(cast: PackCast, assets: PackAssetSource): ThemeCast {
  const members: CastMember[] = cast.members.map((m) => ({ ...m }));
  const byName: Record<string, CastMember> = Object.fromEntries(members.map((c) => [c.name, c]));
  const anims = { ...DEFAULT_PMD_ANIMS, ...cast.sprites?.anims };
  const counts = { ...DEFAULT_COUNTS, ...cast.sprites?.counts };
  const canvasSize = cast.sprites?.canvas ?? DEFAULT_CANVAS;
  const feetRowAt = cast.sprites?.feetRow ?? DEFAULT_FEET_ROW;
  const centre = canvasSize / 2;
  const portrait = cast.portrait ?? DEFAULT_PORTRAIT;
  const known = (name: string) => (byName[name] ? name : cast.default);
  const images = new Map<string, Promise<HTMLImageElement>>();

  const image = (rel: string): Promise<HTMLImageElement> => {
    let p = images.get(rel);
    if (!p) {
      p = assets.url(rel).then((url) => loadImage(url));
      p.catch(() => images.delete(rel));
      images.set(rel, p);
    }
    return p;
  };

  async function loadSheet(name: string, anim: string, sizes: Map<string, { w: number; h: number }>): Promise<Sheet> {
    const img = await image(memberFile(name, `${anim}-Anim.png`));
    const size = sizes.get(anim);
    if (!size || !size.w || !size.h) throw new Error(`cast ${name}: AnimData.xml has no frame size for ${anim}`);
    return { img, w: size.w, h: size.h, cols: Math.floor(img.width / size.w), rows: Math.floor(img.height / size.h) };
  }

  /** Draws one cell centred on the shared canvas, shifted down by `shift` px. */
  function centred(sheet: Sheet, col: number, row: number, shift = 0): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = canvasSize; c.height = canvasSize;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const r = Math.min(row, sheet.rows - 1); // single-row sheets face one way
    ctx.drawImage(sheet.img, col * sheet.w, r * sheet.h, sheet.w, sheet.h,
      centre - sheet.w / 2, centre - sheet.h / 2 + shift, sheet.w, sheet.h);
    return c;
  }

  /** Lowest opaque row of a canvas: where the feet are. */
  function feetRow(c: HTMLCanvasElement): number {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    for (let y = c.height - 1; y >= 0; y--) {
      for (let x = 0; x < c.width; x++) if (data[(y * c.width + x) * 4 + 3] > 0) return y;
    }
    return centre;
  }

  async function buildFrames(name: string): Promise<Texture[][]> {
    const sizes = parseAnimData(await assets.text(memberFile(name, 'AnimData.xml')));
    const [walk, work, idle, sit, nap] = await Promise.all(
      [anims.walk, anims.work, anims.idle, anims.sit, anims.nap].map((a) => loadSheet(name, a, sizes)));
    // One shift for every animation, from the standing walk frame facing down, so
    // switching animation never makes the sprite hop.
    const shift = feetRowAt - feetRow(centred(walk, 0, 0));
    const tex = (sheet: Sheet, col: number, row: number) => toTexture(centred(sheet, col, row, shift));
    return PMD_ROW.map((row) => [
      ...sample(walk.cols, counts.walk).map((col) => tex(walk, col, row)),
      ...sample(work.cols, counts.work).map((col) => tex(work, col, row)),
      // A one-row idle sheet faces the camera, so any other facing holds the
      // walk sheet's standing frame instead.
      ...(row === 0 || idle.rows > 1
        ? sample(idle.cols, counts.idle).map((col) => tex(idle, col, row))
        : Array.from({ length: counts.idle }, () => tex(walk, 0, row))),
      ...sample(sit.cols, counts.sit).map((col) => tex(sit, col, row)),
      ...sample(nap.cols, counts.nap).map((col) => tex(nap, col, row)),
    ]);
  }

  const frameCache = new Map<string, Promise<Texture[][]>>();

  function clearFrames(): void {
    for (const p of frameCache.values()) {
      p.then((rows) => {
        for (const row of rows) {
          for (const tex of row) {
            try { tex.destroy(true); } catch { /* noop */ }
          }
        }
      }).catch(() => {});
    }
    frameCache.clear();
  }

  function getFrames(name: string): Promise<Texture[][]> {
    const key = known(name);
    const cached = frameCache.get(key);
    if (cached) {
      cached.then((frames) => {
        if (hasDestroyedTextures(frames)) frameCache.delete(key);
      }).catch(() => frameCache.delete(key));
      return cached;
    }
    const p = buildFrames(key).catch((err) => {
      frameCache.delete(key);
      throw err;
    });
    frameCache.set(key, p);
    return p;
  }

  /** Paints the member's portrait into a portrait.w * scale square. Shrinking uses
   *  smooth scaling, which keeps the face even where nearest-neighbour drops rows. */
  async function paint(ctx: CanvasRenderingContext2D, name: string, scale: number): Promise<void> {
    if (ctx.isContextLost?.()) return;
    const img = await image(memberFile(known(name), 'portrait.png'));
    if (ctx.isContextLost?.()) return;
    const size = Math.round(portrait.w * scale);
    ctx.imageSmoothingEnabled = size < img.width;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, size, size);
  }

  return {
    byName,
    members,
    getFrames,
    clearFrames,
    defaultCharacter: cast.default,
    bossCharacter: cast.boss,
    spriteStyle: animDataSpriteStyle(cast),
    portrait: { w: portrait.w, h: portrait.h, paint },
  };
}
