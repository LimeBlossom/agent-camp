import { readFileSync } from 'node:fs';
import type { HarnessConfig } from './config';

/**
 * Poll cadences and guardrail caps for the camp engine. The human-owned, read from
 * config.json under `timings`. Every key is optional; an absent or invalid value
 * (non-number, NaN, below its minimum) falls back to the shipped default.
 *
 * Drop-folder lanes (vault inbox, card proposals) carry their own `everyMs` and
 * `renudgeMs` in `config.dropFolders`, so they have no key here.
 */
export interface TimingsConfig {
  /** Ephemeral worker queue and Unity broker tick. */
  workerTickMs?: number;
  /** Minimum gap between sweeps of integrated worker worktrees. */
  gcSweepMs?: number;
  /** Provider usage-limit poll. */
  limitPollMs?: number;
  /** Live fleet snapshot write. */
  fleetSnapshotMs?: number;
  /** Circuit-breaker / cost-ledger beat. */
  breakerBeatMs?: number;
  /** Phone server liveness check. */
  phoneServerMs?: number;

  /** Abnormal crashes inside crashWindowMs before auto-revive stops. */
  crashMaxInWindow?: number;
  /** Rolling window the crash count is taken over. */
  crashWindowMs?: number;
  /** First backoff after a crash; doubles per further crash in the window. */
  crashBackoffBaseMs?: number;
  /** How long closing time waits for acks before offering force-quit. */
  closingTimeoutMs?: number;
  /** Pause after the god's COMPLETE before teardown. */
  closingTeardownGraceMs?: number;
  /** Ops standup: a window above this percent that refreshed triggers a standup. */
  standupRefreshPercent?: number;
  /** Ops standup: log.jsonl lines inspected for changes. */
  standupLogTail?: number;
  /** An agent with an open doing/todo card and no session activity this long is flagged STALLED in the standup and floor. */
  stallAfterMs?: number;
  /** restart_agent refuses a session active within this long unless force is set. */
  restartRecentActivityMs?: number;
  /** Breaker: consecutive identical tool calls before steering. */
  repeatedToolLimit?: number;
  /** Breaker: consecutive api_error / retry events before steering. */
  errorStormLimit?: number;
  /** Breaker: output tokens per minute before steering. */
  tokenVelocityPerMin?: number;
  /** Breaker: how recent a distinct tool call or user prompt must be to count as progress. */
  breakerProgressToolWindowMs?: number;
  /** Breaker: consecutive no-progress beats before steering. */
  breakerNoProgressBeats?: number;
  /** Lead time before a Codex reset credit expires to fire an alert notice. */
  codexResetCreditAlertLeadMs?: number;
  /** Lead time before a banked Claude limit reset expires to fire an alert notice. */
  claudeResetGrantAlertLeadMs?: number;
  /** Lead time for the second, last-chance reminder before a Claude limit reset expires. */
  claudeResetGrantFinalAlertLeadMs?: number;
}

type TimingKey = keyof TimingsConfig;
type ResolvedTimings = Required<TimingsConfig>;

/** Shortest period a timer may take, so a typo cannot spin it. */
const MIN_PERIOD_MS = 250;
const MIN_WINDOW_MS = 1_000;

/** Today's constants. */
export const DEFAULT_TIMINGS: Readonly<ResolvedTimings> = Object.freeze({
  workerTickMs: 1_500,
  gcSweepMs: 60_000,
  limitPollMs: 20_000,
  fleetSnapshotMs: 8_000,
  breakerBeatMs: 30_000,
  phoneServerMs: 30_000,
  crashMaxInWindow: 3,
  crashWindowMs: 30 * 60_000,
  crashBackoffBaseMs: 30_000,
  closingTimeoutMs: 6 * 60_000,
  closingTeardownGraceMs: 2_500,
  standupRefreshPercent: 90,
  standupLogTail: 3000,
  stallAfterMs: 45 * 60_000,
  restartRecentActivityMs: 10 * 60_000,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 60_000,
  breakerProgressToolWindowMs: 300_000,
  breakerNoProgressBeats: 2,
  codexResetCreditAlertLeadMs: 24 * 60 * 60 * 1000,
  claudeResetGrantAlertLeadMs: 7 * 24 * 60 * 60 * 1000,
  claudeResetGrantFinalAlertLeadMs: 24 * 60 * 60 * 1000
});

/** Smallest accepted value per key. Anything below it, or not a finite number, reads as unset. */
const MINIMUM: Readonly<Record<TimingKey, number>> = {
  workerTickMs: MIN_PERIOD_MS,
  gcSweepMs: MIN_PERIOD_MS,
  limitPollMs: MIN_PERIOD_MS,
  fleetSnapshotMs: MIN_PERIOD_MS,
  breakerBeatMs: MIN_PERIOD_MS,
  phoneServerMs: MIN_PERIOD_MS,
  crashMaxInWindow: 1,
  crashWindowMs: MIN_WINDOW_MS,
  crashBackoffBaseMs: MIN_PERIOD_MS,
  closingTimeoutMs: MIN_WINDOW_MS,
  closingTeardownGraceMs: 0,
  standupRefreshPercent: 1,
  standupLogTail: 1,
  stallAfterMs: MIN_WINDOW_MS,
  restartRecentActivityMs: MIN_WINDOW_MS,
  repeatedToolLimit: 1,
  errorStormLimit: 1,
  tokenVelocityPerMin: 1,
  breakerProgressToolWindowMs: MIN_WINDOW_MS,
  breakerNoProgressBeats: 1,
  codexResetCreditAlertLeadMs: MIN_WINDOW_MS,
  claudeResetGrantAlertLeadMs: MIN_WINDOW_MS,
  claudeResetGrantFinalAlertLeadMs: MIN_WINDOW_MS
};

const MAXIMUM: Partial<Record<TimingKey, number>> = { standupRefreshPercent: 100 };

function accept(key: TimingKey, v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v < MINIMUM[key]) return undefined;
  const max = MAXIMUM[key];
  if (max !== undefined && v > max) return undefined;
  return v;
}

/** Effective timings: config value if valid, else the legacy `circuitBreaker` value for the
 *  three keys that lived there, else the default. Pure; callers pass a fresh readConfig(). */
export function getTimings(config?: Partial<HarnessConfig> | null): ResolvedTimings {
  const custom: Record<string, unknown> = { ...(config?.timings ?? {}) };
  const legacy: Record<string, unknown> = { ...(config?.circuitBreaker ?? {}) };
  const out = { ...DEFAULT_TIMINGS };
  for (const key of Object.keys(DEFAULT_TIMINGS) as TimingKey[]) {
    out[key] = accept(key, custom[key]) ?? accept(key, legacy[key]) ?? DEFAULT_TIMINGS[key];
  }
  return out;
}

/** Timer handle name -> the timing key that sets its period. */
const TIMER_PERIOD_KEY = {
  fleetTimer: 'fleetSnapshotMs',
  breakerBeatTimer: 'breakerBeatMs',
  workerWatchTimer: 'workerTickMs',
  unityBrokerTimer: 'workerTickMs',
  limitTimer: 'limitPollMs',
  phoneServerTimer: 'phoneServerMs'
} as const satisfies Record<string, TimingKey>;

let configReader: (() => Partial<HarnessConfig> | null) | null = null;

/** Register the main-process config reader so timings.ts never imports config.ts or electron. */
export function setTimingsConfigReader(fn: (() => Partial<HarnessConfig> | null) | null): void {
  configReader = fn;
}

function readConfigFromFile(filePath: string): Partial<HarnessConfig> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<HarnessConfig>)
      : null;
  } catch {
    return null;
  }
}

/** Timings from the live config, read at the point of use so an edit applies on the next call. */
function readConfigSafe(): Partial<HarnessConfig> | null {
  if (configReader) {
    try { return configReader(); } catch { return null; }
  }
  const cfgPath = process.env.CAMP_CONFIG_PATH;
  return cfgPath ? readConfigFromFile(cfgPath) : null;
}

export function liveTimings(): ResolvedTimings {
  return getTimings(readConfigSafe());
}

type TimerHandle = ReturnType<typeof setInterval>;

/** An armed interval with the callback and period it was armed with, so a re-arm needs nothing
 *  from the runtime's timer internals. */
export interface LiveInterval { handle: TimerHandle; fn: () => void; periodMs: number }
export type ActiveTimers = { -readonly [K in keyof typeof TIMER_PERIOD_KEY]?: LiveInterval | TimerHandle | null };

/** Arm `name` at its configured period (replacing any timer already armed under it) and record
 *  what syncTimers needs to re-arm it later. */
export function armLive(timers: ActiveTimers, name: keyof ActiveTimers, fn: () => void, config?: Partial<HarnessConfig> | null): void {
  stopLive(timers, name);
  const periodMs = getTimings(config === undefined ? readConfigSafe() : config)[TIMER_PERIOD_KEY[name]];
  timers[name] = { handle: setInterval(fn, periodMs), fn, periodMs };
}

export function stopLive(timers: ActiveTimers, name: keyof ActiveTimers): void {
  const cur = timers[name];
  if (cur) clearInterval(isLiveInterval(cur) ? cur.handle : cur);
  timers[name] = null;
}

function isLiveInterval(v: LiveInterval | TimerHandle): v is LiveInterval {
  return typeof (v as LiveInterval).fn === 'function' && typeof (v as LiveInterval).periodMs === 'number';
}

/** A bare handle (not armed through armLive) has no record, so its callback and period come from
 *  node:test's mock fields (`callback`/`interval`) or a real Timeout's (`_onTimeout`/`_repeat`). */
interface IntervalInternals { callback?: () => void; interval?: number; _onTimeout?: () => void; _repeat?: number | null }

/** Re-arm each live interval whose configured period changed. A timer already on the right
 *  period is left alone so it keeps its phase. */
export function syncTimers(timers: ActiveTimers, config?: Partial<HarnessConfig> | null): void {
  const t = getTimings(config);
  for (const name of Object.keys(TIMER_PERIOD_KEY) as (keyof ActiveTimers)[]) {
    const cur = timers[name];
    if (!cur) continue;
    const want = t[TIMER_PERIOD_KEY[name]];
    if (isLiveInterval(cur)) {
      if (cur.periodMs === want) continue;
      clearInterval(cur.handle);
      timers[name] = { handle: setInterval(cur.fn, want), fn: cur.fn, periodMs: want };
      continue;
    }
    const inner = cur as unknown as IntervalInternals;
    const fn = inner.callback ?? inner._onTimeout;
    const current = inner.interval ?? inner._repeat;
    if (typeof fn !== 'function') { console.error(`[timings] cannot re-arm ${name}: arm it with armLive`); continue; }
    if (current === want) continue;
    clearInterval(cur);
    timers[name] = setInterval(fn, want);
  }
}

/** Self-rescheduling timer: asks `getIntervalMs` before every beat, so a changed period applies
 *  from the next one without re-arming. */
const LIVE_TIMER_SLICE_MS = MIN_PERIOD_MS;

export class LiveTimer {
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly callback: () => void | Promise<void>,
    private readonly getIntervalMs: () => number
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  get intervalMs(): number {
    return this.getIntervalMs();
  }

  /** Wake in short slices and fire once the live interval has elapsed since the last beat,
   *  so a changed interval applies to the beat already waiting, not only the one after. */
  private schedule(): void {
    let elapsed = 0;
    this.handle = setInterval(() => {
      elapsed += LIVE_TIMER_SLICE_MS;
      if (elapsed < this.getIntervalMs()) return;
      elapsed = 0;
      try {
        const r = this.callback();
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => console.error('[live timer]', e));
      } catch (e) {
        console.error('[live timer]', e);
      }
    }, LIVE_TIMER_SLICE_MS);
  }
}
