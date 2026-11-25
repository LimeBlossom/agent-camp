/**
 * Main-thread stall probe. The Electron main thread is also the browser UI thread
 * that forwards keystrokes to the renderer, so any long synchronous run here makes
 * typing buffer and then land at once while the Pixi floor (renderer) keeps moving.
 *
 * Wraps IPC handlers and timer callbacks to time each one, and runs a heartbeat that
 * catches stalls from anything unwrapped (pty data, fs watchers, promise
 * continuations). Slow runs are reported with the label of what ran.
 */
import type { IpcMain } from 'electron';

export interface StallReport {
  kind: 'main-stall';
  /** What ran: `ipc:<channel>`, `timer:<label>`, or `heartbeat` for an unattributed gap. */
  what: string;
  ms: number;
  /** For a heartbeat gap: the slow wrapped runs that fell inside it. */
  during?: string[];
}

export const STALL_REPORT_MS = 100;
const HEARTBEAT_MS = 50;
const RECENT_KEEP = 20;

/** Label a timer callback by its name, or the first frame outside this file. */
export function callbackLabel(fn: (...a: unknown[]) => unknown, stack: string | undefined): string {
  if (fn.name && fn.name !== 'anonymous') return fn.name;
  const frames = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
  const site = frames.find((l) => !l.includes('stallProbe') && !l.includes('node:internal'));
  return site ? site.replace(/^at\s+/, '').slice(0, 160) : 'anonymous';
}

export class StallProbe {
  private recent: { at: number; what: string; ms: number }[] = [];

  constructor(
    private readonly report: (r: StallReport) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  /** Time one synchronous run; returns what fn returned. */
  timed<T>(what: string, fn: () => T): T {
    const t0 = this.now();
    try { return fn(); } finally {
      const ms = this.now() - t0;
      if (ms >= STALL_REPORT_MS) {
        this.recent.push({ at: t0, what, ms: Math.round(ms) });
        if (this.recent.length > RECENT_KEEP) this.recent.shift();
        this.report({ kind: 'main-stall', what, ms: Math.round(ms) });
      }
    }
  }

  /** A heartbeat tick arrived `late` ms after it was due at `due`. */
  heartbeatGap(due: number, late: number): void {
    if (late < STALL_REPORT_MS) return;
    const during = this.recent.filter((r) => r.at >= due - HEARTBEAT_MS && r.at <= due + late).map((r) => `${r.what} ${r.ms}ms`);
    // Fully explained by wrapped runs already reported: no second line.
    const explained = this.recent.filter((r) => r.at >= due - HEARTBEAT_MS && r.at <= due + late).reduce((s, r) => s + r.ms, 0);
    if (explained >= late * 0.8) return;
    this.report({ kind: 'main-stall', what: 'heartbeat', ms: Math.round(late), ...(during.length ? { during } : {}) });
  }

  install(ipcMain: IpcMain): void {
    const probe = this;
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) =>
      handle(channel, (...a) => probe.timed(`ipc:${channel}`, () => listener(...a)));
    const on = ipcMain.on.bind(ipcMain);
    ipcMain.on = ((channel: string, listener: (...a: unknown[]) => void) =>
      on(channel, (...a: unknown[]) => probe.timed(`ipc:${channel}`, () => listener(...a)))) as IpcMain['on'];

    const wrapTimer = <K extends 'setInterval' | 'setTimeout'>(name: K): void => {
      const orig = globalThis[name] as unknown as (fn: (...a: unknown[]) => unknown, ms?: number, ...rest: unknown[]) => unknown;
      (globalThis as Record<string, unknown>)[name] = (fn: unknown, ms?: number, ...rest: unknown[]) => {
        if (typeof fn !== 'function') return orig(fn as never, ms, ...rest);
        const f = fn as (...a: unknown[]) => unknown;
        // Short timeouts are scheduler plumbing (debounces, yields): too many to stack-trace.
        const label = name === 'setInterval' || (ms ?? 0) >= 1000 ? callbackLabel(f, new Error().stack) : f.name || 'timeout';
        return orig((...a: unknown[]) => probe.timed(`timer:${label}`, () => f(...a)), ms, ...rest);
      };
    };
    wrapTimer('setInterval');
    wrapTimer('setTimeout');

    let due = this.now() + HEARTBEAT_MS;
    const beat = setInterval(() => {
      const t = this.now();
      this.heartbeatGap(due, t - due);
      due = t + HEARTBEAT_MS;
    }, HEARTBEAT_MS);
    (beat as { unref?: () => void }).unref?.();
  }
}
