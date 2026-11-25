/**
 * Respawn a live agent on a chosen provider/model. The restart itself is the usage-limit
 * switch (index.ts: handoff, hive:limitSwitchDue, hive:limitSwitch, then the renderer
 * sleeps and wakes the card), so the card, inbox and handoff behave exactly as they do
 * when the balancer moves an agent. This file adds what a deliberate switch needs on top:
 * wait for a quiet terminal, store the choice as the agent's engine and persisted pin, so
 * the balancer does not move the agent straight back. Pure over `ModelSwitchDeps`.
 */
import { entryLabel, sameEntry, type AgentModelEntry } from '../shared/modelBalance';

/** An unanswered restart proposal is sent again after this long (the limit path's own interval). */
export const SWITCH_RESEND_MS = 60_000;

export interface SwitchAgentView {
  id: string;
  name: string;
  isGod: boolean;
  current: AgentModelEntry;
  /** The agent's normal-card tier walk; its entries carry the camp caps. */
  walk: AgentModelEntry[];
  /** Has a running terminal to restart. */
  live: boolean;
}

export interface ModelSwitchDeps {
  now(): number;
  agent(id: string): SwitchAgentView | null;
  /** The terminal has stopped producing output. */
  quiet(id: string): boolean;
  closing(): boolean;
  /** Entries this agent can run on: the camp tier entries it can run plus every launchable model. */
  choices(id: string): AgentModelEntry[];
  /** Store the chosen entry as the agent's engine and its persisted pin. */
  persist(id: string, entry: AgentModelEntry): void;
  /** The pin persisted for the agent, which applies again once its entry has room. */
  storedPin?(id: string): AgentModelEntry | null;
  /** Write the handoff and ask the renderer to restart the agent; false when it could not start. */
  restart(id: string, from: string, to: string): Promise<boolean>;
  ledger(event: Record<string, unknown>): void;
}

export type SwitchResult =
  | { ok: true; state: 'pending' | 'switching' | 'applied'; from: string; to: string; noop?: boolean }
  | { ok: false; code: 'unknown-agent' | 'unknown-entry' | 'boss-unconfirmed'; error: string };

export interface SwitchStatus { to: string; state: 'pending' | 'switching' }

interface Queued { entry: AgentModelEntry; reason: string; confirmBoss: boolean; stored?: boolean; proposedAt?: number; fresh?: boolean; logged?: boolean }

export function createModelSwitcher(deps: ModelSwitchDeps) {
  const queue = new Map<string, Queued>();
  const pins = new Map<string, AgentModelEntry>();

  const status = (id: string): SwitchStatus | null => {
    const q = queue.get(id);
    return q ? { to: entryLabel(q.entry), state: q.proposedAt === undefined ? 'pending' : 'switching' } : null;
  };

  /** Store, pin and record the switch, then restart a live agent. Returns the state it reached. */
  async function apply(id: string, q: Queued): Promise<'pending' | 'switching' | 'applied'> {
    const a = deps.agent(id);
    if (!a) { queue.delete(id); return 'applied'; }
    const from = entryLabel(a.current);
    const to = entryLabel(q.entry);
    if (!q.stored) {
      q.stored = true;
      deps.persist(id, q.entry);
      pins.set(id, q.entry);
      deps.ledger({ kind: 'model-switch', agentId: id, chosen: to, previous: from, changed: true, reason: q.reason, state: a.live ? 'restart' : 'next-wake' });
    }
    if (q.fresh && !q.logged) {
      q.logged = true;
      deps.ledger({ kind: 'model-switch', agentId: id, chosen: to, previous: from, changed: false, reason: q.reason, state: a.live ? 'restart' : 'next-wake' });
    }
    if (!a.live) { queue.delete(id); return 'applied'; }
    if (!(await deps.restart(id, from, to))) {
      // Stored, but the restart did not start: keep it queued and try again next tick.
      q.proposedAt = undefined;
      return 'pending';
    }
    q.proposedAt = deps.now();
    return 'switching';
  }

  /** Whether a queued switch may be applied now. */
  const ready = (id: string): boolean => !deps.closing() && deps.quiet(id);

  async function switchAgentModel(
    agentId: string, entry: AgentModelEntry, reason: string, opts: { confirmBoss?: boolean } = {}
  ): Promise<SwitchResult> {
    const a = deps.agent(agentId);
    if (!a) return { ok: false, code: 'unknown-agent', error: 'unknown agent' };
    if (a.isGod && !opts.confirmBoss) return { ok: false, code: 'boss-unconfirmed', error: 'switching the Boss needs confirmation' };
    const chosen = deps.choices(agentId).find((e) => sameEntry(e, entry));
    if (!chosen) return { ok: false, code: 'unknown-entry', error: `${entryLabel(entry)} is not available for this agent` };
    const from = entryLabel(a.current);
    const to = entryLabel(chosen);
    if (sameEntry(a.current, chosen)) {
      pins.set(agentId, a.walk.find((e) => sameEntry(e, chosen)) ?? chosen);
      queue.delete(agentId);
      return { ok: true, state: 'applied', from, to, noop: true };
    }
    const q: Queued = { entry: chosen, reason, confirmBoss: opts.confirmBoss === true };
    if (a.live) {
      queue.set(agentId, q);
      if (!ready(agentId)) return { ok: true, state: 'pending', from, to };
    }
    const state = await apply(agentId, q);
    return { ok: true, state, from, to };
  }

  /** Respawn the agent in a fresh session on the model it already runs: the same restart a switch
   *  uses (handoff, quiet point, renderer sleep and wake), with nothing stored. The current entry
   *  is pinned so the balancer does not move it elsewhere on the way back up. */
  async function freshRestart(agentId: string, reason: string): Promise<SwitchResult> {
    const a = deps.agent(agentId);
    if (!a) return { ok: false, code: 'unknown-agent', error: 'unknown agent' };
    const from = entryLabel(a.current);
    pins.set(agentId, a.walk.find((e) => sameEntry(e, a.current)) ?? a.current);
    const q: Queued = { entry: a.current, reason, confirmBoss: false, stored: true, fresh: true };
    if (a.live) {
      queue.set(agentId, q);
      if (!ready(agentId)) return { ok: true, state: 'pending', from, to: from };
    }
    return { ok: true, state: await apply(agentId, q), from, to: from };
  }

  /** Apply queued switches whose terminal has gone quiet; send unanswered proposals again. */
  async function tick(): Promise<void> {
    for (const [id, q] of [...queue]) {
      const a = deps.agent(id);
      if (!a || !a.live) { queue.delete(id); continue; }
      if (q.proposedAt !== undefined) {
        if (deps.now() - q.proposedAt >= SWITCH_RESEND_MS && !deps.closing()) await apply(id, q);
      } else if (ready(id)) await apply(id, q);
    }
  }

  /** The restart happened (or the agent is gone): the switch is no longer in flight. */
  function completed(id: string): void { queue.delete(id); }

  /** The entry pinned for `id` while `usable` says it has room. A session pin lapses when
   *  it has none; the persisted one stays and applies again after its reset. */
  function pinnedEntry(id: string, usable: (e: AgentModelEntry) => boolean): AgentModelEntry | null {
    const p = pins.get(id);
    if (p && usable(p)) return p;
    pins.delete(id);
    const stored = deps.storedPin?.(id);
    return stored && usable(stored) ? stored : null;
  }

  /** Keep the balancer from moving `id` off `entry`, as a deliberate switch does. */
  function pin(id: string, entry: AgentModelEntry): void { pins.set(id, entry); }

  /** Drop the session pin, as clearing the persisted one does. */
  function clearPin(id: string): void { pins.delete(id); }

  return { switchAgentModel, freshRestart, tick, completed, status, pinnedEntry, pin, clearPin };
}

export type ModelSwitcher = ReturnType<typeof createModelSwitcher>;
