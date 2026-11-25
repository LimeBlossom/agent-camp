/** Which snip window this renderer is, from the `?view=` main loads it with (src/main/snip.ts). */
export type SnipView = 'snip' | 'snipNote';

export const snipView: SnipView | null = (() => {
  const v = new URLSearchParams(window.location.search).get('view');
  return v === 'snip' || v === 'snipNote' ? v : null;
})();
