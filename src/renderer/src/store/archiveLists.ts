/**
 * Moves an agent into `archivedAgents` from whichever list holds it: the live roster
 * or the dormant one. A dormant agent left on `restorableAgents` stays wakeable by
 * mail, so it must leave that list too. Structural like `agentPatch.ts`, testable
 * without zustand. A list that is left alone comes back as the same array.
 */
interface ArchivableAgent {
  id: string;
  archived?: boolean;
  ptyId?: string;
  status?: string;
  action?: string;
  carrying?: unknown;
  currentStation?: unknown;
}

interface ArchiveLists<T> { agents: T[]; restorableAgents: T[]; archivedAgents: T[] }

/** The three lists after archiving `id`, or null when neither live nor dormant list holds it. */
export function archiveFromLists<T extends ArchivableAgent>(state: ArchiveLists<T>, id: string): ArchiveLists<T> | null {
  const target = state.agents.find((a) => a.id === id) ?? state.restorableAgents.find((a) => a.id === id);
  if (!target) return null;
  const agents = state.agents.some((a) => a.id === id) ? state.agents.filter((a) => a.id !== id) : state.agents;
  const restorableAgents = state.restorableAgents.some((a) => a.id === id)
    ? state.restorableAgents.filter((a) => a.id !== id)
    : state.restorableAgents;
  const archivedEntry = {
    ...target,
    archived: true,
    ptyId: undefined,
    status: 'idle',
    action: 'archived',
    carrying: undefined,
    currentStation: undefined
  } as T;
  const archivedAgents = [...state.archivedAgents.filter((a) => a.id !== id), archivedEntry];
  return { agents, restorableAgents, archivedAgents };
}
