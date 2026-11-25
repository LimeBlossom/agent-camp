/**
 * Boss-only retirement (archive) of an agent: kept on disk and in the registry, flagged
 * archived, off the floor. Validated twice with the same function, where the Boss queues
 * it (camp MCP tool) and where the harness receives it (hive outbox router), so a raw
 * outbox file cannot skip the checks. Pure.
 */

/** The harness act a queued archive carries. */
export const ARCHIVE_AGENT_ACT = 'archive-agent';

/** Ids that are one path segment; anything else cannot name an agent folder. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface ArchiveRequest {
  agentId: string;
  reason?: string;
}

export type ArchiveCheck = { ok: true; request: ArchiveRequest } | { ok: false; error: string };

export interface ArchiveRoster {
  godId: string | null;
  known(id: string): boolean;
  isGod(id: string): boolean;
  isArchived(id: string): boolean;
  /** Ids of the agent's todo and doing cards. */
  openCards(id: string): string[];
}

interface CardLike { id?: unknown; assignee?: unknown; status?: unknown }

/** Ids of the todo and doing cards assigned to `agentId`. */
export function openCardsFor(agentId: string, tasks: readonly CardLike[] | undefined | null): string[] {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter((t) => t && t.assignee === agentId && (t.status === 'todo' || t.status === 'doing') && typeof t.id === 'string')
    .map((t) => t.id as string);
}

/** Whether `sender` may archive `body.agentId`, and the request normalised. No side effects. */
export function validateArchiveRequest(sender: string, body: unknown, roster: ArchiveRoster): ArchiveCheck {
  if (!sender || (sender !== roster.godId && !roster.isGod(sender))) return { ok: false, error: 'only the Boss may archive an agent (forbidden)' };
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const agentId = typeof b.agentId === 'string' ? b.agentId.trim() : '';
  if (!AGENT_ID.test(agentId)) return { ok: false, error: `invalid agentId "${String(b.agentId ?? '')}"` };
  if (agentId === sender || agentId === roster.godId || roster.isGod(agentId)) return { ok: false, error: 'the Boss cannot be archived' };
  if (!roster.known(agentId)) return { ok: false, error: `unknown agent "${agentId}" (not found on the floor)` };
  if (roster.isArchived(agentId)) return { ok: false, error: `${agentId} is already archived` };
  const open = roster.openCards(agentId);
  if (open.length) return { ok: false, error: `${agentId} still has open cards: ${open.join(', ')} (reassign or finish them first)` };
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  return { ok: true, request: { agentId, ...(reason ? { reason } : {}) } };
}
