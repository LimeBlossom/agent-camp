import { DEFAULT_TIMINGS, liveTimings } from './timings';

/** A crashed worker is put back to sleep so its next card or mail starts it again. These
 *  bound how often: each crash waits longer before the automatic restart, and a worker
 *  that keeps crashing stays asleep until the Boss files a wake request for it. */
export const CRASH_WINDOW_MS = DEFAULT_TIMINGS.crashWindowMs;
export const CRASH_MAX_IN_WINDOW = DEFAULT_TIMINGS.crashMaxInWindow;
export const CRASH_BACKOFF_BASE_MS = DEFAULT_TIMINGS.crashBackoffBaseMs;

export type CrashPlan = {
  /** False once the worker has crashed CRASH_MAX_IN_WINDOW times inside the window. */
  revive: boolean;
  crashesInWindow: number;
  /** How long automatic wakes are held off (Infinity when not reviving). */
  backoffMs: number;
};

export class CrashTracker {
  private readonly crashes = new Map<string, number[]>();
  private readonly holdUntil = new Map<string, number>();

  record(agentId: string, now = Date.now()): CrashPlan {
    const timings = liveTimings();
    const recent = (this.crashes.get(agentId) ?? []).filter((t) => now - t < timings.crashWindowMs);
    recent.push(now);
    this.crashes.set(agentId, recent);
    const n = recent.length;
    const revive = n < timings.crashMaxInWindow;
    const backoffMs = revive ? timings.crashBackoffBaseMs * 2 ** (n - 1) : Infinity;
    this.holdUntil.set(agentId, now + backoffMs);
    return { revive, crashesInWindow: n, backoffMs };
  }

  /** True while automatic wakes of this worker must wait. */
  held(agentId: string, now = Date.now()): boolean {
    const until = this.holdUntil.get(agentId);
    return until !== undefined && now < until;
  }

  /** An explicit wake request overrides the cap and the backoff. */
  clear(agentId: string): void {
    this.crashes.delete(agentId);
    this.holdUntil.delete(agentId);
  }
}

/** The boss notice for one crash. */
export function crashNotice(name: string, agentId: string, exitCode: number | null | undefined, signal: number | null | undefined, plan: CrashPlan): { subject: string; body: string } {
  const how = signal ? `signal ${signal}` : `exit code ${exitCode ?? 'unknown'}`;
  const windowMin = liveTimings().crashWindowMs / 60_000;
  const subject = `Agent ${name} crashed (${how})`;
  const body = plan.revive
    ? `${name} (${agentId}) exited abnormally (${how}); crash ${plan.crashesInWindow} in ${windowMin} min. `
      + `It is asleep now and restarts on its next todo/doing card or direct mail after ${Math.round(plan.backoffMs / 1000)} s.`
    : `${name} (${agentId}) exited abnormally (${how}), its ${plan.crashesInWindow}th crash in ${windowMin} min, `
      + `so it will NOT restart on its own. Check crashes/ in the hive root; write wake-requests/${agentId}.json to start it again.`;
  return { subject, body };
}
