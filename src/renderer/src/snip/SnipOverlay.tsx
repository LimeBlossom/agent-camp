import { useEffect, useState } from 'react';
import { dragRect, type Point } from '@shared/snip';

const DIM = 'rgba(0, 0, 0, 0.35)';

/** One monitor's frozen screen: drag a rectangle to snip it, Esc or right-click to cancel. */
export function SnipOverlay() {
  const [image, setImage] = useState<string | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);

  useEffect(() => { void window.cth.snipOverlayImage().then(setImage); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') window.cth.snipCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Page px to window px, in case a zoom factor reached this partition.
  const at = (e: React.MouseEvent): Point => {
    const k = window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
    return { x: e.clientX * k, y: e.clientY * k };
  };
  const toPage = (v: number): number => (window.outerWidth > 0 ? v * window.innerWidth / window.outerWidth : v);
  const sel = start && end ? {
    left: toPage(Math.min(start.x, end.x)), top: toPage(Math.min(start.y, end.y)),
    width: toPage(Math.abs(end.x - start.x)), height: toPage(Math.abs(end.y - start.y))
  } : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, cursor: 'crosshair', userSelect: 'none', background: '#000', overflow: 'hidden' }}
      onMouseDown={(e) => { if (e.button !== 0) return; setStart(at(e)); setEnd(at(e)); }}
      onMouseMove={(e) => { if (start) setEnd(at(e)); }}
      onMouseUp={(e) => {
        if (!start || e.button !== 0) return;
        const rect = dragRect(start, at(e));
        if (rect) window.cth.snipRegion(rect);
        else { setStart(null); setEnd(null); }
      }}
      onContextMenu={(e) => { e.preventDefault(); window.cth.snipCancel(); }}
    >
      {image && (
        <img src={image} alt="" draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      )}
      {sel
        ? <div style={{ position: 'absolute', ...sel, boxShadow: `0 0 0 100000px ${DIM}`, outline: '1px solid #fff', pointerEvents: 'none' }} />
        : <div style={{ position: 'absolute', inset: 0, background: DIM, pointerEvents: 'none' }} />}
    </div>
  );
}
