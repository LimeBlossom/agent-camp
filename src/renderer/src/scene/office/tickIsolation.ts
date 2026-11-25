import { FLOOR_LOG_PREFIX, errorText } from '../../../../shared/rendererLog';

/** Run `fn` on every item; a throw from one item is reported and the rest still run.
 *  A single uncaught throw in the frame loop otherwise freezes every later avatar. */
export function updateEachIsolated<T>(
  items: Iterable<T>,
  fn: (item: T) => void,
  report: (item: T, err: unknown) => void,
): void {
  for (const item of items) {
    try { fn(item); } catch (err) { report(item, err); }
  }
}

export type FloorErrorReporter = (source: string, err: unknown) => void;

/** A per-frame throw would log 60 lines a second; report each source at most once
 *  per `intervalMs`, with a count of what was suppressed in between. */
export function createRateLimitedReporter(
  log: (line: string) => void,
  opts: { intervalMs?: number; now?: () => number; prefix?: string } = {},
): FloorErrorReporter {
  const intervalMs = opts.intervalMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const prefix = opts.prefix ?? FLOOR_LOG_PREFIX;
  const last = new Map<string, { at: number; suppressed: number }>();
  return (source, err) => {
    const t = now();
    const prev = last.get(source);
    if (prev && t - prev.at < intervalMs) { prev.suppressed++; return; }
    const more = prev && prev.suppressed > 0 ? ` (${prev.suppressed} more since last report)` : '';
    last.set(source, { at: t, suppressed: 0 });
    log(`${prefix} ${source} threw: ${errorText(err)}${more}`);
  };
}
