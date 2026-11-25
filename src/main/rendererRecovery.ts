export interface RenderProcessGoneDetailsLike {
  reason?: string;
  exitCode?: number;
}

export interface RendererRecoveryWebContents {
  isDestroyed(): boolean;
  on(
    event: 'render-process-gone',
    listener: (event: unknown, details: RenderProcessGoneDetailsLike) => void
  ): unknown;
}

export interface RendererRecoveryWindow {
  isDestroyed(): boolean;
  webContents: RendererRecoveryWebContents;
  on(event: 'unresponsive', listener: () => void): unknown;
}

export interface RendererRecoveryOptions {
  reload: () => void;
  log: (event: Record<string, unknown>) => void;
  isQuitting?: () => boolean;
  maxReloads?: number;
  windowMs?: number;
  now?: () => number;
  windowRole?: string;
}

export const DEFAULT_MAX_RELOADS = 3;
export const DEFAULT_WINDOW_MS = 5 * 60_000;

/**
 * Attach crash and hang recovery listeners to a BrowserWindow.
 * Logs every render-process-gone and unresponsive event and reloads the window
 * unless it exited cleanly, is already destroyed/quitting, or hit the rolling
 * crash-loop cap.
 */
export function attachRendererRecovery(
  win: RendererRecoveryWindow,
  opts: RendererRecoveryOptions
): void {
  const maxReloads = opts.maxReloads ?? DEFAULT_MAX_RELOADS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const windowRole = opts.windowRole;
  const reloadTimestamps: number[] = [];

  const prune = (ts: number): void => {
    const cutoff = ts - windowMs;
    while (reloadTimestamps.length > 0 && reloadTimestamps[0] < cutoff) {
      reloadTimestamps.shift();
    }
  };

  const handleFailure = (
    kind: 'render-process-gone' | 'renderer-unresponsive',
    reason: string,
    exitCode: number | null,
    eligible: boolean
  ): void => {
    const ts = now();
    prune(ts);
    const alive = !win.isDestroyed() && !win.webContents.isDestroyed() && !opts.isQuitting?.();
    const canTry = eligible && alive;
    const capped = canTry && reloadTimestamps.length >= maxReloads;
    const reloaded = canTry && !capped;

    if (reloaded) {
      reloadTimestamps.push(ts);
    }

    try {
      opts.log({
        kind,
        reason,
        exitCode,
        reloaded,
        ...(capped ? { capped: true } : {}),
        ...(windowRole ? { window: windowRole } : {})
      });
    } catch { /* best-effort logging */ }

    if (reloaded) {
      try {
        opts.reload();
      } catch { /* reload is best-effort */ }
    }
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason ?? 'unknown';
    const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : null;
    handleFailure('render-process-gone', reason, exitCode, reason !== 'clean-exit');
  });

  win.on('unresponsive', () => {
    handleFailure('renderer-unresponsive', 'unresponsive', null, true);
  });
}
