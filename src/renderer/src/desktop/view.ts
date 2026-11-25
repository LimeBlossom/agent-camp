/** Which desktop-mode window this renderer is, from the `?view=` main loads it with. */
export type DesktopView = 'strip' | 'askme' | 'talk';

export const desktopView: DesktopView | null = (() => {
  const v = new URLSearchParams(window.location.search).get('view');
  return v === 'strip' || v === 'askme' || v === 'talk' ? v : null;
})();

/** What the strip draws: the cast pacing along the bottom edge (`walk`, no
 *  map at all), or the floor with all of it, its furniture layers (trees,
 *  stumps, boards) and the cast, or the cast alone in place. */
export type DesktopStyle = 'walk' | 'map' | 'trees' | 'critters';
export const DESKTOP_STYLES: DesktopStyle[] = ['walk', 'trees', 'critters', 'map'];

let style: DesktopStyle = 'walk';
const listeners = new Set<(s: DesktopStyle) => void>();

export function getDesktopStyle(): DesktopStyle { return style; }
export function setDesktopStyle(next: DesktopStyle): void {
  style = next;
  for (const l of listeners) l(next);
}
export function onDesktopStyle(cb: (s: DesktopStyle) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
