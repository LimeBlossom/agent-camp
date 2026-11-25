/** When each agent's current action text first appeared, for the phone's "doing this for 2m". */
const since = new Map<string, { action: string; at: number }>();

/** Called with each state the primary publishes; an unchanged action keeps its original start. */
export function noteActions(state: unknown, now = Date.now()): void {
  const agents = (state as { agents?: Array<{ id?: unknown; action?: unknown }> } | null)?.agents;
  if (!Array.isArray(agents)) return;
  const seen = new Set<string>();
  for (const a of agents) {
    if (typeof a?.id !== 'string') continue;
    seen.add(a.id);
    const action = typeof a.action === 'string' ? a.action : '';
    if (since.get(a.id)?.action !== action) since.set(a.id, { action, at: now });
  }
  for (const id of since.keys()) if (!seen.has(id)) since.delete(id);
}

export function actionSince(agentId: string): number | undefined {
  return since.get(agentId)?.at;
}
