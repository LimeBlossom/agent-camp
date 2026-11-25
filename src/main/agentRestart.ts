/**
 * Boss-only restart of a hung agent session: write the handoff, end the process tree,
 * start a fresh session on the same card with the next model on the agent's tier walk (or
 * a named one). The request is validated twice with the same function: where the Boss
 * queues it (camp MCP tool) and where the harness receives it (hive outbox router), so
 * a raw outbox file cannot skip the checks. Pure over `RestartDeps`.
 */
import { entryLabel, sameEntry, type AgentModelEntry } from '../shared/modelBalance';

/** The harness act a queued restart carries. */
export const RESTART_AGENT_ACT = 'restart-agent';

/** Ids that are one path segment; anything else cannot name an agent folder. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RestartRequest {
  agentId: string;
  reason: string;
  force: boolean;
  model?: AgentModelEntry;
}

export type RestartCheck = { ok: true; request: RestartRequest } | { ok: false; error: string };

export interface RestartRoster {
  /** The Boss id, or null when the floor has none. */
  godId: string | null;
  /** True for an agent that exists on the floor. */
  known(id: string): boolean;
  isGod(id: string): boolean;
}

/** Whether `sender` may restart `body.agentId`, and the request normalised. No side effects. */
export function validateRestartRequest(sender: string, body: unknown, roster: RestartRoster): RestartCheck {
  if (!sender || (sender !== roster.godId && !roster.isGod(sender))) return { ok: false, error: 'only the Boss may restart an agent (forbidden)' };
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const agentId = typeof b.agentId === 'string' ? b.agentId.trim() : '';
  if (!AGENT_ID.test(agentId)) return { ok: false, error: `invalid agentId "${String(b.agentId ?? '')}"` };
  if (agentId === sender || agentId === roster.godId || roster.isGod(agentId)) return { ok: false, error: 'the Boss cannot restart itself' };
  if (!roster.known(agentId)) return { ok: false, error: `unknown agent "${agentId}" (not found on the floor)` };
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) return { ok: false, error: 'reason is required: say why the session is being restarted' };
  if (b.force !== undefined && typeof b.force !== 'boolean') return { ok: false, error: 'force must be a boolean' };
  let model: AgentModelEntry | undefined;
  if (b.model !== undefined) {
    const m = b.model as Record<string, unknown> | null;
    if (!m || typeof m !== 'object' || typeof m.provider !== 'string' || !m.provider || (m.model !== undefined && typeof m.model !== 'string')) {
      return { ok: false, error: 'model must be {provider, model}' };
    }
    model = b.model as AgentModelEntry;
  }
  return { ok: true, request: { agentId, reason, force: b.force === true, ...(model ? { model } : {}) } };
}

export interface RestartAgentView {
  id: string;
  isGod: boolean;
  current: AgentModelEntry;
  /** The agent's tier walk for its card, in order. */
  ladder: AgentModelEntry[];
  /** Epoch ms of the session's last activity; absent when unknown. */
  lastActivityAt?: number;
}

export interface RestartCard { id: string; status?: string; title?: string; brief?: string }

export interface RestartHandoff {
  card: RestartCard;
  lastActivityAt: number | undefined;
  reason: string;
  from: AgentModelEntry;
  to: AgentModelEntry;
}

export interface RestartDeps {
  now(): number;
  bossId(): string | null;
  /** Sessions active within this long are refused without `force`. */
  recentActivityMs(): number;
  agent(id: string): RestartAgentView | null;
  /** The card the fresh session will work: the agent's doing card, else its first todo. */
  currentCard(id: string): RestartCard | null;
  /** Entries the agent can launch on. */
  choices(id: string): AgentModelEntry[];
  /** Why a restart cannot go ahead right now (closing time, a model switch in flight), or null. Optional. */
  blocked?(id: string, force: boolean): string | null;
  /** Snapshot taken before the session is touched; failure aborts the restart. */
  writeHandoff(id: string, data: RestartHandoff): Promise<void>;
  /** End the session and its whole process tree; resolves once it is gone. */
  stopTree(id: string): Promise<boolean>;
  /** Start a fresh session on `model` working `cardId`; resolves once it is up. */
  startFresh(id: string, model: AgentModelEntry, cardId: string): Promise<boolean>;
  appendLog(event: Record<string, unknown>): void;
  noteCard(cardId: string, note: string): void;
}

export interface RestartResult {
  ok: boolean;
  error?: string;
  /** Things that went wrong after the restart succeeded (audit or card note not written). */
  warnings?: string[];
  oldModel?: AgentModelEntry;
  newModel?: AgentModelEntry;
  cardId?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The model after `current` on `ladder` that can launch; `current` itself when it is last or nothing later launches. */
export function nextRestartModel(current: AgentModelEntry, ladder: readonly AgentModelEntry[], launchable: readonly AgentModelEntry[]): AgentModelEntry {
  const at = ladder.findIndex((e) => sameEntry(e, current));
  const later = at < 0 ? ladder : ladder.slice(at + 1);
  const next = later.find((e) => launchable.some((c) => sameEntry(c, e)));
  return next ? (launchable.find((c) => sameEntry(c, next)) ?? next) : current;
}

export function createAgentRestarter(deps: RestartDeps) {
  const inFlight = new Set<string>();

  async function restart(sender: string, body: unknown): Promise<RestartResult> {
    const boss = deps.bossId();
    const check = validateRestartRequest(sender, body, {
      godId: boss,
      known: (id) => deps.agent(id) !== null,
      isGod: (id) => deps.agent(id)?.isGod === true
    });
    if (!check.ok) return { ok: false, error: check.error };
    const { agentId, reason, force } = check.request;
    const agent = deps.agent(agentId)!;
    const card = deps.currentCard(agentId);
    if (!card) return { ok: false, error: `${agentId} has no open doing or todo card to restart on` };
    const launchable = deps.choices(agentId);
    let target: AgentModelEntry;
    if (check.request.model) {
      const named = launchable.find((e) => sameEntry(e, check.request.model!));
      if (!named) return { ok: false, error: `${entryLabel(check.request.model)} is not available for ${agentId}` };
      target = named;
    } else {
      target = nextRestartModel(agent.current, agent.ladder, launchable);
      if (!launchable.some((e) => sameEntry(e, target))) return { ok: false, error: `no launchable model for ${agentId}` };
    }
    if (!force) {
      const at = agent.lastActivityAt;
      if (typeof at !== 'number') return { ok: false, error: `${agentId} has unknown session activity; pass force:true to restart anyway` };
      const quietMs = deps.now() - at;
      if (quietMs < deps.recentActivityMs()) {
        return { ok: false, error: `${agentId} was active ${Math.round(quietMs / 1000)}s ago (under ${Math.round(deps.recentActivityMs() / 60_000)} min); pass force:true to restart anyway` };
      }
    }
    const why = deps.blocked?.(agentId, force);
    if (why) return { ok: false, error: why };
    if (inFlight.has(agentId)) return { ok: false, error: `a restart of ${agentId} is already in progress` };
    inFlight.add(agentId);
    try {
      const snapshot: RestartHandoff = { card: { ...card }, lastActivityAt: agent.lastActivityAt, reason, from: agent.current, to: target };
      try { await deps.writeHandoff(agentId, snapshot); } catch (e) { return { ok: false, error: `handoff not written: ${message(e)}` }; }
      try {
        if (!(await deps.stopTree(agentId))) return { ok: false, error: `could not stop ${agentId}'s session` };
      } catch (e) { return { ok: false, error: `could not stop ${agentId}'s session: ${message(e)}` }; }
      try {
        if (!(await deps.startFresh(agentId, target, card.id))) return { ok: false, error: `${agentId}'s old session is stopped but the fresh one did not start` };
      } catch (e) { return { ok: false, error: `${agentId}'s old session is stopped but the fresh one did not start: ${message(e)}` }; }
      const warnings: string[] = [];
      try {
        deps.appendLog({ kind: 'agent-restart', who: sender, agentId, reason, oldModel: agent.current, newModel: target, cardId: card.id, forced: force });
      } catch (e) { warnings.push(`audit event not logged: ${message(e)}`); }
      try {
        deps.noteCard(card.id, `Boss restarted ${agentId} (${reason}): ${entryLabel(agent.current)} -> ${entryLabel(target)}`);
      } catch (e) { warnings.push(`card ${card.id} not annotated: ${message(e)}`); }
      return { ok: true, oldModel: agent.current, newModel: target, cardId: card.id, ...(warnings.length ? { warnings } : {}) };
    } finally {
      inFlight.delete(agentId);
    }
  }

  return { restart };
}

export type AgentRestarter = ReturnType<typeof createAgentRestarter>;
