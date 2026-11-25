/**
 * An agent held because its provider's usage limit is spent and it has nowhere to
 * move (main/providerLimits.ts limitDecision). Main pushes the set of held agents to
 * the renderer; while an agent is in it, nothing automatic is typed into it and a
 * dormant one is not woken, since the provider would only refuse again. Pure, so
 * test/provider-limits.test.cjs pins the predicate both sides use.
 */

export interface LimitWait {
  /** The CLI whose limit is spent, e.g. "codex". */
  provider: string;
  /** When the provider takes work again; undefined when no reset time is known. */
  resetAtMs?: number;
}

export type LimitWaits = Record<string, LimitWait>;

/** Whether a queued message may be typed into `agentId` now. Only a message the
 *  human released with "send now" goes through a hold. */
export function deliveryHeldByLimit(waits: LimitWaits, agentId: string, manual: boolean | undefined): boolean {
  return !!waits[agentId] && !manual;
}

/** The single prompt a held agent gets once its provider has reset or restored capacity. */
export function limitResumeText(provider: string, reason?: string): string {
  if (reason === 'capacity-restored') {
    return `Your ${provider} capacity has been restored. Continue the work you were doing when it ran out: check your open card(s) and \`git status\` first, then carry on.`;
  }
  return `Your ${provider} usage limit has reset. Continue the work you were doing when it ran out: check your open card(s) and \`git status\` first, then carry on.`;
}

/**
 * Whether a limit-held agent can resume. Bypasses resetAtMs and resumeAtMs timers immediately
 * when capacity is positively confirmed restored (capacityRestored === true). An unknown or false
 * restoration state never resumes ahead of time, nor does a passed reset time alone count as restored.
 */
export function canResumeLimitWait(
  _wait: LimitWait,
  options?: { capacityRestored?: boolean; nowMs?: number; resumeAtMs?: number }
): boolean {
  return options?.capacityRestored === true;
}

/** How much of a worker's quiet stretch was spent on limit-hold, which the idle reaper must not count. */
export interface HoldClock { heldMs: number; sinceMs?: number; tickMs?: number }

/** Advance `clock` at a reaper tick. Output since the last tick (idle shorter than the gap) starts a new quiet stretch, so the held time is dropped. */
export function advanceHoldClock(clock: HoldClock, held: boolean, idleMs: number, nowMs: number): HoldClock {
  let heldMs = clock.heldMs;
  if (clock.sinceMs !== undefined) heldMs += nowMs - clock.sinceMs;
  if (clock.tickMs !== undefined && idleMs < nowMs - clock.tickMs) heldMs = 0;
  return held ? { heldMs, sinceMs: nowMs, tickMs: nowMs } : { heldMs, tickMs: nowMs };
}

/** Idle time the reaper should compare to its timeout: PTY idle minus time on limit-hold. */
export function idleOutsideHold(idleMs: number, clock: HoldClock): number {
  return Math.max(0, idleMs - clock.heldMs);
}
