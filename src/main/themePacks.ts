// Finds and serves theme packs from <userData>/themes/<id>/ (see shared/themePack.ts).
// A missing folder means no packs; a pack that fails any check is skipped with one
// warning and never stops the others or the app.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  DEFAULT_APP_TITLE,
  appTitleFor,
  isSafeRelativePath,
  isValidPackId,
  packFiles,
  validateThemePackManifest,
  type InstalledThemePack,
} from '../shared/themePack';

export type { InstalledThemePack } from '../shared/themePack';

export function themePacksDir(userDataDir: string): string {
  return join(userDataDir, 'themes');
}

/** Absolute path of a regular file inside the pack, or null if it is missing,
 *  not a file, or resolves (through `..` or a symlink) outside the pack. */
function resolveInPack(themesDir: string, id: string, rel: string): string | null {
  if (!isValidPackId(id) || !isSafeRelativePath(rel)) return null;
  try {
    const root = realpathSync(join(themesDir, id));
    const file = realpathSync(join(root, rel));
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

export function readThemePackAsset(themesDir: string, id: string, rel: string): Buffer | null {
  const file = resolveInPack(themesDir, id, rel);
  if (!file) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

function isTiledMap(m: unknown): boolean {
  const map = m as { width?: unknown; height?: unknown; layers?: unknown; tilesets?: unknown } | null;
  return !!map && typeof map.width === 'number' && map.width > 0 && typeof map.height === 'number' && map.height > 0
    && Array.isArray(map.layers) && Array.isArray(map.tilesets);
}

function loadPack(themesDir: string, dirName: string): InstalledThemePack {
  const manifestFile = resolveInPack(themesDir, dirName, 'manifest.json');
  if (!manifestFile) throw new Error('no manifest.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON (${(e as Error).message})`);
  }
  const checked = validateThemePackManifest(raw, dirName);
  if (!checked.ok) throw new Error(checked.error);
  const manifest = checked.manifest;
  const missing = packFiles(manifest).filter((f) => !resolveInPack(themesDir, dirName, f));
  if (missing.length) throw new Error(`missing file(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}`);
  const mapRaw = readFileSync(resolveInPack(themesDir, dirName, manifest.map)!, 'utf8');
  let map: { tilesets?: unknown[] };
  try {
    map = JSON.parse(mapRaw);
  } catch {
    throw new Error(`${manifest.map} is not valid JSON`);
  }
  if (!isTiledMap(map)) throw new Error(`${manifest.map} is not a Tiled map (needs width, height, layers, tilesets)`);
  if (map.tilesets!.length !== manifest.tilesets.length) {
    throw new Error(`${manifest.map} has ${map.tilesets!.length} tileset(s) but the manifest lists ${manifest.tilesets.length}`);
  }
  return { id: manifest.id, manifest, mapRaw };
}

export function scanThemePacks(themesDir: string, warn: (msg: string) => void = (m) => console.warn(m)): InstalledThemePack[] {
  let names: string[];
  try {
    names = readdirSync(themesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  const packs: InstalledThemePack[] = [];
  for (const name of names) {
    try {
      packs.push(loadPack(themesDir, name));
    } catch (e) {
      warn(`[themePacks] skipping theme pack '${name}': ${(e as Error).message}`);
    }
  }
  return packs;
}

export function appTitle(packs: InstalledThemePack[]): string {
  return appTitleFor(packs);
}

// The packs found at startup (index.ts sets them once the app is ready). They
// name the app in window titles, notifications and agent prompts.
let installed: InstalledThemePack[] = [];

export function setInstalledThemePacks(packs: InstalledThemePack[]): void {
  installed = packs;
}

export function installedThemePacks(): InstalledThemePack[] {
  return installed;
}

export function brandTitle(): string {
  return installed.length ? appTitleFor(installed) : DEFAULT_APP_TITLE;
}
