/**
 * Surviving 2D canvas context loss and asset loading failures for UI portraits.
 *
 * In Chromium, GPU-backed 2D canvases (<canvas>) receive 'contextlost' when
 * the GPU process restarts, after system sleep/suspend, or under heavy GPU
 * memory pressure (e.g. multiple WebGL contexts and Unity runs).
 *
 * W3C / WHATWG HTML Canvas 2D specification:
 * 1. Calling e.preventDefault() on the 'contextlost' event is REQUIRED to signal
 *    to the browser that the application intends to recover and receive the
 *    'contextrestored' event. Without preventDefault(), the context is permanently
 *    dead and never restored.
 * 2. When 'contextrestored' fires, the canvas bitmap has been reset to transparent
 *    black. The application must redraw its contents onto the restored canvas.
 *
 * In addition, transient asset loading failures or races during startup or
 * avatar changes should be retried with exponential/linear backoff rather than
 * swallowing the error and leaving the canvas permanently blank.
 */

export interface PortraitRecoveryOptions {
  /** Paint the portrait onto the canvas context. May be async. */
  paint: () => Promise<void> | void;
  /** Max retries if paint() rejects (default 3). */
  maxRetries?: number;
  /** Initial retry delay in ms (default 200). */
  retryDelayMs?: number;
  /** Injectable timer for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer cancellation for tests. */
  clearSchedule?: (handle: any) => void;
  log?: (msg: string) => void;
}

export const DEFAULT_PORTRAIT_MAX_RETRIES = 3;
export const DEFAULT_PORTRAIT_RETRY_DELAY_MS = 200;

export function installPortraitRecovery(
  canvas: EventTarget,
  opts: PortraitRecoveryOptions
): () => void {
  const maxRetries = opts.maxRetries ?? DEFAULT_PORTRAIT_MAX_RETRIES;
  const retryDelay = opts.retryDelayMs ?? DEFAULT_PORTRAIT_RETRY_DELAY_MS;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clearSchedule = opts.clearSchedule ?? ((handle) => clearTimeout(handle));
  const log = opts.log ?? ((m: string) => console.warn(m));

  let live = true;
  let retryTimer: unknown = null;
  let attempts = 0;
  let contextIsLost = false;

  const tryPaint = async () => {
    if (!live || contextIsLost) return;
    try {
      await opts.paint();
      attempts = 0; // reset retry counter on successful paint
    } catch (err) {
      if (!live || contextIsLost) return;
      if (attempts < maxRetries) {
        attempts++;
        const delay = retryDelay * attempts;
        log(`[portraitRecovery] portrait paint failed (attempt ${attempts}/${maxRetries}); retrying in ${delay}ms: ${String(err)}`);
        retryTimer = schedule(() => {
          retryTimer = null;
          void tryPaint();
        }, delay);
      } else {
        log(`[portraitRecovery] portrait paint failed after ${maxRetries} attempts: ${String(err)}`);
      }
    }
  };

  const onLost = (e: Event) => {
    // Calling preventDefault() is essential: without it Chromium will never
    // restore the context and the canvas remains dead for the rest of the session.
    e.preventDefault();
    contextIsLost = true;
    if (retryTimer != null) {
      clearSchedule(retryTimer);
      retryTimer = null;
    }
    log('[portraitRecovery] 2D canvas context lost — waiting for contextrestored');
  };

  const onRestored = () => {
    contextIsLost = false;
    if (!live) return;
    log('[portraitRecovery] 2D canvas context restored — redrawing portrait');
    attempts = 0;
    void tryPaint();
  };

  canvas.addEventListener('contextlost', onLost as EventListener, false);
  canvas.addEventListener('contextrestored', onRestored as EventListener, false);

  // Trigger initial paint
  void tryPaint();

  return () => {
    live = false;
    if (retryTimer != null) {
      clearSchedule(retryTimer);
      retryTimer = null;
    }
    canvas.removeEventListener('contextlost', onLost as EventListener, false);
    canvas.removeEventListener('contextrestored', onRestored as EventListener, false);
  };
}
