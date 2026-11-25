/**
 * Closing Time gives agents a bounded window to save their work before shutdown.
 *
 * Killing the PTYs mid-thought loses whatever the agents were holding in
 * working memory: uncommitted WIP, unrecorded decisions, half-updated
 * memory.md files. "Closing time" closes the floor the way a real office
 * does: the human announces it, every worker packs up and confirms, the
 * manager locks the door.
 *
 *   1. The human clicks "closing time" in the quit dialog.
 *   2. We mail the god agent a shutdown brief: broadcast closing time to the
 *      team; every worker commits/parks WIP, appends state + next steps to
 *      its memory.md, then replies with subject CLOSING-TIME-ACK.
 *   3. The god waits for every ACK (the harness shows live progress by
 *      watching the same inbox traffic), saves its own memory, and sends a
 *      message with subject CLOSING-TIME-COMPLETE.
 *   4. The router observer spots that message → the app tears down and quits.
 *
 * Everything rides the existing hive rails: inbox delivery, the idle
 * inbox-wake nudge, and Stop-hook draining already guarantee the messages
 * get acted on. This module only injects the kickoff mail and watches the
 * routed traffic — it never types into terminals.
 *
 * Runs in the Electron main process.
 */
import type { WebContents } from 'electron';
import type { HiveManager, HiveMessage } from './hive';
import type { ControlRegistry } from './control';
import type { WakeMode } from '../shared/hiveNudge';
import { liveTimings } from './timings';

export type ClosingTimePhase =
  | 'started' | 'progress' | 'complete' | 'timeout' | 'cancelled';

export interface ClosingTimeEvent {
  phase: ClosingTimePhase;
  /** Workers that have ACKed so far / total workers being waited on. */
  acked: number;
  total: number;
  /** Workers still owing an ACK, each with how long it has been silent and why. */
  missing?: MissingWorkerInfo[];
  /** Workers the harness stopped waiting on (frozen, dead, stalled, closed without). */
  excused?: MissingWorkerInfo[];
}

export interface MissingWorkerInfo {
  id: string;
  name: string;
  silentSecAgo?: number;
  reason?: string;
}

/** What the app knows about a worker's ability to answer the wrap-up brief. */
export interface WorkerStatus {
  canAnswer: boolean;
  provider?: string;
  reason?: string;
  silentSecAgo?: number;
  frozen?: boolean;
  dead?: boolean;
  stalled?: boolean;
}

export interface ClosingTimeDeps {
  /** Writes the worker's transcript snapshot / handoff before it is excused. */
  saveSnapshot?: (id: string) => Promise<void> | void;
}

function formatSilence(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.round(sec / 60);
  if (min < 120) return `${min} min`;
  return `${Math.round(min / 60)} hr`;
}

export function formatMissingWorker(info: MissingWorkerInfo): string {
  const parts: string[] = [];
  if (typeof info.silentSecAgo === 'number' && Number.isFinite(info.silentSecAgo)) parts.push(`silent ${formatSilence(info.silentSecAgo)}`);
  if (info.reason) parts.push(info.reason);
  return parts.length ? `${info.name} (${parts.join(', ')})` : info.name;
}

export function describeMissingWorkers(list: readonly MissingWorkerInfo[]): string {
  return list.map(formatMissingWorker).join(', ');
}

/** Known unable to answer for good, so the harness parks its cards instead of waiting. */
function parkable(s: WorkerStatus): boolean {
  return !s.canAnswer && !!(s.dead || s.frozen || s.stalled);
}

/** Subject markers. Deliberately forgiving (case, -/_/space) — agents write
 *  these by hand, so "Wrap Up Ack" must count as well as the canonical
 *  WRAP-UP-ACK the brief asks for. The old CLOSING-TIME names still count: agent
 *  memory.md files from before the 2026-10-21 rename use them. */
const ACK_RE = /(?:CLOSING[-_\s]*TIME|WRAP[-_\s]*UP)[-_\s]*ACK/i;
const COMPLETE_RE = /(?:CLOSING[-_\s]*TIME|WRAP[-_\s]*UP)[-_\s]*COMPLETE/i;

export const SHUTDOWN_ORDER_RE = /^\s*(?:CLOSING[-_\s]*TIME|WRAP[-_\s]*UP)\b/i;
export const SHUTDOWN_REPORT_RE = /(?:CLOSING[-_\s]*TIME|WRAP[-_\s]*UP)[-_\s]*(?:ACK|COMPLETE)|CANCEL(?:LED)?/i;

export function isShutdownOrder(msg: HiveMessage): boolean {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.act === 'inform') return false;
  if (msg.closingGeneration !== undefined && msg.closingGeneration !== null) return true;
  if (typeof msg.subject !== 'string') return false;
  if (SHUTDOWN_REPORT_RE.test(msg.subject)) return false;
  return SHUTDOWN_ORDER_RE.test(msg.subject);
}

export class ClosingTimeController {
  private active = false;
  private sessionStartedAt = 0;
  private generation = 0;
  private godId = 'god';
  private workers = new Set<string>();
  private acked = new Set<string>();
  /** Workers counted done without an ACK, with the reason shown in the dialog. */
  private excused = new Map<string, MissingWorkerInfo>();
  private concluded = false;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private teardownTimer: NodeJS.Timeout | null = null;

  constructor(
    private hive: HiveManager,
    /** Agent ids that have a LIVE PTY right now. The hive registry alone is
     *  not enough: agents that died with the app (hard quit, crash) keep
     *  their registry record without ever being flagged `archived`, so a
     *  registry-based roster waits on ghosts that can never ACK. */
    private getLiveAgentIds: () => string[],
    private getWebContents: () => WebContents | null,
    /** Called once the god concluded — runs the real teardown + app.quit(). */
    private onConcluded: () => void,
    /** Mid-run steering (#7C.2): lets closing time reach DEEPLY BUSY agents at
     *  their next hook boundary instead of waiting for the Stop-hook inbox
     *  drain — the graceful interrupt. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** `true` (legacy) marks an agent held at a spent usage limit; a WorkerStatus
     *  also says why it cannot answer. A worker with no live process is always dead. */
    private workerStatus?: (id: string) => boolean | WorkerStatus,
    private deps: ClosingTimeDeps = {}
  ) {
    try {
      (this.hive as any)?.setClosingSessionSource?.(() => ({
        active: this.active,
        startedAt: this.sessionStartedAt,
        generation: this.generation
      }));
    } catch { /* best-effort */ }
  }

  isActive(): boolean {
    return this.active;
  }

  getSessionStartedAt(): number {
    return this.sessionStartedAt;
  }

  getGeneration(): number {
    return this.generation;
  }

  /** True once this worker's CLOSING-TIME-ACK reached the Boss in the current run. */
  isAcked(id: string): boolean {
    return this.active && this.acked.has(id);
  }

  /** How an inbox wake may reach `id` right now. An ACKed worker is not woken: it
   *  has packed up, and any mail it would read is work the floor is closing on. */
  wakeMode(id: string): WakeMode {
    if (!this.active) return 'normal';
    return this.isAcked(id) ? 'skip' : 'closing';
  }

  private statusOf(id: string, live?: Set<string>): WorkerStatus {
    let raw: boolean | WorkerStatus | undefined;
    try { raw = this.workerStatus?.(id); } catch { raw = undefined; }
    const known = raw && typeof raw === 'object' ? raw : undefined;
    const agent = this.hive.registry().agents[id];
    if (agent?.archived) return { ...known, canAnswer: false, reason: 'archived' };
    if (!(live ?? new Set(this.getLiveAgentIds())).has(id)) {
      return { ...known, canAnswer: false, dead: true, reason: 'no live process' };
    }
    if (known?.canAnswer === false && known.dead) return known;
    if (!known?.provider && agent?.cwdValid === false) return { ...known, canAnswer: false, dead: true, reason: 'invalid working directory (cwd)' };
    const provider = known?.provider ?? agent?.provider;
    if (provider && provider !== 'claude') return { ...known, canAnswer: false, reason: `${provider} cannot use the wrap-up hooks` };
    if (raw === true) return { canAnswer: false, reason: 'out of usage quota' };
    return known ?? { canAnswer: true };
  }

  private nameOf(id: string): string {
    try { return this.hive.registry().agents[id]?.name ?? id; } catch { return id; }
  }

  /** Count a worker done without its ACK. Parkable workers get their cards parked
   *  blocked and a transcript snapshot saved; a quota-held one only loses its order. */
  private excuse(id: string, s: WorkerStatus, park: boolean): void {
    if (this.acked.has(id)) return;
    this.acked.add(id);
    this.excused.set(id, { id, name: this.nameOf(id), silentSecAgo: s.silentSecAgo, reason: s.reason });
    try { this.hive.appendLog({ kind: 'closing-time-auto-ack', agentId: id, reason: s.reason }); } catch { /* best-effort */ }
    try { (this.hive as any)?.expireAgentShutdownOrders?.(id, true); } catch { /* best-effort */ }
    if (!park) return;
    try { (this.hive as any)?.parkAgentCards?.(id, `wrap-up parked: ${s.reason ?? 'could not answer'}`); } catch { /* best-effort */ }
    try {
      const saving = this.deps.saveSnapshot?.(id);
      if (saving && typeof (saving as Promise<void>).catch === 'function') (saving as Promise<void>).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  /** Answerable workers that still owe an ACK. */
  private answerablePending(): string[] {
    const reg = this.hive.registry();
    const live = new Set(this.getLiveAgentIds());
    return [...this.workers].filter((id) => !this.acked.has(id) && !reg.agents[id]?.archived && this.statusOf(id, live).canAnswer);
  }

  /** Excuse every un-ACKed worker that cannot answer; true when any was newly excused. */
  private excuseUnanswerable(): boolean {
    const live = new Set(this.getLiveAgentIds());
    let any = false;
    for (const id of this.workers) {
      if (this.acked.has(id)) continue;
      const s = this.statusOf(id, live);
      if (s.canAnswer) continue;
      this.excuse(id, s, parkable(s));
      any = true;
    }
    return any;
  }

  /** The human's "close without <names>": park those workers and stop waiting on them. */
  closeWithout(agentIds: readonly string[]): void {
    if (!this.active || this.concluded) return;
    const live = new Set(this.getLiveAgentIds());
    let any = false;
    for (const id of agentIds) {
      if (!this.workers.has(id) || this.acked.has(id)) continue;
      const s = this.statusOf(id, live);
      this.excuse(id, { ...s, canAnswer: false, reason: s.canAnswer ? 'closed without by the human' : s.reason }, true);
      any = true;
    }
    if (this.answerablePending().length === 0) { this.conclude(); return; }
    if (any) this.emitState('progress');
  }

  /** Kick off the protocol. Returns an error string when the floor cannot run
   *  it (no live god agent) so the UI can fall back to the hard quit. */
  start(reason: 'quit' | 'restart' = 'quit'): { ok: boolean; error?: string } {
    if (this.active) {
      // Re-pressed while running (e.g. from the timeout view): keep waiting.
      this.emitState('progress');
      return { ok: true };
    }
    const reg = this.hive.registry();
    this.godId = reg.godId ?? 'god';
    const live = new Set(this.getLiveAgentIds());
    if (!reg.agents[this.godId] || !live.has(this.godId)) {
      return { ok: false, error: 'No orchestrator is running — wrap-up needs the Boss to collect the reports.' };
    }

    // Only agents with a live terminal are waited on — the registry is just
    // metadata here (names + god/assistant flags), never the roster source.
    this.workers = new Set(
      [...live].filter((id) => {
        const a = reg.agents[id];
        return id !== this.godId && !!a && !a.isGod && !a.archived && !a.isAssistant;
      })
    );
    // A non-live worker still holding an open card is waited on by nobody, but its
    // card is parked and counted, so the dialog says what was closed without it.
    try {
      const tasks = (this.hive.tasks?.() as { tasks?: Array<Record<string, unknown>> } | null)?.tasks ?? [];
      for (const t of tasks) {
        const id = t?.assignee;
        if (typeof id !== 'string' || live.has(id) || id === this.godId) continue;
        const a = reg.agents[id];
        if (!a || a.isGod || a.archived || a.isAssistant) continue;
        if (t.status === 'doing' || t.status === 'todo') this.workers.add(id);
      }
    } catch { /* best-effort */ }
    this.acked = new Set();
    this.excused = new Map();
    this.concluded = false;
    this.active = true;
    this.sessionStartedAt = Date.now();
    this.generation++;
    try {
      (this.hive as any)?.setClosingSessionInfo?.({
        active: true,
        startedAt: this.sessionStartedAt,
        generation: this.generation
      });
    } catch { /* best-effort */ }

    this.excuseUnanswerable();
    const names = [...this.workers]
      .map((id) => {
        const s = this.statusOf(id, live);
        const note = this.excused.has(id) ? ` [${s.reason ?? 'unavailable'}: cannot answer, do not wait for it]` : '';
        return `${reg.agents[id]?.name ?? id} (${id})${note}`;
      })
      .join(', ') || '(none — the floor is just you)';

    this.hive.send({
      to: 'god',
      act: 'request',
      subject: 'WRAP UP — run the shutdown protocol now',
      body: [
        `${reason === 'restart' ? 'The Boss requested a Camp restart' : 'The human pressed "wrap up"'}. Run this shutdown protocol now, before anything else:`,
        '',
        `1. BROADCAST wrap-up to the team (message with "to":"broadcast"). Current workers: ${names}.`,
        '   Tell each worker to immediately: park or commit any work-in-progress safely, append its current state + concrete next steps to its memory.md, and then reply to you with a message whose subject is exactly "WRAP-UP-ACK".',
        '2. WAIT for ACKs from workers who can answer. The harness records any missing ACKs at the deadline and closes.',
        '3. Save your own state: update board.md and append your shift summary to your memory.md.',
        `4. CONCLUDE by sending a message with "to":"human" and the subject exactly "WRAP-UP-COMPLETE" — the harness watches for it and closes the app. Do not send it before every worker has acked: the harness independently verifies the ACKs and will reject a premature conclusion.`,
        '',
        this.workers.size === 0
          ? 'There are no workers on the floor right now — do steps 3 and 4 immediately.'
          : 'The prep assistant saves its own memory separately — do NOT wait for it and do not message it.',
        'This is a shutdown: do not start new work and do not accept new tasks. Do not create or assign cards and do not move any card to todo or doing; the harness refuses those edits until wrap-up ends. Parking edits (notes, result, blocked, done) still work.'
      ].join('\n')
    }, 'human');

    // Graceful interrupt for the deeply busy (#7C.2): the inbox brief above
    // only lands when an agent next STOPS — a worker hours into a task would
    // hold the whole shutdown. A steer note rides the next hook boundary
    // (PostToolUse/UserPromptSubmit) instead, so every live agent learns about
    // closing time within one tool call. Idle agents are covered by the
    // inbox-wake nudge; busy ones by the steer — both rails, no PTY typing.
    // A halted agent's every hook answers continue:false, so it could never
    // read the brief or the steer, and the shutdown would wait on its ACK.
    this.control?.unhalt(this.godId);
    const reachable = [...this.workers].filter((id) => !this.excused.has(id));
    for (const id of reachable) this.control?.unhalt(id);
    this.control?.steer(this.godId,
      'WRAP UP was pressed by the human: pause your current work at the next sensible point and drain your inbox NOW — a shutdown brief is waiting there. Coordinate the floor shutdown before anything else.');
    for (const id of reachable) {
      this.control?.steer(id,
        'WRAP UP — the office is shutting down. Finish your current step but do NOT start new work. Park or commit your work-in-progress safely, append your current state + concrete next steps to your memory.md, then reply to the Boss ("to":"boss") with a message whose subject is exactly "WRAP-UP-ACK".');
    }

    this.armTimeout();
    this.emitState('started');
    return { ok: true };
  }

  /** Human changed their mind — stand the floor back up. */
  cancel(aborted = false): boolean {
    if (!this.active || (this.concluded && !aborted)) return false;
    this.cleanup();
    this.concluded = false;
    try {
      (this.hive as any)?.setClosingSessionInfo?.({
        active: false,
        startedAt: 0,
        generation: 0
      });
      (this.hive as any)?.sweepAllInboxesStaleWrapup?.();
    } catch { /* best-effort */ }
    // Drop closing-time steers that no hook boundary has consumed yet, so a
    // busy agent doesn't get told to shut down AFTER the human cancelled.
    // Revoke delivered orders through the same hook context channel: inbox
    // mail alone cannot supersede the shutdown instruction in a resumed session.
    this.control?.clearSteers(this.godId);
    for (const id of this.workers) this.control?.clearSteers(id);
    const cancellation = `WRAP-UP CANCELLED${aborted ? '' : ' by the human'}. This supersedes the earlier WRAP UP shutdown instruction: the shutdown hold is lifted. Resume normal operation and accept new work; do not send WRAP-UP-ACK or WRAP-UP-COMPLETE for the cancelled shutdown.`;
    this.control?.steer(this.godId, cancellation);
    for (const id of this.workers) this.control?.steer(id, cancellation);
    this.emitState('cancelled');
    let restored: string[] = [];
    try { restored = this.hive.unparkClosingTimeCards(); } catch { /* best-effort */ }
    try {
      this.hive.send({
        to: 'god',
        act: 'inform',
        subject: 'WRAP-UP CANCELLED',
        body: 'The shutdown was cancelled. Disregard the closing-time protocol and resume normal operation.'
          + (restored.length ? ` Cards parked as blocked are todo again: ${restored.join(', ')}.` : '')
      }, 'human');
    } catch { /* best-effort */ }
    return true;
  }

  /** Router observer — called by the hive for every routed message. */
  onRouted(msg: HiveMessage, targets: string[]): void {
    if (!this.active || this.concluded) return;
    // A worker reporting in. Counted only for known workers, and only when the
    // ACK actually reached the god (not e.g. a stray broadcast echo).
    if (ACK_RE.test(msg.subject) && this.workers.has(msg.from) && targets.includes(this.godId)) {
      if (!this.acked.has(msg.from)) {
        this.acked.add(msg.from);
        this.emitState('progress');
      }
      return;
    }
    // The god concluding. COMPLETE is only honored from the god itself — a
    // worker can't (accidentally or otherwise) shut down the whole floor.
    if (COMPLETE_RE.test(msg.subject) && msg.from === this.godId) {
      // Trust but VERIFY: a premature COMPLETE must not close the floor while an
      // answerable worker still holds unsaved state. Workers known dead, frozen,
      // stalled or quota-held can never ACK, so the Boss may close without them.
      const reg = this.hive.registry();
      const pending = this.answerablePending();
      if (pending.length > 0) {
        const names = pending.map((id) => `${reg.agents[id]?.name ?? id} (${id})`).join(', ');
        this.hive.send({
          to: 'god',
          act: 'refuse',
          subject: 'WRAP UP — conclusion rejected, workers still missing',
          body: [
            `The harness is still missing a WRAP-UP-ACK from: ${names}.`,
            'The app waits for those confirmations until the wrap-up deadline.',
            'Chase the stragglers (re-send the wrap-up instruction to each), wait for their ACKs, then send WRAP-UP-COMPLETE again.'
          ].join('\n')
        }, 'human');
        this.emitState('progress');
        return;
      }
      this.excuseUnanswerable();
      this.conclude();
    }
  }

  /** Close the floor. Stays "active" so the UI holds; the app owns the teardown grace. */
  private conclude(): void {
    if (this.concluded) return;
    this.cleanup();
    this.concluded = true;
    this.emitState('complete');
    try {
      (this.hive as any)?.setClosingSessionInfo?.({ active: false, startedAt: 0, generation: 0 });
      (this.hive as any)?.sweepAllInboxesStaleWrapup?.();
    } catch { /* best-effort */ }
    this.active = true;
    this.onConcluded();
  }

  private armTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      if (!this.active || this.concluded) return;
      if (this.excuseUnanswerable()) this.emitState('progress');
      const missing = this.answerablePending().map((id) => ({ id, name: this.nameOf(id) }));
      try { this.hive.appendLog({ kind: 'closing-time-timeout', missing }); } catch { /* best-effort */ }
      this.emitState('timeout');
      this.conclude();
    }, liveTimings().closingTimeoutMs);
  }

  private cleanup(): void {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.teardownTimer) { clearTimeout(this.teardownTimer); this.teardownTimer = null; }
    this.active = false;
  }

  private emitState(phase: ClosingTimePhase): void {
    const live = new Set(this.getLiveAgentIds());
    const missing = [...this.workers].filter((id) => !this.acked.has(id)).map((id): MissingWorkerInfo => {
      const s = this.statusOf(id, live);
      return { id, name: this.nameOf(id), silentSecAgo: s.silentSecAgo, reason: s.canAnswer ? (s.reason ? `${s.reason}, no WRAP-UP-ACK yet` : 'no WRAP-UP-ACK yet') : s.reason };
    });
    const ev: ClosingTimeEvent = {
      phase, acked: this.acked.size, total: this.workers.size, missing, excused: [...this.excused.values()]
    };
    try { this.getWebContents()?.send('app:closingTime', ev); } catch { /* window tore down */ }
  }
}
