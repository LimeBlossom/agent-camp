/** The floor is covered (fullscreen terminal, IDE) or the window is hidden: stop the
 *  Pixi ticker. */
export function isFloorPaused(s: { fullscreenAgentId: string | null | undefined; ideOpen: boolean; docHidden: boolean }): boolean {
  return !!s.fullscreenAgentId || s.ideOpen || s.docHidden;
}

interface PausableTicker { start(): void; stop(): void }

/** Owns the paused flag across scene rebuilds. The scene's ticker exists only after
 *  the async app.init(), so pause changes may arrive before, during or after it;
 *  whichever ticker is attached always ends up matching the latest flag. */
export function createTickerPauseGate() {
  let paused = false;
  let ticker: PausableTicker | null = null;
  const apply = () => { if (!ticker) return; if (paused) ticker.stop(); else ticker.start(); };
  return {
    setPaused(p: boolean): void { paused = p; apply(); },
    attach(t: PausableTicker): void { ticker = t; apply(); },
    detach(t: PausableTicker): void { if (ticker === t) ticker = null; },
  };
}
