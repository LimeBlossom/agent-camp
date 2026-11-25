/**
 * Reports slow key/input handling to the hive log. Event Timing stamps startTime with
 * the OS event time, so `processingStart - startTime` is how long a key waited before
 * the renderer saw it: main-process stalls (the browser UI thread forwards input) count
 * too. Long tasks say whether this thread was the one busy.
 */
export const INPUT_LAG_REPORT_MS = 100;

export interface InputLagEntry { name: string; startTime: number; processingStart: number; processingEnd: number; duration: number }

export function inputLagReport(e: InputLagEntry): { what: string; waitMs: number; handleMs: number } | null {
  const waitMs = Math.round(e.processingStart - e.startTime);
  const handleMs = Math.round(e.processingEnd - e.processingStart);
  if (waitMs < INPUT_LAG_REPORT_MS && handleMs < INPUT_LAG_REPORT_MS) return null;
  return { what: e.name, waitMs, handleMs };
}

export function startInputLagProbe(send: (r: Record<string, unknown>) => void): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as InputLagEntry[]) {
        const r = inputLagReport(e);
        if (r) send({ kind: 'input-lag', ...r });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= INPUT_LAG_REPORT_MS) send({ kind: 'renderer-longtask', ms: Math.round(e.duration) });
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* observer types unsupported: no probe */ }
}
