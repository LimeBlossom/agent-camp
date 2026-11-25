/** Renderer console lines that main appends to <userData>/renderer.log. A packaged
 *  build has no visible console, so anything not matching a prefix here is lost. */
export const THEME_LOG_PREFIX = '[theme]';
export const FLOOR_LOG_PREFIX = '[floor]';
export const RENDERER_ERROR_PREFIX = '[renderer-error]';

const KEPT_PREFIXES = [THEME_LOG_PREFIX, FLOOR_LOG_PREFIX, RENDERER_ERROR_PREFIX];

export function keepRendererConsoleLine(message: string): boolean {
  return KEPT_PREFIXES.some((p) => message.startsWith(p));
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  try { return typeof err === 'string' ? err : JSON.stringify(err); } catch { return String(err); }
}
