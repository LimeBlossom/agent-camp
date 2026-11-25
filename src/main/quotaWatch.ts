/** Alert once per uninterrupted episode of pending work without model activity. */
export class NoProgressWatch {
  private agents = new Map<string, { since: number; activity: number; told: boolean }>();
  check(id: string, pending: boolean, activity: number, now: number, thresholdMs = 10 * 60_000): boolean {
    if (!pending) { this.agents.delete(id); return false; }
    let state = this.agents.get(id);
    if (!state || activity > state.activity) {
      state = { since: now, activity, told: false }; this.agents.set(id, state);
    }
    if (state.told || now - state.since < thresholdMs) return false;
    state.told = true; return true;
  }
}

/** What the no-progress alert says went missing: Codex with an unreadable rollout has an unknown signal, not none. */
export function noProgressReason(provider: string | undefined, hasUsage: boolean): string {
  return provider === 'codex' && !hasUsage ? 'activity unknown (codex): its rollout could not be read' : 'no model activity';
}
