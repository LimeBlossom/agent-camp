/**
 * Decouple desktop UI iteration from AppImage packaging.
 * Resolves loose renderer directory assets (e.g. electron-vite out/renderer)
 * or falls back to bundled app.asar renderer assets.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from './config';

export interface RendererLoadOptions {
  view?: string;
  rendererUrl?: string;
  customPath?: string;
}

export type RendererTarget =
  | { type: 'url'; url: string }
  | { type: 'file'; path: string; options?: { query?: Record<string, string> } };

/**
 * Resolve the index.html path to load for Camp's desktop renderer.
 *
 * Precedence:
 * 1. customPath argument (if passed)
 * 2. config.json `campRendererDir` or `campRendererPath`
 * 3. Environment variables `CAMP_RENDERER_DIR` or `CAMP_RENDERER_PATH`
 * 4. Bundled fallback: `join(__dirname, '../renderer/index.html')`
 *
 * When a directory is specified, `join(dir, 'index.html')` is used.
 * If the path is non-existent or invalid, falls back to the bundled renderer.
 */
export function resolveRendererHtml(customPath?: string): string {
  const cfg = readConfig();
  const candidates = [
    customPath,
    cfg.campRendererDir,
    cfg.campRendererPath,
    process.env.CAMP_RENDERER_DIR,
    process.env.CAMP_RENDERER_PATH
  ];
  for (const c of candidates) {
    const found = c ? htmlAt(c) : null;
    if (found) return found;
  }
  return bundledHtml();
}

function bundledHtml(): string {
  return join(__dirname, '../renderer/index.html');
}

/** A directory resolves to its index.html; a file is used as-is. Null when unusable. */
function htmlAt(p: string): string | null {
  try {
    const st = statSync(p);
    if (st.isDirectory()) {
      const html = join(p, 'index.html');
      return existsSync(html) ? html : null;
    }
    return st.isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Determine whether to load a dev server URL or a local file for BrowserWindow.
 */
export function getRendererLoadTarget(opts: RendererLoadOptions = {}): RendererTarget {
  if (opts.rendererUrl) {
    const url = new URL(opts.rendererUrl);
    if (opts.view) url.searchParams.set('view', opts.view);
    return { type: 'url', url: url.toString() };
  }
  const path = resolveRendererHtml(opts.customPath);
  return opts.view ? { type: 'file', path, options: { query: { view: opts.view } } } : { type: 'file', path };
}

/**
 * Load the resolved renderer view onto a BrowserWindow or mock window.
 */
export function loadRendererView(win: any, opts: RendererLoadOptions = {}): void {
  const target = getRendererLoadTarget(opts);
  if (target.type === 'url') void win.loadURL(target.url);
  else void win.loadFile(target.path, target.options);
}
