/**
 * Where an agent edit lands: the live roster (`agents`) or the dormant one
 * (`restorableAgents`). Structural rather than typed against `Agent` so it is
 * testable without zustand, like `focusMode.ts`.
 */

/**
 * Applies `patch` to whichever list holds `id`. A live agent takes the whole patch.
 * A dormant agent takes only the fields outside `volatile` and stays on
 * `restorable`: that entry is the spawn recipe the next fresh start reads, and an
 * edit must never start the agent. A list that is left alone comes back as the
 * same array, so callers can tell which one to persist by identity.
 */
export function patchAgentById<T extends { id: string }>(
  agents: T[],
  restorable: T[],
  id: string,
  patch: Partial<T>,
  volatile: ReadonlySet<keyof T>
): { agents: T[]; restorable: T[] } {
  if (agents.some((a) => a.id === id)) {
    return { agents: agents.map((a) => a.id === id ? { ...a, ...patch } : a), restorable };
  }
  if (!restorable.some((a) => a.id === id)) return { agents, restorable };
  // A late pty chunk for an agent that just went dormant carries run-state only.
  const durable = Object.fromEntries(
    Object.entries(patch).filter(([k]) => !volatile.has(k as keyof T))
  ) as Partial<T>;
  if (Object.keys(durable).length === 0) return { agents, restorable };
  return { agents, restorable: restorable.map((a) => a.id === id ? { ...a, ...durable } : a) };
}

interface RunState {
  ptyId?: string;
  status?: string;
  action?: string;
  carrying?: unknown;
  lastPrompt?: string;
  currentStation?: string;
}

/**
 * Resets the run state of the agent whose CLI just exited on `ptyId`. A clean exit
 * sends no crash event, so without this the last hook label ("using <tool>") stays
 * on the floor for a dead tab. Returns the same array when no agent owns the pty.
 */
export function clearRunStateForExitedPty<T extends RunState>(agents: T[], ptyId: string): T[] {
  if (!agents.some((a) => a.ptyId === ptyId)) return agents;
  return agents.map((a) => a.ptyId === ptyId
    ? { ...a, status: 'idle', action: '', carrying: undefined, lastPrompt: undefined, currentStation: 'desk' }
    : a);
}
