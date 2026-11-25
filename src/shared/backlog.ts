/**
 * The Backlog: cards the human has shelved for later. A shelved card carries
 * `backloggedAt` (ISO time) and stays `blocked`, so nothing that wakes or nudges a
 * worker on todo/doing cards ever picks it up. It leaves ASK ME while shelved; an
 * open question on it comes back when the card does. Pure, so
 * test/backlog.test.cjs can pin it.
 */

export function isBacklogged(t: { backloggedAt?: unknown; status?: unknown }): boolean {
  return typeof t.backloggedAt === 'string' && t.backloggedAt.length > 0 && t.status !== 'done';
}

/** The patch that shelves a card. */
export function backlogPatch(now: string): { status: 'blocked'; backloggedAt: string } {
  return { status: 'blocked', backloggedAt: now };
}

/** The patch that brings a card back. It stays blocked until the Boss re-plans it. */
export function unbacklogPatch(): { backloggedAt: undefined } {
  return { backloggedAt: undefined };
}

export function backlogMailBody(title: string, id: string): string {
  return `The human moved card ${id} ("${title}") to the Backlog. Do not work it or assign it until the human brings it back. ` +
    'If a worker is on it now, have it commit its work in progress on a branch and note on the card where that work is.';
}

export function unbacklogMailBody(title: string, id: string): string {
  return `The human brought card ${id} ("${title}") back from the Backlog. It is still blocked: re-plan it (assignee, todo) as the board allows.`;
}

/** All tasks transitively waiting on `id` (dependents chain), cycle-safe. */
export function dependentsTree<T extends { id: string; dependsOn?: string[]; status?: string }>(
  id: string, all: T[], seen = new Set<string>()
): T[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const direct = all.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.includes(id) && t.status !== 'done');
  return direct.flatMap((d) => [d, ...dependentsTree(d.id, all, seen)]);
}
