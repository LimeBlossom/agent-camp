/**
 * Picking an engine from how much of each subscription is left. A temporary worker's
 * spawn request may list `engines` in order of preference; the first one that is
 * installed and below ENGINE_FULL_PERCENT of its tighter window gets the worker
 * (chooseEngine). A persistent agent's fresh start balances over its own model list
 * (balanceEngines). Pure, so test/engine-choice.test.cjs can pin both.
 */
import { isAgentProvider, type AgentProvider } from '../shared/agentProvider';
import { isMaxPercent } from '../shared/modelBalance';
import { VISUAL_CHECK_POINTER, WORK_KINDS } from '../shared/workKind';

/** An engine a request can name: which CLI runs it, and on which model when that is
 *  what separates it from another engine on the same CLI. agy has a quota pool each for
 *  Gemini, for Claude and GPT, and for Gemini 4 Argon, so each is a separate engine. */
export interface Engine {
  id: EngineId;
  provider: AgentProvider;
  model?: string;
  description?: string;
}

export type EngineId = 'agy' | 'agy-claude' | 'agy-argon' | 'codex' | 'claude';

export const DEFAULT_ENGINES: Record<EngineId, Engine> = {
  // Pinned: agy 1.4.0 made Gemini 4 Argon its default, and the cheap tier must not
  // follow agy's default onto a model nobody has tested or budgeted.
  agy: { id: 'agy', provider: 'antigravity', model: 'gemini-3.8-flash-high', description: 'Gemini Flash' },
  'agy-claude': { id: 'agy-claude', provider: 'antigravity', model: 'claude-opus-5-5-high', description: "Claude Opus 5.5 on agy's separate quota" },
  // Metered for persistent agents on Argon; not in ALIASES, so a spawn request cannot name it.
  'agy-argon': { id: 'agy-argon', provider: 'antigravity', model: 'gemini-4-argon-medium' },
  codex: { id: 'codex', provider: 'codex' },
  claude: { id: 'claude', provider: 'claude' }
};

export const ENGINES = DEFAULT_ENGINES;

export interface EngineThresholds {
  fullPercent: number;
  headroomMargin: number;
  resetSoonMs: number;
}

export interface EngineConfig {
  engines?: Partial<Record<EngineId, Partial<Engine>>>;
  engineThresholds?: Partial<EngineThresholds>;
}

export interface EngineOptions {
  engines?: Partial<Record<EngineId, Partial<Engine>>>;
  thresholds?: Partial<EngineThresholds>;
}

/** Only compiled engine IDs and providers can be configured. */
export function getEngines(config: EngineConfig = {}): Record<EngineId, Engine> {
  const result = {} as Record<EngineId, Engine>;
  for (const id of Object.keys(DEFAULT_ENGINES) as EngineId[]) {
    const base = DEFAULT_ENGINES[id];
    const entry = config.engines?.[id];
    result[id] = {
      ...base,
      ...(isAgentProvider(entry?.provider) ? { provider: entry.provider } : {}),
      ...(typeof entry?.model === 'string' ? { model: entry.model } : {}),
      ...(typeof entry?.description === 'string' ? { description: entry.description } : {}),
      id
    };
  }
  return result;
}

export function getEngineThresholds(config: EngineConfig = {}): EngineThresholds {
  const result = { ...DEFAULT_ENGINE_THRESHOLDS };
  for (const key of Object.keys(result) as (keyof EngineThresholds)[]) {
    const value = config.engineThresholds?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (key !== 'fullPercent' || (value > 0 && value <= 100))) result[key] = value;
  }
  return result;
}

/** The order the Boss prompt teaches: Claude first for code work, Codex next, then agy
 *  (Flash) for easy or bulk work. The names in the prose follow it too. */
export const PROMPT_ENGINE_ORDER: EngineId[] = ['claude', 'codex', 'agy-claude', 'agy'];

export function formatEnginePromptProse(engines = DEFAULT_ENGINES, wrap = false): string {
  const names = PROMPT_ENGINE_ORDER.map((id) => `"${id}"${engines[id]?.description ? ` (${engines[id].description})` : ''}`);
  return `\`engines\` is optional, instead of command/provider: the engines this task may run on, in order
of preference, from ${names.slice(0, -1).join(', ')}${wrap ? '\n' : ' '}and ${names[names.length - 1]}. The harness takes the first with usage room and tells you which. Claude first for code
work: default to ${JSON.stringify(PROMPT_ENGINE_ORDER)}, where a compile, a test run or a file that must
exist shows whether it worked; agy (Flash) is for easy or bulk work. Put "codex" first for visual judging
and image generation, which Codex keeps a reserve for (cap it, e.g. "codex@50"), but only when the worker's
own judgment of a look or the images it makes are the deliverable: a visual check is code, so code whose
one look step is a yes/no check is code work, and ${VISUAL_CHECK_POINTER}. Research, design and other
judgment calls go on a named \`provider\` instead. \`difficulty\` (easy|normal|hard) sets the worker's effort;
hard keeps your order but takes Flash only when nothing stronger has room. \`kind\`
(${WORK_KINDS.join('|')}) says what the work is, on a card and on a spawn request. The human can reserve an engine's
quota for some kinds until a date; the camp drops a reserved engine for any other kind, and for work with no kind,
and moves it first for the kinds it is reserved for. Do not list a reserved engine to get around that, and
code work should not list "codex".`;
}

const ALIASES: Record<string, EngineId> = {
  agy: 'agy',
  antigravity: 'agy',
  'agy-claude': 'agy-claude',
  codex: 'codex',
  claude: 'claude'
};

/** An engine at or past this share of its tighter usage window is skipped. */
export const ENGINE_FULL_PERCENT = 85;

/** Percent used of each engine's tighter window; undefined when there is no reading. */
export type EngineUsage = Partial<Record<EngineId, number>>;

/** chooseEngine takes either a bare percent per engine or a full reading with pace. */
export type EngineUsageOrReadings = Partial<Record<EngineId, number | EngineReading>>;

export interface EngineChoice {
  engine: Engine;
  /** One line for the Boss and the log: what was picked and why. */
  reason: string;
}

/** A request's engine with its own usage cap: skipped once its meter reaches `maxPercent`. */
export interface CappedEngine {
  engine: EngineId;
  maxPercent: number;
}

/** An entry of a request's `engines` list: a bare engine, or one with a cap. */
export type EngineRef = EngineId | CappedEngine;

export function engineRefId(ref: EngineRef): EngineId {
  return typeof ref === 'string' ? ref : ref.engine;
}

/** The request's `engines` list as known engines, in order, without repeats. An item is
 *  "codex", "codex@50" or { engine, maxPercent }; one with a bad cap is dropped rather
 *  than run uncapped. */
export function parseEngineList(raw: unknown): EngineRef[] {
  if (!Array.isArray(raw)) return [];
  const out: EngineRef[] = [];
  for (const e of raw) {
    let name = '';
    let cap: unknown;
    if (typeof e === 'string') {
      const at = e.indexOf('@');
      name = (at >= 0 ? e.slice(0, at) : e).trim().toLowerCase();
      if (at >= 0) cap = /^\s*\d+\s*$/.test(e.slice(at + 1)) ? Number(e.slice(at + 1)) : NaN;
    } else if (e && typeof e === 'object') {
      const o = e as { engine?: unknown; maxPercent?: unknown };
      name = typeof o.engine === 'string' ? o.engine.trim().toLowerCase() : '';
      cap = o.maxPercent;
    }
    const id = Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined;
    if (!id || out.some((r) => engineRefId(r) === id)) continue;
    if (cap === undefined) out.push(id);
    else if (isMaxPercent(cap)) out.push({ engine: id, maxPercent: cap });
  }
  return out;
}

/** The first listed engine that is installed and has room, unless a later one with room
 *  ranks ahead on the reset-soon or lockout rule (see balanceEngines). An engine with no reading
 *  counts as having room, since a missing meter is far more often a fresh session than
 *  an exhausted one. When every installed engine is full, the least-used one is taken
 *  rather than failing the worker. Null when no installed engine is free of an explicit refusal. */
export function chooseEngine(
  engines: ReadonlyArray<EngineRef | string>,
  usage: EngineUsageOrReadings,
  installed: (p: AgentProvider) => boolean,
  blocked: (engine: Engine) => boolean = () => false,
  options: EngineOptions = {}
): EngineChoice | null {
  const table = getEngines({ engines: options.engines });
  // "codex@50" arrives unparsed from callers that skip parseEngineList; a bare id passes through.
  const refs = engines.flatMap((e) => (typeof e === 'string' && !e.includes('@') ? [e as EngineId] : parseEngineList([e])));
  const usable = refs.filter((ref) => {
    const id = engineRefId(ref);
    return Object.hasOwn(table, id) && installed(table[id].provider) && !blocked(table[id]);
  });
  if (!usable.length) return null;
  const readings: EngineReadings = {};
  for (const id of usable.map(engineRefId)) {
    const u = usage[id];
    if (typeof u === 'number') readings[id] = { percent: u };
    else if (u && u.percent !== undefined) readings[id] = u;
  }
  const pick = pickCandidate(usable.map((ref) => ({ engine: engineRefId(ref), label: engineRefId(ref), ...(typeof ref === 'object' ? { maxPercent: ref.maxPercent } : {}) })), readings, { margin: Infinity, whenFull: 'least-used' }, 0, getEngineThresholds({ engineThresholds: options.thresholds }));
  if (!pick) return null;
  return { engine: table[engineRefId(usable[pick.index])], reason: pick.reason };
}

/** A window that resets within this long counts as empty: it will have room again before
 *  a fresh session has done much. */
export const RESET_SOON_MS = 15 * 60_000;

/** A persistent agent leaves its preferred (earlier) entry for a later one only when the
 *  preferred one's pace is at least this many points higher. Pace is still percent of a
 *  window, only taken at reset instead of now, so the unit is unchanged. */
export const HEADROOM_MARGIN = 30;

export const DEFAULT_ENGINE_THRESHOLDS: EngineThresholds = {
  fullPercent: ENGINE_FULL_PERCENT,
  headroomMargin: HEADROOM_MARGIN,
  resetSoonMs: RESET_SOON_MS
};

/** Pace never divides by less than this share of a window elapsed, so a reading taken
 *  early in a window projects at most 1/PACE_MIN_ELAPSED times its real percent. */
export const PACE_MIN_ELAPSED = 0.1;

export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;

/** One usage window: percent used and, when known, when it resets (ms since epoch) and
 *  how long the window is. */
export interface UsageWindow {
  percent: number;
  resetsAtMs?: number;
  lengthMs?: number;
  /** When the provider sampled this window, ms since epoch. */
  sampleAtMs?: number;
}

/** An engine as the balancer sees it: percent used of its tighter window after the
 *  reset-soon discount, and, when it is full, when it next has room. `pace` and
 *  `lockoutMs` come from its longest window (the 7d), which decides who gets work:
 *  Running out of a week matters more than of the next 5 hours. A
 *  shorter window only stops an engine, through `percent` at ENGINE_FULL_PERCENT. With
 *  no window of known length, pace and lockout are the worst among its windows. They
 *  only order candidates that have room, while skipping, the all-full fallbacks and
 *  exhaustion stay on `percent`. */
export interface EngineReading {
  percent?: number;
  roomAtMs?: number;
  /** The window `percent` came from, e.g. "5h". */
  window?: string;
  /** The ranking window's own percent and name, when it is not the one `percent` came from. */
  rankPercent?: number;
  rankWindow?: string;
  pace?: number;
  /** The window `pace` came from; absent when that window's length or reset is unknown,
   *  so its pace is its real percent. */
  paceWindow?: string;
  /** How long the engine is projected to sit empty before its reset: the longest
   *  projectedLockoutMs among its windows, 0 when none runs dry. */
  lockoutMs?: number;
  /** Time until the ranking window resets, and the percent it is projected to leave
   *  unused at that reset (100 minus pace, so 0 for an engine at or over pace) per hour
   *  until then; only for a ranking window longer than RESET_PRIORITY_MS not yet reset. */
  resetInMs?: number;
  unusedPerHour?: number;
  /** The ranking window resets within RESET_PRIORITY_MS, is under 100%, projects no
   *  lockout, and no other window is at ENGINE_FULL_PERCENT: the engine has room
   *  however high `percent` is (2026-10-23 ledger: Claude's last 6% of 7d was skipped). */
  spendBeforeReset?: boolean;
}

export type EngineReadings = Partial<Record<EngineId, EngineReading>>;

/** Fold an engine's windows into one reading at `nowMs`. A window past its reset or
 *  within RESET_SOON_MS of it reads 0%. `roomAtMs` is the latest reset among the windows
 *  that are full, since the engine has room only once all of them have reset; unknown
 *  when any full window has no reset time. */
export function readEngine(windows: ReadonlyArray<UsageWindow | undefined>, nowMs: number, options: EngineOptions = {}): EngineReading {
  const { fullPercent, resetSoonMs } = getEngineThresholds({ engineThresholds: options.thresholds });
  const known = windows.filter((w): w is UsageWindow => !!w && typeof w.percent === 'number' && Number.isFinite(w.percent));
  if (!known.length) return {};
  const eff = known.map((w) => ({ ...w, percent: w.resetsAtMs !== undefined && w.resetsAtMs - nowMs < resetSoonMs ? 0 : w.percent }));
  const top = eff.reduce((a, b) => (b.percent > a.percent ? b : a));
  const sized = eff.filter((w) => w.lengthMs !== undefined && w.lengthMs > 0);
  const longest = sized.length ? sized.reduce((a, b) => ((b.lengthMs as number) > (a.lengthMs as number) ? b : a)) : undefined;
  const paced = eff.map((w) => ({ w, pace: projectedPercent(w, nowMs) }));
  const rank = longest ? paced.find((p) => p.w === longest)! : paced.reduce((a, b) => (b.pace > a.pace ? b : a));
  const base: EngineReading = { percent: top.percent };
  const win = windowName(top.lengthMs);
  if (win) base.window = win;
  if (longest && longest !== top && longest.percent !== top.percent) {
    base.rankPercent = longest.percent;
    const rankWin = windowName(longest.lengthMs);
    if (rankWin) base.rankWindow = rankWin;
  }
  base.pace = rank.pace;
  const paceWin = rank.w.resetsAtMs !== undefined ? windowName(rank.w.lengthMs) : undefined;
  if (paceWin) base.paceWindow = paceWin;
  base.lockoutMs = longest ? projectedLockoutMs(longest, nowMs) : Math.max(...eff.map((w) => projectedLockoutMs(w, nowMs)));
  if (longest && longest.resetsAtMs !== undefined && longest.resetsAtMs > nowMs && (longest.lengthMs as number) > RESET_PRIORITY_MS) {
    // Real percent, not the reset-soon 0%: the room about to be lost is what is really left.
    const real = { ...longest, percent: known[eff.indexOf(longest)].percent };
    base.resetInMs = longest.resetsAtMs - nowMs;
    base.unusedPerHour = Math.max(0, 100 - projectedPercent(real, nowMs)) / (Math.max(base.resetInMs, 60_000) / 3_600_000);
    if (base.resetInMs < RESET_PRIORITY_MS && real.percent < 100 && projectedLockoutMs(real, nowMs) === 0
      && eff.every((w) => w === longest || w.percent < fullPercent)) base.spendBeforeReset = true;
  }
  if (top.percent < fullPercent || base.spendBeforeReset) return base;
  const full = eff.filter((w) => w.percent >= fullPercent);
  if (full.some((w) => w.resetsAtMs === undefined)) return base;
  return { ...base, roomAtMs: Math.max(...full.map((w) => w.resetsAtMs as number)) };
}

/** Percent used projected to the window's reset at the rate so far: percent over the
 *  share of the window elapsed, that share floored at PACE_MIN_ELAPSED. A window with
 *  no known length or reset time projects as its real percent. */
export function projectedPercent(w: UsageWindow, nowMs: number): number {
  if (!(w.percent > 0) || w.resetsAtMs === undefined || !w.lengthMs || !(w.lengthMs > 0)) return w.percent;
  const elapsed = Math.min(1, Math.max(0, 1 - (w.resetsAtMs - nowMs) / w.lengthMs));
  return w.percent / Math.max(elapsed, PACE_MIN_ELAPSED);
}

/** How long a window is projected to sit at 100% before it resets: the reset minus the
 *  run-out time, at the rate so far from the window's start (the same elapsed floor as
 *  projectedPercent). 0 for a window whose pace is 100% or less, or whose length or
 *  reset is unknown. */
export function projectedLockoutMs(w: UsageWindow, nowMs: number): number {
  const pace = projectedPercent(w, nowMs);
  if (!(pace > 100) || w.resetsAtMs === undefined || !w.lengthMs || !(w.lengthMs > 0)) return 0;
  const runOutMs = Math.max(nowMs, w.resetsAtMs - w.lengthMs + (w.lengthMs * 100) / pace);
  return Math.max(0, w.resetsAtMs - runOutMs);
}

/** Two projected lockouts closer than this count as equal, and the pace rule decides.
 *  A run-out time moves by about this much per meter point on a 7d window mid-week
 *  (68% at 1.96 days in: one point shifts it ~1 h), so a smaller gap is meter rounding. */
export const LOCKOUT_TIE_MS = 3_600_000;

/** A ranking window longer than this that resets within it puts its engine on the
 *  use-it-or-lose-it rule (see pickCandidate): an engine close to its
 *  reset is prioritised, since its unused room is lost at the reset. Such a window at
 *  ENGINE_FULL_PERCENT or more does not skip the engine while it is projected not to
 *  lock out (see EngineReading.spendBeforeReset). */
export const RESET_PRIORITY_MS = 24 * 3_600_000;

/** "~3.4d", "~2.4h", "~40m". */
export function lockoutText(ms: number): string {
  if (ms >= 86_400_000) return `~${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `~${(ms / 3_600_000).toFixed(1)}h`;
  return `~${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** "5h", "7d", or undefined when the length is unknown. */
export function windowName(lengthMs: number | undefined): string | undefined {
  if (!lengthMs || !(lengthMs > 0)) return undefined;
  const h = lengthMs / 3_600_000;
  return h >= 24 && Number.isInteger(h / 24) ? `${h / 24}d` : `${Math.round(h * 10) / 10}h`;
}

/** Which usage meter backs a provider + model, or undefined for a CLI with no meter.
 *  agy's Claude and GPT models draw on its second pool, and Gemini 4 Argon on its own. */
export function engineFor(provider: AgentProvider, model?: string): EngineId | undefined {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'antigravity') {
    if (model === 'gemini-pro-orchestrator-g1-pro' || (model && /argon/i.test(model))) return 'agy-argon';
    return model && /claude|gpt/i.test(model) ? 'agy-claude' : 'agy';
  }
  return undefined;
}

export interface Candidate {
  /** The meter this candidate draws on; undefined reads as "no reading". */
  engine?: EngineId;
  /** How the reason names it, e.g. "codex/gpt-6.2-sol". */
  label: string;
  /** Explicit refusal; excluded even from all-full fallback. */
  blocked?: boolean;
  /** This entry's own cutoff (1-100) in place of the global fullPercent. */
  maxPercent?: number;
}

interface PickPolicy {
  /** Points a later candidate must undercut the current pick by to replace it. */
  margin: number;
  /** All full: take the least used, or the one whose room comes back first. */
  whenFull: 'least-used' | 'soonest-reset';
}

/** "codex/gpt-6.2-sol 68% of 7d, pace 242%", the ranking window first; a tighter
 *  shorter window follows as "5h 90%" since it is what can skip the engine. */
export function describeReading(c: Candidate, readings: EngineReadings): string {
  const r = c.engine ? readings[c.engine] : undefined;
  const u = r?.percent;
  if (u === undefined) return `${c.label} no reading`;
  const pct = (p: number, w?: string) => (w ? `${Math.round(p)}% of ${w}` : `${Math.round(p)}% used`);
  const tight = r?.window ? `${r.window} ${Math.round(u)}%` : `${Math.round(u)}% on a window of unknown length`;
  const real = r?.rankPercent !== undefined ? `${pct(r.rankPercent, r.rankWindow)}, ${tight}` : pct(u, r?.window);
  const resets = r?.resetInMs !== undefined && r.resetInMs < RESET_PRIORITY_MS ? `, resets in ${lockoutText(r.resetInMs)}` : '';
  const lock = (r?.lockoutMs === undefined ? '' : r.lockoutMs > 0 ? `, lockout ${lockoutText(r.lockoutMs)}` : ', no lockout') + resets;
  if (r?.pace === undefined) return `${c.label} ${real}${lock}`;
  if (!r.paceWindow) return `${c.label} ${real}, pace ${Math.round(r.pace)}% (raw, window length unknown)${lock}`;
  const on = r.paceWindow !== (r.rankWindow ?? r.window) ? ` on ${r.paceWindow}` : '';
  return `${c.label} ${real}, pace ${Math.round(r.pace)}%${on}${lock}`;
}

export function minutesUntil(ms: number, nowMs: number): string {
  const m = Math.max(0, Math.round((ms - nowMs) / 60_000));
  return m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`;
}

/** The shared walk behind chooseEngine and balanceEngines. Candidates are already
 *  installed and allowed; their order is the preference. */
function pickCandidate(
  cands: readonly Candidate[],
  readings: EngineReadings,
  policy: PickPolicy,
  nowMs: number,
  thresholds: EngineThresholds
): { index: number; reason: string; full?: boolean } | null {
  if (!cands.length) return null;
  const used = (i: number): number | undefined => {
    const e = cands[i].engine;
    return e ? readings[e]?.percent : undefined;
  };
  const pace = (i: number): number | undefined => {
    const e = cands[i].engine;
    return e ? readings[e]?.pace ?? readings[e]?.percent : undefined;
  };
  const lockout = (i: number): number | undefined => {
    const e = cands[i].engine;
    return e ? readings[e]?.lockoutMs : undefined;
  };
  const unusedRate = (i: number): number => { const e = cands[i].engine; return (e ? readings[e]?.unusedPerHour : undefined) ?? 0; };
  const resetsSoon = (i: number): boolean => {
    const e = cands[i].engine;
    const left = e ? readings[e]?.resetInMs : undefined;
    return left !== undefined && left < RESET_PRIORITY_MS;
  };
  const hasRoom = (i: number): boolean => {
    const u = used(i);
    const e = cands[i].engine;
    const cap = cands[i].maxPercent;
    if (cap !== undefined) return u === undefined || u < cap;
    return u === undefined || u < thresholds.fullPercent || (!!e && !!readings[e]?.spendBeforeReset && u < 100);
  };
  const skipped: string[] = [];
  let best = -1;
  let switched = '';
  let switchedFrom = -1;
  const skippedIdx: number[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].blocked || !hasRoom(i)) { skipped.push(describeReading(cands[i], readings)); skippedIdx.push(i); continue; }
    if (best < 0) { best = i; continue; }
    // An entry under its own cap stays preferred: the cap is how a ladder says "use this first until X".
    if (cands[best].maxPercent !== undefined) continue;
    if (resetsSoon(best) || resetsSoon(i)) {
      const rb = unusedRate(best);
      const ri = unusedRate(i);
      if (ri > rb) {
        switched = `; preferred ${describeReading(cands[best], readings)}: ${ri.toFixed(1)}%/h left unused at reset against ${rb.toFixed(1)}%/h`;
        switchedFrom = best;
        best = i;
      }
      continue;
    }
    const lb = lockout(best);
    const li = lockout(i);
    if (lb !== undefined && li !== undefined && Math.abs(lb - li) >= LOCKOUT_TIE_MS) {
      if (li < lb) {
        switched = `; preferred ${describeReading(cands[best], readings)}: ${lockoutText(lb - li)} longer lockout`;
        switchedFrom = best;
        best = i;
      }
      continue;
    }
    const ub = pace(best);
    const ui = pace(i);
    if (ub !== undefined && ui !== undefined && ub - ui >= policy.margin) {
      switched = `; preferred ${describeReading(cands[best], readings)} paces ${Math.round(ub - ui)} points higher${policy.margin !== HEADROOM_MARGIN && Number.isFinite(policy.margin) ? `; headroom margin ${policy.margin}%` : ''}`;
      switchedFrom = best;
      best = i;
    }
  }
  if (best >= 0) {
    const why = skipped.length ? `; skipped ${skipped.join(', ')}` : '';
    // Every candidate's reading is in the line, so a pick can be audited later.
    const rest = cands.map((_, i) => i).filter((i) => i !== best && i !== switchedFrom && !skippedIdx.includes(i));
    const also = rest.length ? `; also ${rest.map((i) => describeReading(cands[i], readings)).join(', ')}` : '';
    return { index: best, reason: `${describeReading(cands[best], readings)}${switched}${why}${also}` };
  }
  // A spent engine (100%, or forced there by applyExhaustion) would only refuse, so an
  // entry merely past the configured cutoff beats it; it is taken only when all are spent.
  const eligible = cands.map((_, i) => i).filter((i) => !cands[i].blocked);
  if (!eligible.length) return null;
  const live = eligible.filter((i) => (used(i) ?? 0) < 100);
  const order = live.length ? live : eligible;
  if (policy.whenFull === 'least-used') {
    order.sort((a, b) => (used(a) ?? 0) - (used(b) ?? 0));
    return { full: true, index: order[0], reason: `every listed engine is at ${thresholds.fullPercent}%+ (${skipped.join(', ')}); took the least used` };
  }
  const roomAt = (i: number): number => { const e = cands[i].engine; return (e ? readings[e]?.roomAtMs : undefined) ?? Infinity; };
  order.sort((a, b) => roomAt(a) - roomAt(b) || (used(a) ?? 0) - (used(b) ?? 0) || a - b);
  const first = order[0];
  const when = Number.isFinite(roomAt(first)) ? ` (room in ${minutesUntil(roomAt(first), nowMs)})` : '';
  return { full: true, index: first, reason: `every entry is at ${thresholds.fullPercent}%+ (${skipped.join(', ')}); took the one that resets soonest${when}` };
}

/** A persistent agent's pick on a fresh start, from its ordered model list.
 *  The rule, in order:
 *  1. An entry whose meter is at ENGINE_FULL_PERCENT or more is skipped (no reading = room),
 *     unless its ranking window is spendBeforeReset.
 *     A window resetting within RESET_SOON_MS already reads 0% (see readEngine).
 *  2. Among the rest, when either of two entries has a ranking window resetting within
 *     RESET_PRIORITY_MS, the one projected to leave more unused percent per hour left
 *     before its reset wins (use it or lose it; an entry at or over pace, or with no such
 *     window, counts 0), and the steps
 *     below are not consulted for that pair.
 *  3. Otherwise the earliest entry wins, unless a later one is projected to lock
 *     out (sit empty before its reset, see projectedLockoutMs) at least LOCKOUT_TIE_MS
 *     less, or, with lockouts within LOCKOUT_TIE_MS of each other, its pace (projected
 *     percent at reset, see projectedPercent) is at least HEADROOM_MARGIN points lower;
 *     then that one does. The walk repeats against the new pick, so both are always
 *     measured from the current winner. Two entries with no reading are never compared.
 *  4. When every entry is full, the one whose full windows reset soonest wins, among
 *     the entries not at 100% when there are any.
 *  Explicitly blocked entries are excluded, even from the all-full fallback. */
export function balanceEngines(
  cands: readonly Candidate[],
  readings: EngineReadings,
  nowMs: number,
  options: EngineOptions = {}
): { index: number; reason: string; full?: boolean } | null {
  const thresholds = getEngineThresholds({ engineThresholds: options.thresholds });
  return pickCandidate(cands, readings, { margin: thresholds.headroomMargin, whenFull: 'soonest-reset' }, nowMs, thresholds);
}

/** Where a live agent moves when its engine is spent: the balancer's pick among entries
 *  under ENGINE_FULL_PERCENT, else the least-used entry that is not spent. An entry at
 *  89% still has room for a session; the soonest-reset rule would send it back to the
 *  spent engine it is leaving. Returns a spent entry only when every entry is spent. */
export function limitSwitchPick(
  cands: readonly Candidate[],
  readings: EngineReadings,
  nowMs: number,
  options: EngineOptions = {}
): { index: number; reason: string; full?: boolean } | null {
  const thresholds = getEngineThresholds({ engineThresholds: options.thresholds });
  return pickCandidate(cands, readings, { margin: thresholds.headroomMargin, whenFull: 'least-used' }, nowMs, thresholds);
}

/** The tighter of two windows, as percent used. */
export function tighter(...percents: Array<number | undefined>): number | undefined {
  const vals = percents.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : undefined;
}
