/**
 * Reading agy's (Antigravity CLI 1.2.14) TUI as rendered text: which screen it is on, and
 * the quota pools its /quota panel shows (agy 1.4 adds a weekly-only GEMINI 4 ARGON pool). Pure, so the fixtures in test/fixtures can
 * pin it. The panel's "Account:" line is never read.
 */

import { refreshInMs } from '../shared/agyRefresh';

export type AgyScreen = 'quota' | 'menu-quota' | 'menu-exit' | 'trust' | 'ready' | 'unknown';

export interface AgyWindow {
  /** Percent of the window still available, as agy prints it. */
  remaining: number;
  /** agy's own wording: "Refreshes in 72h 46m", or "Quota available". */
  note?: string;
}

export interface AgyPool {
  /** The panel's group heading, e.g. "GEMINI MODELS", "CLAUDE AND GPT MODELS", "GEMINI 4 ARGON". */
  name: string;
  /** Short chip label: "gem", "claude" or "argon". */
  label: string;
  weekly?: AgyWindow;
  fiveHour?: AgyWindow;
}

export interface AgyQuota {
  pools: AgyPool[];
  /** When the probe read the panel, ms since epoch. */
  at: number;
}

/** The highlighted row of agy's slash-command menu is the one starting with ">". */
const MENU_QUOTA = /^\s*>\s+\/(usage|quota)\b.*quota usage/im;
const MENU_EXIT = /^\s*>\s+\/(exit|quit)\b.*Exit the CLI/im;
/** A pool heading: "GEMINI MODELS", "CLAUDE AND GPT MODELS", or a model's own pool, "GEMINI 4 ARGON". */
const POOL_HEADING = /^[A-Z][A-Z0-9 ]*(?:MODELS|ARGON)$/;

export function classifyAgyScreen(text: string): AgyScreen {
  if (/Weekly Limit Remaining/.test(text) && /^[A-Z][A-Z ]*MODELS\s*$/m.test(text)) return 'quota';
  if (MENU_QUOTA.test(text)) return 'menu-quota';
  if (MENU_EXIT.test(text)) return 'menu-exit';
  if (/Do you trust the contents/i.test(text)) return 'trust';
  if (/Antigravity CLI \d/.test(text) && /^>\s*$/m.test(text) && /\? for shortcuts/.test(text)) return 'ready';
  return 'unknown';
}

function labelFor(name: string): string {
  if (/ARGON/i.test(name)) return 'argon';
  if (/GEMINI/i.test(name)) return 'gem';
  if (/CLAUDE/i.test(name)) return 'claude';
  return name.split(/\s+/)[0].toLowerCase();
}

/** The pools on a /quota panel, or null when the panel is not (fully) on screen. */
export function parseAgyQuota(text: string, at: number): AgyQuota | null {
  const pools: AgyPool[] = [];
  let pool: AgyPool | null = null;
  let window: 'weekly' | 'fiveHour' | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (POOL_HEADING.test(line)) {
      pool = { name: line, label: labelFor(line) };
      pools.push(pool);
      window = null;
      continue;
    }
    if (!pool) continue;
    // The Argon pool names its one bar after the model: "Gemini 4 Argon Weekly Limit".
    if (/^(?:.+ )?Weekly Limit(?: Remaining)?$/i.test(line)) { window = 'weekly'; continue; }
    if (/^(?:.+ )?Five Hour Limit(?: Remaining)?$/i.test(line)) { window = 'fiveHour'; continue; }
    if (!window) continue;
    const pct = /\]\s*([0-9]+(?:\.[0-9]+)?)%\s*$/.exec(line);
    if (pct) { pool[window] = { remaining: Number(pct[1]) }; continue; }
    const w = pool[window];
    if (w && !w.note && /^(Refreshes in .+|Quota available)$/i.test(line)) w.note = line;
  }
  // A pool whose weekly limit is spent prints "Disabled: ..." in place of its 5-hour bar
  // (agy 1.2.16), so the weekly window alone makes a pool readable.
  const complete = pools.filter((p) => p.weekly);
  return complete.length >= 2 ? { pools: complete, at } : null;
}

/** The window that runs out first: the lower remaining of the two. */
export function bindingRemaining(p: AgyPool): number | undefined {
  const vals = [p.weekly?.remaining, p.fiveHour?.remaining].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.min(...vals) : undefined;
}

/** A pool's 5-hour and weekly windows as percent used, each with its own refresh time
 *  when agy printed one. The balancer reads the fuller of the two, and either one at
 *  100% makes the pool's engine exhausted until that window refreshes. */
export function agyPoolWindows(p: AgyPool, readAtMs: number): Array<{ percent: number; resetsAtMs?: number; lengthMs: number } | undefined> {
  const win = (w: AgyWindow | undefined, lengthMs: number): { percent: number; resetsAtMs?: number; lengthMs: number } | undefined => {
    if (!w) return undefined;
    const inMs = refreshInMs(w.note);
    return { percent: 100 - w.remaining, ...(inMs !== undefined ? { resetsAtMs: readAtMs + inMs } : {}), lengthMs };
  };
  // Lengths from the panel's own headings, "Five Hour Limit Remaining" and "Weekly Limit Remaining".
  return [win(p.fiveHour, 5 * 3_600_000), win(p.weekly, 7 * 86_400_000)];
}

/** How often the gauge probes agy's /quota panel. */
export const AGY_PROBE_EVERY_MS = 5 * 60_000;

/** A reading older than three probe intervals no longer holds engines: one or two misses
 *  are routine (agy's self-update screen, a slow start past the probe timeout), but three
 *  in a row means the reading has stopped tracking the account. A wrongly released engine
 *  costs one refusal, which agy-model-refusals.json then blocks by model on its own. */
export const AGY_QUOTA_STALE_MS = 3 * AGY_PROBE_EVERY_MS;

/** The reading engine choice may act on: null once it is older than AGY_QUOTA_STALE_MS. */
export function agyQuotaForEngines(q: AgyQuota | null, nowMs: number): AgyQuota | null {
  return q && nowMs - q.at <= AGY_QUOTA_STALE_MS ? q : null;
}

/** The log.jsonl event for a probe outcome, or null when nothing changed: the first
 *  failure, a failure with a new reason, and the recovery after failures are logged;
 *  repeats of the same failure and routine successes are not. */
export function agyProbeLogEvent(
  prevError: string | null,
  error: string | null,
  failures: number,
  lastOkAtMs: number | undefined
): Record<string, unknown> | null {
  const lastOk = lastOkAtMs !== undefined ? new Date(lastOkAtMs).toISOString() : null;
  if (error === null) return prevError === null ? null : { kind: 'agy-quota-probe', ok: true, after: prevError };
  if (error === prevError) return null;
  return { kind: 'agy-quota-probe', ok: false, error, failures, lastOk };
}

export { refreshInMs };
