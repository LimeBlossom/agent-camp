import { createHash } from 'node:crypto';
import type { UsageWindow } from './engineChoice';
import { DEFAULT_TIMINGS, liveTimings } from './timings';
import { latestNoteAwaitingMerge } from './mergeNote';

/** One usage window as a delivered standup saw it. `window` is the engine's first
 *  (5-hour) or second (weekly) window. */
export interface UsageSnap {
  engine: string;
  window: '5h' | 'weekly';
  percent: number;
  resetsAtMs?: number;
}

/** What the last delivered ops standup saw. `usage` and `exhausted` are absent on a
 *  mark saved before they existed. */
export interface StandupMark {
  at: number;
  tasks: string;
  /** Fingerprint of the problem list that standup delivered, order-independent. */
  problems?: string;
  usage?: UsageSnap[];
  /** Engines out of quota at the time: a limit hit or a meter at 100%. */
  exhausted?: string[];
}

/** A window above this much used at the last standup sends the next one once it refreshes. */
export const STANDUP_REFRESH_PERCENT = DEFAULT_TIMINGS.standupRefreshPercent;

const WINDOW_NAMES = ['5h', 'weekly'] as const;

/** Each engine's readable windows at `nowMs`. A window already past its reset is saved
 *  at 0%, so a meter not yet re-read does not report the same refresh every hour. */
export function usageSnapshot(windows: Readonly<Record<string, ReadonlyArray<UsageWindow | undefined>>>, nowMs: number): UsageSnap[] {
  const out: UsageSnap[] = [];
  for (const [engine, list] of Object.entries(windows)) {
    list.forEach((w, i) => {
      const name = WINDOW_NAMES[i];
      if (!name || !w || typeof w.percent !== 'number' || !Number.isFinite(w.percent)) return;
      const reset = w.resetsAtMs !== undefined && w.resetsAtMs <= nowMs;
      out.push({ engine, window: name, percent: reset ? 0 : w.percent, ...(w.resetsAtMs !== undefined ? { resetsAtMs: w.resetsAtMs } : {}) });
    });
  }
  return out;
}

/** Windows above `refreshPercent` at `mark` that have refreshed since, one line
 *  each ("codex 5h refreshed from 100%"). A window refreshed when its reset time has
 *  passed, when it now reads under the threshold with a later reset time, or when its
 *  engine was exhausted at the mark and no longer is. A window with no reading at the
 *  mark or now never counts. */
export function usageRefreshes(mark: StandupMark | null, now: UsageSnap[], exhaustedNow: ReadonlySet<string>, nowMs: number, refreshPercent = STANDUP_REFRESH_PERCENT): string[] {
  if (!mark?.usage) return [];
  const wasExhausted = new Set(mark.exhausted ?? []);
  const out: string[] = [];
  for (const prev of mark.usage) {
    if (!(prev.percent > refreshPercent)) continue;
    const cur = now.find((u) => u.engine === prev.engine && u.window === prev.window);
    if (!cur) continue;
    const resetPassed = prev.resetsAtMs !== undefined && prev.resetsAtMs <= nowMs;
    const newWindow = cur.percent < refreshPercent && cur.resetsAtMs !== undefined
      && prev.resetsAtMs !== undefined && cur.resetsAtMs > prev.resetsAtMs;
    const holdLifted = wasExhausted.has(prev.engine) && !exhaustedNow.has(prev.engine);
    if (resetPassed || newWindow || holdLifted) out.push(`${prev.engine} ${prev.window} refreshed from ${Math.round(prev.percent)}%`);
  }
  return out;
}

/** Log kinds that mean an agent came, went or hit a limit. */
const LIFECYCLE_KINDS = new Set(['spawn', 'dormant', 'card-close', 'model-close']);

/** Every card's id, status and answered ASK ME count, hashed. A card added, removed,
 *  moved, or a human answer landing on it changes the hash; notes and titles do not. */
export function standupTaskFingerprint(tasksRaw: unknown): string {
  const list = tasksRaw && typeof tasksRaw === 'object' && Array.isArray((tasksRaw as { tasks?: unknown }).tasks)
    ? (tasksRaw as { tasks: Array<Record<string, unknown>> }).tasks : [];
  const rows = list
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => {
      const answered = Array.isArray(t.humanQA) ? t.humanQA.filter((e) => e && typeof e === 'object' && (e as { a?: unknown }).a).length : 0;
      return `${t.id as string}\t${String(t.status ?? '')}\t${answered}`;
    })
    .sort();
  return createHash('sha1').update(rows.join('\n')).digest('hex');
}

function isBossMessage(
  e: { kind?: unknown; from?: unknown; to?: unknown; delivered?: unknown },
  godId: string,
  systemSenders: ReadonlySet<string>
): boolean {
  if (e.kind !== 'message' || typeof e.from !== 'string') return false;
  if (systemSenders.has(e.from) || e.from === godId) return false;
  return e.to === 'god' || e.to === 'boss' || e.to === 'broadcast' || e.to === godId
    || (Array.isArray(e.delivered) && e.delivered.includes(godId));
}

export function hasFreshBossMail(
  log: unknown[],
  markAt: number,
  godId: string,
  systemSenders: ReadonlySet<string>
): boolean {
  for (const raw of log) {
    const e = raw as { ts?: unknown; kind?: unknown; from?: unknown; to?: unknown; delivered?: unknown };
    if (typeof e.ts !== 'number' || e.ts <= markAt || typeof e.kind !== 'string') continue;
    if (isBossMessage(e, godId, systemSenders)) return true;
  }
  return false;
}

/** Why the floor changed since `mark`, or null when nothing did. `log` is the tail of
 *  log.jsonl, oldest first; when even its oldest entry is after the mark, the tail may
 *  have cut events off, so that counts as a change. `systemSenders` are the scheduler's
 *  own mail, which never counts. */
export function standupChange(
  mark: StandupMark | null,
  tasksFp: string,
  log: unknown[],
  godId: string,
  systemSenders: ReadonlySet<string>,
  tailLimit: number
): string | null {
  if (!mark) return 'no standup delivered yet';
  if (mark.tasks !== tasksFp) return 'task board';
  const first = log[0] as { ts?: unknown } | undefined;
  if (log.length >= tailLimit && typeof first?.ts === 'number' && first.ts > mark.at) return 'log tail';
  for (const raw of log) {
    const e = raw as { ts?: unknown; kind?: unknown; from?: unknown; to?: unknown; delivered?: unknown };
    if (typeof e.ts !== 'number' || e.ts <= mark.at || typeof e.kind !== 'string') continue;
    if (LIFECYCLE_KINDS.has(e.kind) || e.kind.startsWith('limit-')) return e.kind;
    if (isBossMessage(e, godId, systemSenders)) return `mail from ${e.from}`;
  }
  return null;
}

/** A working agent quiet this long with a doing card or unread mail counts as stalled. */
export const STANDUP_STALL_SEC = DEFAULT_TIMINGS.stallAfterMs / 1000;

interface FleetRow { id?: unknown; name?: unknown; isGod?: unknown; dormant?: unknown; onHold?: unknown; breaker?: unknown; lastActiveSecAgo?: unknown; inboxBacklog?: unknown; jailRefused?: unknown }

/** What a standup would need the Boss for, one line each; empty means a quiet floor.
 *  Counts: a tripped breaker, a doing card whose assignee is missing, dormant or quiet
 *  past `stallSec`, an open card with no assignee, unread mail on a quiet agent.
 *  Blocked cards are waiting on someone by declaration and never count. */
export function standupProblems(fleetRaw: unknown, tasksRaw: unknown, stallSec = STANDUP_STALL_SEC): string[] {
  const fleet: FleetRow[] = fleetRaw && typeof fleetRaw === 'object' && Array.isArray((fleetRaw as { agents?: unknown }).agents)
    ? (fleetRaw as { agents: FleetRow[] }).agents.filter((a) => a && typeof a.id === 'string') : [];
  const tasks = tasksRaw && typeof tasksRaw === 'object' && Array.isArray((tasksRaw as { tasks?: unknown }).tasks)
    ? (tasksRaw as { tasks: Array<Record<string, unknown>> }).tasks.filter((t) => t && typeof t.id === 'string') : [];
  const byId = new Map(fleet.map((a) => [a.id as string, a]));
  const quiet = (a: FleetRow): boolean => typeof a.lastActiveSecAgo === 'number' && a.lastActiveSecAgo > stallSec;
  const out: string[] = [];
  for (const a of fleet) {
    if (a.dormant || a.onHold) continue;
    if (a.isGod) {
      if (typeof a.inboxBacklog === 'number' && a.inboxBacklog > 0) {
        out.push(`${a.id as string}: ${a.inboxBacklog} unread`);
      }
      continue;
    }
    const refused = a.jailRefused as { error?: unknown } | null | undefined;
    if (refused && typeof refused.error === 'string') { out.push(`${a.id as string}: sandbox refused spawn: ${refused.error}`); continue; }
    if (typeof a.breaker === 'string' && a.breaker !== 'healthy') out.push(`${a.id as string}: breaker ${a.breaker}`);
    else if (typeof a.inboxBacklog === 'number' && a.inboxBacklog > 0 && quiet(a)) out.push(`${a.id as string}: ${a.inboxBacklog} unread, quiet ${Math.round((a.lastActiveSecAgo as number) / 60)} min`);
  }
  const stalledSeen = new Set<string>();
  for (const t of tasks) {
    if (t.backloggedAt) continue;
    if (t.status === 'blocked' && latestNoteAwaitingMerge(t.notes)) {
      if (latestHumanQAOpen(t)) continue;
      out.push(`${t.id as string}: awaiting boss merge`);
      continue;
    }
    if (t.status !== 'todo' && t.status !== 'doing') continue;
    const who = typeof t.assignee === 'string' && t.assignee ? t.assignee : '';
    if (!who) { out.push(`${t.id as string}: ${t.status as string} with no assignee`); continue; }
    const a = byId.get(who);
    if (!a) {
      out.push(`${t.id as string}: ${t.status as string}, assignee ${who} not on the floor`);
      continue;
    }
    if (a.isGod) continue;
    if (t.status === 'doing' && a.dormant) out.push(`${t.id as string}: doing, assignee ${who} dormant`);
    else if (!a.dormant && !a.onHold && quiet(a) && !stalledSeen.has(who)) {
      stalledSeen.add(who);
      out.push(`${t.id as string}: STALLED, ${t.status as string}, ${who} quiet ${Math.round((a.lastActiveSecAgo as number) / 60)} min (restart_agent)`);
    }
  }
  return out;
}

/** Agents with an open doing/todo card and no session activity for `stallSec`, mapped
 *  to that card's id (a doing card wins over a todo one). Dormant, held and Boss rows never count. */
export function stalledAgents(fleetRaw: unknown, tasksRaw: unknown, stallSec = STANDUP_STALL_SEC): Map<string, string> {
  const fleet = fleetRaw && typeof fleetRaw === 'object' && Array.isArray((fleetRaw as { agents?: unknown }).agents)
    ? (fleetRaw as { agents: FleetRow[] }).agents.filter((a) => a && typeof a.id === 'string') : [];
  const tasks = tasksRaw && typeof tasksRaw === 'object' && Array.isArray((tasksRaw as { tasks?: unknown }).tasks)
    ? (tasksRaw as { tasks: Array<Record<string, unknown>> }).tasks : [];
  const out = new Map<string, string>();
  for (const a of fleet) {
    if (a.isGod || a.dormant || a.onHold || typeof a.lastActiveSecAgo !== 'number' || a.lastActiveSecAgo <= stallSec) continue;
    const mine = tasks.filter((t) => t && typeof t.id === 'string' && t.assignee === a.id && !t.backloggedAt && (t.status === 'doing' || t.status === 'todo'));
    const card = mine.find((t) => t.status === 'doing') ?? mine[0];
    if (card) out.set(a.id as string, card.id as string);
  }
  return out;
}

/** True when the card's newest humanQA entry has no answer: it waits on the human, not on a merge. */
function latestHumanQAOpen(t: Record<string, unknown>): boolean {
  if (!Array.isArray(t.humanQA) || !t.humanQA.length) return false;
  const last = t.humanQA[t.humanQA.length - 1] as { a?: unknown } | null;
  return !(last && typeof last === 'object' && typeof last.a === 'string' && last.a.trim());
}

/** Order-independent fingerprint of a problem list; empty for no problems. */
export function problemsFingerprint(problems: readonly string[] | null): string {
  if (!problems || !problems.length) return '';
  return createHash('sha1').update([...problems].sort().join('\n')).digest('hex').slice(0, 16);
}

export interface OpsStandupDeps {
  mark(): StandupMark | null;
  saveMark(mark: StandupMark): void;
  tasks(): unknown;
  logTail(n: number): unknown[];
  godId: string;
  systemSenders: ReadonlySet<string>;
  /** `note` is extra text for the standup body, set when a usage window refreshed. */
  send(note?: string): void;
  appendLog(event: Record<string, unknown>): void;
  now(): number;
  /** Each engine's usage windows, as engineWindows() returns them. */
  usage?(): Record<string, ReadonlyArray<UsageWindow | undefined>>;
  /** Engines out of quota right now. */
  exhausted?(): string[];
  /** What the Boss is needed for (standupProblems plus any leftover list). With `ack`
   *  set, a changed floor with none of these is filed without waking the Boss. */
  problems?(): string[];
  /** File a quiet standup where the Boss can read it later, without waking it. */
  ack?(note: string): void;
}

/** Send the ops standup only when the floor moved since the last one delivered: a card
 *  added, removed, moved or answered, an agent spawned, slept or hit a limit, real mail
 *  reached the Boss, or a usage window above 90% refreshed. A refresh is logged as
 *  `standup-sent` with a `standup-reason` and told to the Boss in the body. An unchanged
 *  floor logs `standup-skipped` instead. A changed floor with no `problems` and no
 *  refresh is filed through `ack` and logged `standup-acked`. Returns whether it sent. */
export function runOpsStandup(d: OpsStandupDeps): boolean {
  let mark: StandupMark | null = null;
  try { mark = d.mark(); } catch { /* sends, as with no mark */ }
  const at = d.now();
  const timings = liveTimings();
  const tasksFp = standupTaskFingerprint(d.tasks());
  let usage: UsageSnap[] | undefined;
  let exhausted: string[] | undefined;
  try {
    usage = d.usage ? usageSnapshot(d.usage(), at) : undefined;
    exhausted = d.exhausted ? d.exhausted() : undefined;
  } catch { usage = undefined; exhausted = undefined; }
  const refreshed = usage ? usageRefreshes(mark, usage, new Set(exhausted ?? []), at, timings.standupRefreshPercent) : [];
  const logTail = d.logTail(timings.standupLogTail);
  const change = standupChange(mark, tasksFp, logTail, d.godId, d.systemSenders, timings.standupLogTail);
  let problems: string[] | null = null;
  try { problems = d.problems ? d.problems() : null; } catch { problems = null; }
  const hasProblems = !!(problems && problems.length > 0);
  const problemsFp = problemsFingerprint(problems);
  const sameProblems = !hasProblems || (!!mark && mark.problems === problemsFp);
  if (!change && !refreshed.length && sameProblems && mark) {
    d.appendLog({ kind: 'standup-skipped', since: mark.at });
    return false;
  }
  const reason = refreshed.join('; ');
  const freshBossMail = hasFreshBossMail(logTail, mark ? mark.at : 0, d.godId, d.systemSenders);
  const saveMark = (): void => {
    try {
      d.saveMark({ at, tasks: tasksFp, ...(problemsFp ? { problems: problemsFp } : {}), ...(usage ? { usage } : {}), ...(exhausted ? { exhausted } : {}) });
    } catch { /* the next standup sends */ }
  };
  if (d.ack && problems && !problems.length && !reason && !freshBossMail) {
    const why = change ?? 'first standup';
    try { d.ack(`Quiet standup (changed: ${why}): nothing stalled, no stuck card. Filed by the harness; no action needed.`); } catch { /* logged below */ }
    d.appendLog({ kind: 'standup-acked', 'standup-reason': why });
    saveMark();
    return false;
  }
  const notes = [
    reason ? `Capacity back: ${reason}. Agents locked on those limits can be re-engaged.` : '',
    problems && problems.length ? `Needs you:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''
  ].filter(Boolean);
  d.send(notes.length ? notes.join('\n\n') : undefined);
  if (reason) d.appendLog({ kind: 'standup-sent', 'standup-reason': reason });
  saveMark();
  return true;
}
