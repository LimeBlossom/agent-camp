/**
 * Engine usage limits formatting for Camp.
 *
 * Normalizes Claude, Codex, and Antigravity (agy) rate limits and quotas into a
 * shared shape for display on the phone page and desktop chips:
 *   - Claude: 5h and wk percent + resets-in
 *   - Codex: 5h and wk percent + resets-in
 *   - agy: gem, claude, and argon pools with 5h/wk percent + resets-in
 */
import { refreshInMs } from './agyRefresh';
import { isReservationActive, type Reservation } from './reservations';

export interface LimitSegment {
  label: string; // '5h' | 'wk'
  percent: number; // integer 0..100
  reset?: string; // '2h 10m' or undefined
}

export interface LimitPool {
  label: string; // 'gem' | 'claude' | 'argon'
  segments: LimitSegment[];
}

export interface PhoneEngineLimit {
  id: string; // 'claude' | 'codex' | 'agy'
  label: string;
  segments?: LimitSegment[];
  pools?: LimitPool[];
  /** Active engine reservations covering this engine, e.g. 'reserved for splat, visual until 2026-11-26'. */
  reserved?: string[];
}

export interface LimitWindowInput {
  percent: number;
  resetsAt?: number;
}

export interface ClaudeLimitsInput {
  fiveHour?: LimitWindowInput;
  sevenDay?: LimitWindowInput;
  sevenDayFable?: LimitWindowInput;
}

export interface CodexLimitsInput {
  fiveHour?: { percent: number; resetsAt?: number; reset?: boolean };
  weekly?: { percent: number; resetsAt?: number; reset?: boolean };
}

export interface AgyQuotaInput {
  at: number;
  pools: Array<{
    name: string;
    label: string;
    fiveHour?: { remaining: number; note?: string };
    weekly?: { remaining: number; note?: string };
  }>;
}

/** Format a millisecond duration into a compact span: "45m", "2h 10m", "3d 4h". */
export function formatDurationCompact(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '';
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function untilResetSeconds(resetsAtSec: number | undefined, nowMs: number): string | undefined {
  if (resetsAtSec === undefined || !Number.isFinite(resetsAtSec)) return undefined;
  const ms = resetsAtSec * 1000 - nowMs;
  return ms > 0 ? formatDurationCompact(ms) : undefined;
}

export function formatClaudeLimits(limits: ClaudeLimitsInput | null | undefined, nowMs = Date.now()): PhoneEngineLimit | null {
  if (!limits) return null;
  const segments: LimitSegment[] = [];
  if (limits.fiveHour) {
    const reset = untilResetSeconds(limits.fiveHour.resetsAt, nowMs);
    segments.push({
      label: '5h',
      percent: Math.round(limits.fiveHour.percent),
      ...(reset ? { reset } : {})
    });
  }
  if (limits.sevenDay) {
    const reset = untilResetSeconds(limits.sevenDay.resetsAt, nowMs);
    segments.push({
      label: 'wk',
      percent: Math.round(limits.sevenDay.percent),
      ...(reset ? { reset } : {})
    });
  }
  if (limits.sevenDayFable) {
    const reset = untilResetSeconds(limits.sevenDayFable.resetsAt, nowMs);
    segments.push({
      label: 'fable',
      percent: Math.round(limits.sevenDayFable.percent),
      ...(reset ? { reset } : {})
    });
  }
  if (!segments.length) return null;
  return { id: 'claude', label: 'claude', segments };
}

export function formatCodexLimits(limits: CodexLimitsInput | null | undefined, nowMs = Date.now()): PhoneEngineLimit | null {
  if (!limits) return null;
  const segments: LimitSegment[] = [];
  if (limits.fiveHour) {
    const reset = !limits.fiveHour.reset ? untilResetSeconds(limits.fiveHour.resetsAt, nowMs) : undefined;
    segments.push({
      label: '5h',
      percent: Math.round(limits.fiveHour.percent),
      ...(reset ? { reset } : {})
    });
  }
  if (limits.weekly) {
    const reset = !limits.weekly.reset ? untilResetSeconds(limits.weekly.resetsAt, nowMs) : undefined;
    segments.push({
      label: 'wk',
      percent: Math.round(limits.weekly.percent),
      ...(reset ? { reset } : {})
    });
  }
  if (!segments.length) return null;
  return { id: 'codex', label: 'codex', segments };
}

export function formatAgyQuota(quota: AgyQuotaInput | null | undefined, nowMs = Date.now()): PhoneEngineLimit | null {
  if (!quota || !Array.isArray(quota.pools) || !quota.pools.length) return null;
  const pools: LimitPool[] = [];
  for (const p of quota.pools) {
    const segments: LimitSegment[] = [];
    if (p.label !== 'argon' && p.fiveHour) {
      const resetMs = refreshInMs(p.fiveHour.note);
      const reset = resetMs ? formatDurationCompact(quota.at + resetMs - nowMs) : undefined;
      segments.push({
        label: '5h',
        percent: Math.round(Math.max(0, 100 - p.fiveHour.remaining)),
        ...(reset ? { reset } : {})
      });
    }
    if (p.weekly) {
      const resetMs = refreshInMs(p.weekly.note);
      const reset = resetMs ? formatDurationCompact(quota.at + resetMs - nowMs) : undefined;
      segments.push({
        label: 'wk',
        percent: Math.round(Math.max(0, 100 - p.weekly.remaining)),
        ...(reset ? { reset } : {})
      });
    }
    if (segments.length) {
      pools.push({ label: p.label, segments });
    }
  }
  if (!pools.length) return null;
  return { id: 'agy', label: 'agy', pools };
}

/** A chip's id where it differs from the provider name a reservation uses. */
const CHIP_PROVIDER: Record<string, string> = { agy: 'antigravity' };

export function formatAllLimits(
  sources: {
    claude?: ClaudeLimitsInput | null;
    codex?: CodexLimitsInput | null;
    agy?: AgyQuotaInput | null;
  },
  nowMs = Date.now(),
  reservations: readonly Reservation[] = []
): PhoneEngineLimit[] {
  const out: PhoneEngineLimit[] = [];
  const c = formatClaudeLimits(sources.claude, nowMs);
  if (c) out.push(c);
  const cx = formatCodexLimits(sources.codex, nowMs);
  if (cx) out.push(cx);
  const ag = formatAgyQuota(sources.agy, nowMs);
  if (ag) out.push(ag);
  return out.map((chip) => {
    const held = reservations.filter((r) => isReservationActive(r, nowMs) && (CHIP_PROVIDER[chip.id] ?? chip.id) === r.provider);
    return held.length ? { ...chip, reserved: held.map((r) => `${r.model ? `${r.model}: ` : ''}${r.kinds.join(', ') || 'no work'} until ${r.until.slice(0, 10)}`) } : chip;
  });
}
