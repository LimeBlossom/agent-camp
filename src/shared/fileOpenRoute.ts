import { extensionOf, isImagePath } from './imageTypes';

/** The in-app viewer's read ceilings (main/fs.ts): text files and images. */
export const VIEWER_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const VIEWER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Extensions handed to the system's default app. An allowlist, because the path comes
 *  from agent output and the default app for an `.AppImage`, `.desktop` or script would run it. */
const SYSTEM_OPEN_EXTS = new Set([
  'html', 'htm', 'pdf', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif',
  'mp4', 'webm', 'mov', 'mkv', 'mp3', 'wav', 'ogg', 'flac',
  'txt', 'md', 'json', 'csv', 'log', 'glb', 'gltf'
]);

/** Pictures and videos a click opens in the system's default app rather than an in-app
 *  viewer (The human's ruling 2026-10-11). SVG stays out: the IDE shows it as source and picture. */
const EXTERNAL_MEDIA_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif',
  'mp4', 'webm', 'mov', 'mkv'
]);

export function isExternalMediaPath(path: string): boolean {
  return EXTERNAL_MEDIA_EXTS.has(extensionOf(path));
}

/** The short notice for a media open that did not reach the system app, or null when it did.
 *  `result` is what the openCardFile bridge returned, or null when the call itself failed. */
export function mediaOpenNotice(result: { ok: boolean; route?: FileOpenRoute; error?: string } | null): string | null {
  if (result?.ok && result.route === 'system') return null;
  return `Could not open: ${result?.error || 'unknown error'}`;
}

export type FileOpenRoute = 'viewer' | 'system' | 'reveal';

/** Where a file clicked on an ASK ME card opens. Allowlisted types always open in the
 *  system's default app, whatever their size; anything else opens in the in-app viewer when
 *  it fits under the viewer's ceiling, else is revealed in its folder. */
export function fileOpenRoute(path: string, size: number): FileOpenRoute {
  if (SYSTEM_OPEN_EXTS.has(extensionOf(path))) return 'system';
  const max = isImagePath(path) ? VIEWER_MAX_IMAGE_BYTES : VIEWER_MAX_TEXT_BYTES;
  return size <= max ? 'viewer' : 'reveal';
}
