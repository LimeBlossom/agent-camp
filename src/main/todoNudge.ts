/**
 * TodoNudger: what a live worker does next when its turn ends (Stop) with todo/doing
 * cards, and when a card lands on it while it sits idle.
 *
 * - Starting a new card closes the session (deps.close): main puts the worker to sleep
 *   and wakes it fresh at once, so the balancer picks the engine for that card and its
 *   start prompt names it. "New" means a todo card the session was not started for, or
 *   any todo card once a card the session was started for has left the open set
 *   (done, blocked, handed on). Never with a "doing" card (work in progress), never
 *   mid-turn, never when facts.canClose is false (keep running, spawn-request worker).
 *   A done report plus a durable handoff also closes the last card, parking the worker
 *   until its next assignment or mail wakes it fresh.
 * - mayStart() refuses a worker's own move of a card to "doing" when its session was
 *   not started for that card, so a worker cannot chain onto its next card in the turn
 *   that finished the last one; its Stop then closes it for that card. Rework on a card
 *   the session already worked is allowed, which keeps review fixes in context.
 * - Otherwise, with no unread mail (the inbox nudge covers that), it is told once to
 *   start its cards (deps.nudge); the same unchanged set at a later Stop means the
 *   nudge was ignored: report it once (deps.ignored), then stay quiet until it changes.
 *   This is what keeps a fresh session that has not touched its cards from looping.
 * - A Stop schedules the check a few seconds out, so the limit beat (which reads the
 *   turn that just ended) can hold the agent first. A turn hook, a permission prompt or
 *   terminal input cancels it and marks the agent busy until its next Stop.
 * - cardsChanged() re-checks idle agents for a close only, for a card assigned to a
 *   worker between turns.
 *
 * No electron import, so the rule is unit-testable.
 */

import { classifyHook } from './workerWake';
import { taskPatchHowTo } from './taskPatch';
import { isCompactionCommand } from '../shared/providerAutomation';
import { isBlockedByDeps } from '../shared/taskDeps';
import { priorityRank } from '../shared/taskPriority';

/** Hook events that mean a turn is running. Stop ends one; Notification is handled apart.
 *  PreInvocation/PostInvocation are agy's, once per model call and several times a turn,
 *  so neither ends a turn: agy 1.2 sends Stop when the turn ends, and none at exit
 *  (test/fixtures/agy-hook-turns.txt). */
export const TURN_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop', 'PreInvocation', 'PostInvocation']);

const PASTE_MARKERS = /\x1b\[20[01]~/g;
const ENTER_ONLY = /^\r+$/;

/** xterm's focus in/out reports: the human clicking the window, not input. */
export const FOCUS_REPORT = /^(?:\x1b\[[IO])+$/;
const TERMINAL_REPLY = /^(?:\x1b\]1[01];[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?997;[12]n|\x1b\[[0-9]+;[0-9]+R|\x1b\[[?>]?[0-9;]+c)+$/;

export function codexTurnBoundary(text: string): { idle: boolean; atMs: number } | null {
  let latest: { idle: boolean; atMs: number } | null = null;
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row.type !== 'event_msg' || !['task_started', 'task_complete', 'user_message'].includes(row.payload?.type)) continue;
      const atMs = Date.parse(row.timestamp);
      if (Number.isFinite(atMs)) latest = { idle: row.payload.type === 'task_complete', atMs };
    } catch { /* a bounded tail may begin with a partial line */ }
  }
  return latest;
}

export interface NudgeScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The subset of a tasks.json card the nudge reads. */
export interface NudgeCard {
  id?: string;
  title?: string;
  assignee?: string;
  status?: string;
  dependsOn?: string[];
  priority?: unknown;
  difficulty?: unknown;
  kind?: unknown;
  createdAt?: string;
  updatedAt?: string;
  notes?: unknown;
  humanQA?: unknown;
  description?: string;
  brief?: string;
}

export interface TodoNudgeFacts {
  /** Live worker: not the Boss or prep assistant, not on hold, limit-held, paused
   *  or archived, and not closing time. */
  eligible: boolean;
  /** Any unread inbox file. A close goes ahead regardless: the fresh start lists it. */
  hasMail: boolean;
  /** openCards(agentId, ledger). */
  cards: NudgeCard[];
  /** May be closed and woken fresh: not keep-running, not a spawn-request worker. */
  canClose?: boolean;
  /** Assigned blocked/done cards, including their durable handoff. */
  finishedCards?: NudgeCard[];
  /** memory.md was saved during this live session. */
  memoryUpdated?: boolean;
  /** True when outbox messages, patches or work activity was observed main-side. */
  hasWork?: boolean;
  /** Timestamp (ms) of the latest work observed main-side. */
  lastWorkAt?: number;
}

/** What todoNudgeEligible reads about one agent, gathered by main. */
export interface TodoNudgeAgentState {
  hiveEnabled: boolean;
  closingTime: boolean;
  hasPty: boolean;
  registered: boolean;
  archived?: boolean;
  isBoss: boolean;
  isAssistant?: boolean;
  onHold?: boolean;
  limitHeld: boolean;
  paused?: boolean;
  halted?: boolean;
  autoDeliveryPaused?: boolean;
}

export function todoNudgeEligible(s: TodoNudgeAgentState): boolean {
  return s.hiveEnabled && !s.closingTime && s.hasPty && s.registered && !s.archived && !s.isBoss
    && !s.isAssistant && !s.onHold && !s.limitHeld && !s.paused && !s.halted && !s.autoDeliveryPaused;
}

/** Closing time puts this worker to sleep instead of briefing it: idle, closeable, and
 *  nothing open (no card, unread mail or unsent outbox) that it would need a turn for. */
export function closingTimeParkable(f: TodoNudgeFacts, idle: boolean): boolean {
  return idle && f.eligible && !!f.canClose && !f.hasMail && !f.hasWork && f.cards.length === 0;
}

export interface TodoNudgeDeps {
  facts: (agentId: string) => TodoNudgeFacts;
  /** Deliver the nudge; false when it could not be queued, so the next Stop tries again. */
  nudge: (agentId: string, cards: NudgeCard[]) => boolean;
  ignored: (agentId: string, cards: NudgeCard[]) => void;
  /** Close the session at a card boundary; false when it could not be
   *  proposed, so the nudge is sent instead. Unset = never close. */
  close?: (agentId: string, cards: NudgeCard[]) => boolean;
  delayMs?: number;
  retryMs?: number;
  refused?: (agentId: string, reason: string) => void;
  scheduler?: NudgeScheduler;
}

/** Cards without a createdAt (the older ledger entries) sort as oldest. */
const created = (c: NudgeCard): number => {
  const t = Date.parse(String(c.createdAt ?? ''));
  return Number.isFinite(t) ? t : -Infinity;
};

/** doing (resume it), then startable todo, then todo waiting on an undone dependsOn, then blocked. */
const group = (c: NudgeCard, ledger: readonly NudgeCard[]): number =>
  c.status === 'doing' ? 0 : c.status === 'blocked' ? 3 : isBlockedByDeps(c, ledger) ? 2 : 1;

/** Open cards in work order: group, then priority, then oldest, then ledger position.
 *  The nudge, the start message and my-tasks.md all list cards through this. */
export function sortOpenCards<T extends NudgeCard>(cards: readonly T[], ledger: readonly NudgeCard[]): T[] {
  const at = new Map(ledger.map((c, i) => [c, i]));
  const pos = (c: NudgeCard): number => at.get(c) ?? ledger.length;
  return [...cards].sort((a, b) => group(a, ledger) - group(b, ledger)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || created(a) - created(b)
    || pos(a) - pos(b));
}

/** The agent's startable todo/doing cards, in work order. */
export function openCards(agentId: string, tasks: readonly NudgeCard[]): NudgeCard[] {
  return sortOpenCards(tasks.filter((c) => c.assignee === agentId && (c.status === 'todo' || c.status === 'doing') && !isBlockedByDeps(c, tasks)), tasks);
}

/** Identity of a card set for the loop guard. Cards carry no reliable updatedAt, so a
 *  status change, a notes edit or a new humanQA entry is what counts as a change. */
export function cardSetKey(cards: readonly NudgeCard[]): string {
  return cards
    .map((c) => {
      const notes = typeof c.notes === 'string' ? c.notes.length : c.notes === undefined ? 0 : JSON.stringify(c.notes).length;
      const asks = Array.isArray(c.humanQA) ? c.humanQA.length : 0;
      return `${c.id}:${c.status}:${notes}:${asks}:${c.updatedAt ?? ''}`;
    })
    .sort()
    .join('|');
}

const MAX_LISTED = 12;
const clip = (s: string | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What the worker is told. outboxDir is the agent's absolute, native outbox path. */
export function todoNudgeText(cards: readonly NudgeCard[], outboxDir: string): string {
  const list = cards.slice(0, MAX_LISTED).map((c) => `- \`${c.id}\` (${c.status}): ${clip(c.title, 120)}`);
  if (cards.length > MAX_LISTED) list.push(`- and ${cards.length - MAX_LISTED} more in your my-tasks.md.`);
  return [
    'NEXT CARD: your turn ended, and these cards are still assigned to you (in order):',
    ...list,
    'Start the first one now (continue it if it is "doing"); set a card to "doing" when you start it.',
    'If a card is actually blocked (waiting on the human, another agent, an asset or a machine), do not wait on it: set its status to "blocked" with a one-line reason, and if it needs the human, message boss with the decision in one or two sentences so it goes on the ASK ME board. Then end your turn: each card starts in its own fresh session, and the harness restarts you on the next one.',
    'If a card is finished and waits on the Boss\'s review or merge, set it "blocked" with notesAppend "awaiting boss merge" after sending the Boss your done message; only the Boss sets "done".',
    taskPatchHowTo(outboxDir),
    `Blocking one looks like: {"to":"harness","act":"task-patch","body":{"id":"<id>","status":"blocked","notesAppend":"BLOCKED: <reason>"}}`
  ].join('\n');
}

/** The text sent to the boss when an agent is reported for not starting cards.
 *  States each card's real status instead of hardcoding 'todo'. */
export function ignoredTodoNudgeBody(name: string, agentId: string, cards: readonly NudgeCard[]): string {
  const list = cards.map((c) => `${c.id} (${c.status ?? 'todo'})`).join(', ');
  return `${name} (${agentId}) has cards ${list} but is not starting them. It was nudged once and ended its next turn with the same cards unchanged. Check whether they are blocked or need reassigning.`;
}

export const TODO_NUDGE_DELAY_MS = 4000;

const realScheduler: NudgeScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

export class TodoNudger {
  private pending = new Map<string, unknown>();
  /** The card set each agent was last nudged for. */
  private nudgedKey = new Map<string, string>();
  /** Agents already reported to the Boss for their current nudgedKey. */
  private reported = new Set<string>();
  /** Activity sequence number when the nudge was sent. */
  private nudgedSeq = new Map<string, number>();
  /** Timestamp (ms) when the nudge was sent. */
  private nudgedAt = new Map<string, number>();
  /** Timestamp (ms) of the last work observed when the nudge was sent. */
  private nudgedWorkAt = new Map<string, number>();
  /** The open card ids each agent's session was started for. */
  private startedFor = new Map<string, Set<string>>();
  /** A card the session was started for has left the open set. */
  private moved = new Set<string>();
  private doneReported = new Set<string>();
  /** Cards this session has worked: doing at its start, or patched by it since. */
  private worked = new Map<string, Set<string>>();
  /** Agents whose last turn ended (Stop) with nothing running since. */
  private idle = new Set<string>();
  /** Compactions begun while idle: restore idle at their end, since no Stop follows. */
  private compacting = new Set<string>();
  /** Idle agents a close was proposed for; any activity withdraws it. */
  private closing = new Set<string>();
  private closeFailures = new Map<string, { key: string; count: number }>();
  private activityAt = new Map<string, number>();
  private activitySeq = new Map<string, number>();
  private sessionBoundaryAt = new Map<string, number>();
  private readonly scheduler: NudgeScheduler;
  private readonly delayMs: number;

  constructor(private readonly deps: TodoNudgeDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    this.delayMs = deps.delayMs ?? TODO_NUDGE_DELAY_MS;
  }

  noteHook(agentId: string | undefined, event: string | undefined, message?: string, source?: string): void {
    if (!agentId || !event) return;
    if (event === 'Stop') this.onStop(agentId);
    else if (event === 'PreCompact') this.startCompaction(agentId);
    else if (event === 'PostCompact' || (event === 'SessionStart' && source === 'compact')) this.endCompaction(agentId);
    // The queued /compact submits a prompt without starting a work turn.
    else if (event === 'UserPromptSubmit' && this.compacting.has(agentId)) return;
    else if (TURN_EVENTS.has(event)) this.busy(agentId);
    else if (event === 'Notification' && classifyHook(event, message) === 'needsHuman') this.busy(agentId);
  }

  /** Bytes written to the agent's terminal from the UI. */
  noteInput(agentId: string | undefined, data = ''): void {
    if (!agentId || FOCUS_REPORT.test(data) || TERMINAL_REPLY.test(data)) return;
    // The queue types the command and Enter separately, and may retry Enter.
    if (this.compacting.has(agentId) && ENTER_ONLY.test(data)) return;
    if (this.idle.has(agentId) && isCompactionCommand(data.replace(PASTE_MARKERS, ''))) {
      this.startCompaction(agentId);
      return;
    }
    this.busy(agentId);
  }

  /** Drop a scheduled check; the loop-guard memory stays. */
  cancel(agentId: string): void {
    const h = this.pending.get(agentId);
    if (h !== undefined) this.scheduler.clear(h);
    this.pending.delete(agentId);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  /** An ended session: nothing about it carries over. */
  forget(agentId: string): void {
    this.cancel(agentId);
    this.nudgedKey.delete(agentId);
    this.reported.delete(agentId);
    this.nudgedSeq.delete(agentId);
    this.nudgedAt.delete(agentId);
    this.nudgedWorkAt.delete(agentId);
    this.startedFor.delete(agentId);
    this.closeFailures.delete(agentId);
    this.activityAt.delete(agentId);
    this.activitySeq.delete(agentId);
    this.sessionBoundaryAt.delete(agentId);
    this.moved.delete(agentId);
    this.doneReported.delete(agentId);
    this.worked.delete(agentId);
    this.idle.delete(agentId);
    this.closing.delete(agentId);
    this.compacting.delete(agentId);
  }

  /** A session starts, handed these open cards; `doing` ones are already in progress. */
  begin(agentId: string, cardIds: readonly string[], doing: readonly string[] = []): void {
    this.forget(agentId);
    this.startedFor.set(agentId, new Set(cardIds));
    this.worked.set(agentId, new Set(doing));
  }

  /** May this worker's session work on `cardId`, given its open cards before the edit?
   *  An untracked session (none begun) may. Each allowed card counts as worked, so it
   *  stays allowed after it leaves the open set and comes back for rework. */
  mayWork(agentId: string, cardId: string, open: readonly NudgeCard[]): boolean {
    const started = this.startedFor.get(agentId);
    const worked = this.worked.get(agentId);
    if (!started || !worked || worked.has(cardId)) return true;
    const openIds = new Set(open.map((c) => String(c.id)));
    if ([...started].some((id) => !openIds.has(id))) this.moved.add(agentId);
    if (!started.has(cardId) || this.moved.has(agentId)) return false;
    worked.add(cardId);
    return true;
  }

  isIdle(agentId: string): boolean {
    return this.idle.has(agentId);
  }

  /** Accept each session boundary once; old completion cannot erase newer input. */
  noteSession(agentId: string, text: string): void {
    const boundary = codexTurnBoundary(text);
    if (!boundary || boundary.atMs <= (this.sessionBoundaryAt.get(agentId) ?? 0)) return;
    this.sessionBoundaryAt.set(agentId, boundary.atMs);
    if (boundary.atMs < (this.activityAt.get(agentId) ?? 0)) return;
    if (boundary.idle) {
      if (!this.idle.has(agentId)) this.onStop(agentId);
    } else this.busy(agentId, boundary.atMs);
  }

  closeRefused(agentId: string, reason: string): boolean {
    if (!this.closing.delete(agentId)) return false;
    this.cancel(agentId);
    this.deps.refused?.(agentId, reason);
    const f = this.deps.facts(agentId);
    const key = cardSetKey(f.cards);
    const old = this.closeFailures.get(agentId);
    const count = (old?.key === key ? old.count : 0) + 1;
    this.closeFailures.set(agentId, { key, count });
    if (!this.idle.has(agentId)) return true;
    if (count >= 2) { this.check(agentId, false); return true; }
    this.pending.set(agentId, this.scheduler.set(() => {
      this.pending.delete(agentId);
      if (this.idle.has(agentId)) this.check(agentId, false);
    }, this.deps.retryMs ?? 60_000));
    return true;
  }

  /** tasks.json changed: an idle agent handed a new card closes for it now. */
  cardsChanged(): void {
    for (const id of this.idle) if (!this.pending.has(id) && !this.closing.has(id)) this.check(id, true);
  }

  /** Mail is about to be typed into this agent. An idle agent that should close for a
   *  new card closes first, so the card gets a fresh session and engine pick; typing the
   *  mail would start a turn on the old session and withdraw the close. True = hold it. */
  holdMail(agentId: string): boolean {
    if (this.closing.has(agentId)) return true;
    if (!this.idle.has(agentId)) return false;
    if (this.pending.has(agentId)) {
      if (!this.shouldClose(agentId)) return false;
      this.cancel(agentId);
    }
    this.check(agentId, true);
    return this.closing.has(agentId);
  }

  /** The proposed close still stands: the agent has done nothing since. */
  closeStands(agentId: string): boolean {
    return this.closing.has(agentId) && this.idle.has(agentId);
  }

  isPending(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  /** A routed done report may arrive after Stop; it must not invent a new turn. */
  noteDone(agentId: string): void {
    this.doneReported.add(agentId);
    if (this.idle.has(agentId) && !this.pending.has(agentId) && !this.closing.has(agentId)) {
      this.pending.set(agentId, this.scheduler.set(() => {
        this.pending.delete(agentId);
        if (this.idle.has(agentId)) this.check(agentId, true);
      }, this.delayMs));
    }
  }

  /** Re-read the handoff at proposal and acceptance; active work always wins. */
  finished(agentId: string, f = this.deps.facts(agentId)): boolean {
    if (!f.eligible || f.cards.some((c) => c.status === 'doing')
      || !this.doneReported.has(agentId) || !f.memoryUpdated) return false;
    const worked = this.worked.get(agentId);
    return !!f.finishedCards?.some((c) => worked?.has(String(c.id))
      && typeof c.brief === 'string' && !!c.brief.trim()
      && (c.status === 'done' || (c.status === 'blocked' && /awaiting boss merge/i.test(String(c.notes ?? '')))));
  }

  shouldClose(agentId: string, f = this.deps.facts(agentId)): boolean {
    return this.startingNew(agentId, f) || this.finished(agentId, f);
  }

  /** Note work activity by the agent (outbox message, task-patch, commit, etc.). */
  noteWork(agentId: string, atMs = Date.now()): void {
    this.busy(agentId, atMs);
  }

  private busy(agentId: string, atMs = Date.now()): void {
    this.activityAt.set(agentId, atMs);
    this.activitySeq.set(agentId, (this.activitySeq.get(agentId) ?? 0) + 1);
    this.idle.delete(agentId);
    this.compacting.delete(agentId);
    if (this.closing.has(agentId)) this.closeRefused(agentId, 'agent-activity');
    this.cancel(agentId);
    this.closing.delete(agentId);
  }

  private startCompaction(agentId: string): void {
    if (!this.idle.has(agentId)) return;
    if (this.closing.has(agentId)) this.closeRefused(agentId, 'agent-activity');
    this.cancel(agentId);
    this.idle.delete(agentId);
    this.closing.delete(agentId);
    this.compacting.add(agentId);
  }

  private endCompaction(agentId: string): void {
    if (!this.compacting.delete(agentId)) return;
    this.idle.add(agentId);
    this.check(agentId, true);
  }

  private onStop(agentId: string): void {
    this.compacting.delete(agentId);
    this.cancel(agentId);
    this.idle.add(agentId);
    this.closing.delete(agentId);
    this.pending.set(agentId, this.scheduler.set(() => { this.pending.delete(agentId); this.check(agentId, false); }, this.delayMs));
  }

  /** The agent's next card needs a fresh session: a todo card, or a doing card someone
   *  else started, that the session was not started for, or any such card once one it
   *  was started for left the open set. Never while a card it worked is in progress. */
  startingNew(agentId: string, f = this.deps.facts(agentId)): boolean {
    if (!f.eligible) return false;
    const startedFor = this.startedFor.get(agentId) ?? new Set<string>();
    this.startedFor.set(agentId, startedFor);
    const worked = this.worked.get(agentId);
    const open = new Set(f.cards.map((c) => String(c.id)));
    if ([...startedFor].some((id) => !open.has(id))) this.moved.add(agentId);
    // A session never begun (no worked set) treats every doing card as its own.
    const ownDoing = (c: NudgeCard): boolean => c.status === 'doing'
      && (!worked || worked.has(String(c.id)) || (!this.moved.has(agentId) && startedFor.has(String(c.id))));
    const next = f.cards.filter((c) => c.status === 'todo' || (c.status === 'doing' && !ownDoing(c)));
    return next.length > 0 && !f.cards.some(ownDoing)
      && (this.moved.has(agentId) || next.some((c) => !startedFor.has(String(c.id))));
  }

  private check(agentId: string, closeOnly: boolean): void {
    const f = this.deps.facts(agentId);
    if (!f.eligible) return;
    const closeDue = this.shouldClose(agentId, f);
    const failures = this.closeFailures.get(agentId);
    const exhausted = failures?.key === cardSetKey(f.cards) && failures.count >= 2;
    if (closeDue && !exhausted && f.canClose && this.deps.close && this.deps.close(agentId, f.cards)) {
      this.closing.add(agentId);
      this.pending.set(agentId, this.scheduler.set(() => {
        this.pending.delete(agentId);
        this.closeRefused(agentId, 'renderer-timeout');
      }, this.deps.retryMs ?? 60_000));
      return;
    }
    if ((closeOnly && !closeDue) || f.hasMail) return;
    if (!f.cards.length) {
      this.nudgedKey.delete(agentId);
      this.reported.delete(agentId);
      this.nudgedSeq.delete(agentId);
      this.nudgedAt.delete(agentId);
      this.nudgedWorkAt.delete(agentId);
      return;
    }
    const key = cardSetKey(f.cards);
    if (this.nudgedKey.get(agentId) !== key) {
      if (!this.deps.nudge(agentId, f.cards)) {
        this.pending.set(agentId, this.scheduler.set(() => {
          this.pending.delete(agentId);
          if (this.idle.has(agentId)) this.check(agentId, false);
        }, this.deps.retryMs ?? 60_000));
        return;
      }
      this.nudgedKey.set(agentId, key);
      this.reported.delete(agentId);
      this.nudgedSeq.set(agentId, this.activitySeq.get(agentId) ?? 0);
      this.nudgedAt.set(agentId, Date.now());
      if (typeof f.lastWorkAt === 'number') this.nudgedWorkAt.set(agentId, f.lastWorkAt);
      return;
    }
    if (closeOnly || this.reported.has(agentId)) return;
    const hasTodo = f.cards.some((c) => c.status === 'todo');
    const hasDoing = f.cards.some((c) => c.status === 'doing');
    if (!hasTodo || hasDoing) return;

    const currentSeq = this.activitySeq.get(agentId) ?? 0;
    const nudgedSeq = this.nudgedSeq.get(agentId) ?? 0;
    const currentActAt = this.activityAt.get(agentId) ?? 0;
    const nudgedAt = this.nudgedAt.get(agentId) ?? 0;
    const prevWorkAt = this.nudgedWorkAt.get(agentId) ?? 0;
    const showedWork = currentSeq > nudgedSeq
      || currentActAt > nudgedAt
      || !!f.hasWork
      || (typeof f.lastWorkAt === 'number' && f.lastWorkAt > Math.max(nudgedAt, prevWorkAt));
    if (showedWork) {
      this.nudgedSeq.set(agentId, currentSeq);
      this.nudgedAt.set(agentId, Date.now());
      if (typeof f.lastWorkAt === 'number') this.nudgedWorkAt.set(agentId, f.lastWorkAt);
      return;
    }

    this.reported.add(agentId);
    this.deps.ignored(agentId, f.cards);
  }
}
