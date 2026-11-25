/**
 * A provider that has stopped taking work because its usage limit is spent.
 *
 * Three signals, any one of which marks an engine exhausted until its reset:
 *  - the agent's own session log carries the CLI's refusal (Codex rollout
 *    `task_complete` with `usage_limit_exceeded`, Claude Code's API error record),
 *    or agy records a structured refusal or prints one in its terminal (agyRefusal),
 *  - a usage reading at 100% of a window that has not reset yet,
 *  - an agy pool with 0% remaining.
 * An exhausted engine reads as full to the balancer whatever its last percent was
 * (applyExhaustion), and limitDecision says whether a live agent on one should move
 * to another entry of its model list or wait for the reset. Pure, so
 * test/provider-limits.test.cjs can pin the parsing and the decision.
 */
import type { Candidate, EngineId, EngineReadings, UsageWindow } from './engineChoice';
import { durationMs } from '../shared/agyRefresh';

export interface LimitHit {
  /** When the CLI recorded the refusal, ms since epoch. */
  atMs: number;
  /** When the provider says it takes work again; undefined when the message has no time. */
  resetAtMs?: number;
  message: string;
}

export interface Exhaustion {
  untilMs: number;
  /** One line for the log: what said the engine is out. */
  source: string;
}

export type ExhaustionMap = Partial<Record<EngineId, Exhaustion>>;

/** Codex: "You’ve hit your usage limit." Claude Code: "Claude AI usage limit reached",
 *  "5-hour limit reached", "You've hit your limit". The apostrophe may be curly. A bare
 *  "limit reached" is not enough: context and output-token limits say that too. */
const LIMIT_TEXT = /hit your (?:usage )?limit|usage limit (?:reached|exceeded)|(?:5-hour|five-hour|weekly|session|daily|opus|sonnet) limit reached/i;

/** A refusal with no time in it holds the engine this long from the refusal. */
export const UNKNOWN_RESET_MS = 60 * 60_000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

/**
 * The reset time a refusal names, in the machine's local time, or undefined.
 * Forms: "try again at 1:08 AM", "try again at Oct 5th, 2026 1:08 AM",
 * "try again in 2 hours 5 minutes", "resets 3am", "reset at 3pm (America/Chicago)",
 * and Claude Code's older "limit reached|<unix seconds>". A clock time with no date
 * is the next such time after `afterMs`. The "(zone)" suffix is not applied: the
 * CLIs print the user's own zone, which is this machine's.
 */
export function parseResetTime(text: string, afterMs: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const rel = /try again in ([^.]+)/i.exec(text);
  if (rel) {
    let ms = 0;
    let any = false;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*(day|hour|hr|minute|min|second|sec|[dhms])\w*/gi)) {
      const u = unit.toLowerCase();
      const per = u.startsWith('d') ? 86_400_000 : u.startsWith('h') ? 3_600_000 : u.startsWith('m') ? 60_000 : 1000;
      ms += Number(n) * per;
      any = true;
    }
    if (any) return afterMs + ms;
  }
  const clock = /(?:try again at|resets?(?: at)?)\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i.exec(text);
  if (!clock) return undefined;
  const [, mon, day, year, hh, mm, ap] = clock;
  let h = Number(hh) % 12;
  if (ap.toLowerCase() === 'p') h += 12;
  const d = new Date(afterMs);
  if (mon && day) {
    const mi = MONTHS.indexOf(mon.toLowerCase());
    if (mi < 0) return undefined;
    const at = new Date(year ? Number(year) : d.getFullYear(), mi, Number(day), h, Number(mm ?? 0), 0, 0);
    if (!year && at.getTime() < afterMs - 86_400_000) at.setFullYear(at.getFullYear() + 1);
    return at.getTime();
  }
  d.setHours(h, Number(mm ?? 0), 0, 0);
  if (d.getTime() <= afterMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function hitFrom(message: string, ts: unknown): LimitHit | null {
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const resetAtMs = parseResetTime(message, atMs);
  return { atMs, message, ...(resetAtMs !== undefined ? { resetAtMs } : {}) };
}

/**
 * The refusal that ended the session's latest turn in a Codex rollout (or its tail),
 * or null. A later turn that completed without an error clears an earlier refusal, so
 * an agent that got through after a reset is not held again.
 */
export function codexLimitHit(text: string): LimitHit | null {
  let hit: LimitHit | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('task_complete') && !line.includes('"error"')) continue;
    const d = parseLine(line);
    const p = d?.payload as { type?: unknown; error?: unknown; message?: unknown } | undefined;
    if (!d || d.type !== 'event_msg' || !p) continue;
    if (p.type === 'task_complete') {
      const err = p.error as { message?: unknown; codex_error_info?: unknown } | null | undefined;
      const msg = typeof err?.message === 'string' ? err.message : '';
      if (err && (err.codex_error_info === 'usage_limit_exceeded' || isLimitText(msg))) hit = hitFrom(msg, d.timestamp) ?? hit;
      else hit = null;
    } else if (p.type === 'error' && typeof p.message === 'string' && isLimitText(p.message)) {
      hit = hitFrom(p.message, d.timestamp) ?? hit;
    }
  }
  return hit;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The usage-limit refusal at the end of a Claude Code transcript (or its tail), or
 * null. Claude Code records the refusal as an assistant message flagged
 * `isApiErrorMessage`; any later real assistant reply clears it.
 */
export function claudeLimitHit(text: string): LimitHit | null {
  let hit: LimitHit | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    const d = parseLine(line);
    if (!d || d.type !== 'assistant') continue;
    const msg = blockText((d.message as { content?: unknown } | undefined)?.content);
    const isError = d.isApiErrorMessage === true || d.error === 'rate_limit';
    if (isError && isLimitText(msg)) hit = hitFrom(msg, d.timestamp) ?? hit;
    else if (!isError && msg.trim()) hit = null;
  }
  return hit;
}

/** agy (1.2.14) prints a refused turn into its TUI as one red line, then its error id:
 *    ⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h16m24s.
 *    Error ID: 5d4a33c7-5290-407f-8ec9-84f0bb8be1c1-1
 *  The line must start with the warning sign, so an agent reading this file (or a test
 *  quoting the text) in its terminal does not count as a refusal. */
const AGY_REFUSAL = /^[ \t]*⚠[ \t]*(Individual quota reached\.[\s\S]*?)(?=\n[ \t]*Error ID:|(?![\s\S]))/gm;

export interface AgyRefusal {
  message: string;
  /** agy's own id for the refusal; the same refusal redrawn keeps it. */
  errorId?: string;
  /** "Resets in 4h16m24s" as milliseconds from when it was printed. */
  resetInMs?: number;
}

/** Terminal output with colour and cursor escapes removed. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

/** The last agy refusal sentence in terminal text, including an unterminated final line. */
export function agyRefusal(raw: string): AgyRefusal | null {
  let last: AgyRefusal | null = null;
  const text = stripAnsi(raw);
  for (const m of text.matchAll(AGY_REFUSAL)) {
    const message = m[1].replace(/\s+/g, ' ').trim();
    if (!message.endsWith('.')) continue;
    const reset = /Resets in ((?:\d+[dhms])+)/i.exec(message);
    const resetInMs = reset ? durationMs(reset[1]) : undefined;
    const after = text.slice((m.index ?? 0) + m[0].length);
    const id = /^\n[ \t]*Error ID:[ \t]*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-\d+)(?=\s|$)/i.exec(after)?.[1];
    last = { message, ...(id ? { errorId: id } : {}), ...(resetInMs !== undefined ? { resetInMs } : {}) };
  }
  return last;
}

/** How long a refusal holds its engine: its own reset time, else UNKNOWN_RESET_MS. */
export function hitUntil(hit: LimitHit): number {
  return hit.resetAtMs ?? hit.atMs + UNKNOWN_RESET_MS;
}

/** The latest reset among windows at 100% that have not reset by `nowMs`; undefined
 *  when none is spent or a spent one has no reset time. */
export function spentUntil(windows: ReadonlyArray<UsageWindow | undefined>, nowMs: number): number | undefined {
  const spent = windows.filter((w): w is UsageWindow => !!w && w.percent >= 100 && (w.resetsAtMs === undefined || w.resetsAtMs > nowMs));
  if (!spent.length || spent.some((w) => w.resetsAtMs === undefined)) return undefined;
  return Math.max(...spent.map((w) => w.resetsAtMs as number));
}

/** Add `until` for `engine`, keeping the later of two holds. Past holds are not added. */
export function noteExhaustion(map: ExhaustionMap, engine: EngineId, untilMs: number, source: string, nowMs: number): void {
  if (!(untilMs > nowMs)) return;
  const prev = map[engine];
  if (!prev || prev.untilMs < untilMs) map[engine] = { untilMs, source };
}

export function isExhausted(map: ExhaustionMap, engine: EngineId | undefined, nowMs: number): boolean {
  return !!engine && (map[engine]?.untilMs ?? 0) > nowMs;
}

/** Remove an engine from the exhaustion map when its capacity is restored or hold cleared. */
export function clearExhaustion(map: ExhaustionMap, engine: EngineId): boolean {
  if (engine in map && map[engine] !== undefined) {
    delete map[engine];
    return true;
  }
  return false;
}

export interface CapacityRestoredOptions {
  ordinaryUsageAllowed?: boolean;
  wasExhausted?: boolean;
  exhaustedAtMs?: number;
  sampleAtMs?: number;
}

/**
 * An exhausted engine whose capacity has returned and whose provider confirms usage is allowed.
 * - Codex: all windows under 100% AND ordinaryUsageAllowed is true (unknown/undefined never counts).
 * - Claude: all windows under 100%.
 * - Antigravity: all pool windows under 100% (>0% quota remaining).
 * Must have been previously exhausted (wasExhausted = true). Missing/empty windows, non-finite
 * percentages, or any window at 100% reject. When exhaustion/sample timestamps are supplied,
 * the sample must be strictly newer than the exhaustion/refusal timestamp.
 */
export function isCapacityRestored(
  engine: EngineId,
  windows: ReadonlyArray<UsageWindow | undefined> | undefined,
  options?: CapacityRestoredOptions
): boolean {
  if (!options?.wasExhausted) return false;
  if (!windows || !windows.length) return false;
  const defined = windows.filter((w): w is UsageWindow => w !== undefined && w !== null);
  if (!defined.length) return false;
  if (defined.some((w) => typeof w.percent !== 'number' || !Number.isFinite(w.percent) || w.percent < 0 || w.percent >= 100)) {
    return false;
  }
  if (engine === 'codex' && options?.ordinaryUsageAllowed !== true) return false;

  const hasWindowSample = defined.some((w) => 'sampleAtMs' in w);
  const windowSampleAtMs = hasWindowSample
    ? (defined.every((w) => typeof w.sampleAtMs === 'number' && Number.isFinite(w.sampleAtMs))
        ? Math.min(...defined.map((w) => w.sampleAtMs as number))
        : NaN)
    : undefined;
  if (hasWindowSample && !Number.isFinite(windowSampleAtMs)) return false;

  const checkFreshness = (options !== undefined && ('exhaustedAtMs' in options || 'sampleAtMs' in options)) || hasWindowSample;
  if (checkFreshness) {
    const sampleAtMs = options && 'sampleAtMs' in options ? options.sampleAtMs : windowSampleAtMs;
    if (typeof sampleAtMs !== 'number' || !Number.isFinite(sampleAtMs)) return false;
    if (options && 'exhaustedAtMs' in options) {
      if (typeof options.exhaustedAtMs !== 'number' || !Number.isFinite(options.exhaustedAtMs)) return false;
      if (sampleAtMs <= options.exhaustedAtMs) return false;
    }
  }
  return true;
}

export interface CapacityRestoredEvent {
  kind: 'capacity-restored';
  engine: EngineId;
  atMs: number;
  ordinaryUsageAllowed?: boolean;
  wokenAgents?: string[];
  [key: string]: unknown;
}

/** Formats a structured capacity-restored event record for the hive log. */
export function createCapacityRestoredEvent(
  engine: EngineId,
  atMs: number,
  meta?: { ordinaryUsageAllowed?: boolean; wokenAgents?: string[] }
): CapacityRestoredEvent {
  return {
    kind: 'capacity-restored',
    engine,
    atMs,
    ...(meta?.ordinaryUsageAllowed !== undefined ? { ordinaryUsageAllowed: meta.ordinaryUsageAllowed } : {}),
    ...(meta?.wokenAgents !== undefined ? { wokenAgents: meta.wokenAgents } : {})
  };
}

/** Readings with every exhausted engine forced full until its hold ends, so the
 *  balancer skips it however low its last reading was. */
export function applyExhaustion(readings: EngineReadings, map: ExhaustionMap, nowMs: number): EngineReadings {
  const out: EngineReadings = { ...readings };
  for (const id of Object.keys(map) as EngineId[]) {
    const ex = map[id];
    if (!ex || ex.untilMs <= nowMs) continue;
    const prev = out[id]?.roomAtMs;
    out[id] = { percent: 100, roomAtMs: prev !== undefined && prev > ex.untilMs ? prev : ex.untilMs };
  }
  return out;
}

export type LimitDecision =
  | { kind: 'ok' }
  | { kind: 'switch'; index: number }
  | { kind: 'wait'; untilMs?: number };

/**
 * What to do with an agent whose current engine may be out.
 * `pick` is limitSwitchPick over `cands` with applyExhaustion's readings; it only
 * counts as a way out when it draws on a different engine that is not exhausted
 * (another model on the same meter hits the same wall). `canSwitch` is false for an
 * agent that must keep its session (a temporary worker, one the human holds).
 */
export function limitDecision(
  current: EngineId | undefined,
  cands: readonly Candidate[],
  pick: { index: number } | null,
  map: ExhaustionMap,
  nowMs: number,
  canSwitch = true
): LimitDecision {
  if (!isExhausted(map, current, nowMs)) return { kind: 'ok' };
  const alt = pick ? cands[pick.index] : undefined;
  if (canSwitch && pick && alt && alt.engine !== current && !isExhausted(map, alt.engine, nowMs)) {
    return { kind: 'switch', index: pick.index };
  }
  return { kind: 'wait', untilMs: current ? map[current]?.untilMs : undefined };
}

/** After the reset, the one "continue" nudge waits this long, so the provider's own
 *  clock has certainly rolled over. */
export const RESUME_GRACE_MS = 60_000;

/** The toast for an agent that has started waiting at a limit. Main's toasts are not
 *  localized (breakerToast's are English literals), so neither is this. */
export function limitLockText(name: string, provider: string, resetAtMs: number | undefined): string {
  const resets = resetAtMs !== undefined
    ? `, resets ${new Date(resetAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${name} is locked: ${provider} limit reached${resets}. Add another model to its Balance list to keep it working.`;
}

/**
 * One toast per limit hold. The beat calls held() every pass an agent waits and
 * keepOnly() with the agents still waiting once it is done, so an agent toasts again
 * only after its hold ended. A limit switch never calls held(): the switch keeps the
 * work going, so it is logged and not toasted.
 */
export class LimitLockNotices {
  private readonly told = new Set<string>();

  constructor(
    private readonly enabled: () => boolean,
    private readonly show: (title: string, body: string) => void
  ) {}

  held(agentId: string, name: string, provider: string, resetAtMs: number | undefined): void {
    if (this.told.has(agentId)) return;
    // Marked even with notifications off, so turning them on mid-hold does not toast
    // a hold that began earlier.
    this.told.add(agentId);
    if (this.enabled()) this.show('Agent locked by usage limit', limitLockText(name, provider, resetAtMs));
  }

  keepOnly(heldIds: Iterable<string>): void {
    const keep = new Set(heldIds);
    for (const id of this.told) if (!keep.has(id)) this.told.delete(id);
  }
}
