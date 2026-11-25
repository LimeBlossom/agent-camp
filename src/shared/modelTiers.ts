/**
 * Camp-wide model tiers (config.json `modelTiers`): one ordered list each for top, strong,
 * medium and light models, set by the human. Each roster agent has a `tier` (the Boss:
 * config `godTier`) in place of its own model list; no agent sits on top. A card's
 * difficulty picks the tier a fresh session starts on; the walk then goes down the tiers,
 * and back up only as far as the agent's own tier. Top is walked only by an escalated hard
 * card. Pure, so the Edit Agent modal shows the walk main applies.
 */
import { cleanModelList, entryLabel, parseModelEntry, sameEntry, type AgentModelEntry } from './modelEntry';
import { modelStrength } from './modelStrength';
import type { Difficulty } from './difficulty';
import { applyReservations, isReservationActive, reservationCovers, type Reservation } from './reservations';
import { isArtWorkKind, type WorkKind } from './workKind';

export const TIERS = ['top', 'strong', 'medium', 'light'] as const;
export type Tier = typeof TIERS[number];
/** The tiers an agent can be placed on. */
export const AGENT_TIERS = ['strong', 'medium', 'light'] as const satisfies readonly Tier[];
export type AgentTier = typeof AGENT_TIERS[number];
export type ModelTiers = Record<Tier, AgentModelEntry[]>;
export const TIER_LABEL: Record<Tier, string> = { top: 'Top', strong: 'Strong', medium: 'Medium', light: 'Light' };

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}

export function emptyTiers(): ModelTiers {
  return { top: [], strong: [], medium: [], light: [] };
}

const rank = (t: Tier): number => TIERS.indexOf(t);
const asAgentTier = (t: Tier): AgentTier => (t === 'top' ? 'strong' : t);

/** Why a hard card's next fresh session starts on top. */
export interface Escalation {
  reason: 'send-back' | 'self';
  detail: string;
}

/** A hard card escalates after a send-back (named first) or when its assignee asked
 *  (card `escalation`, set by a worker task-patch `escalate`). Other cards never do. */
export function cardEscalation(card: { difficulty?: unknown; sendBacks?: unknown; escalation?: unknown } | null | undefined): Escalation | undefined {
  if (!card || card.difficulty !== 'hard') return undefined;
  const n = typeof card.sendBacks === 'number' ? card.sendBacks : 0;
  if (n >= 1) return { reason: 'send-back', detail: `${n} send-back${n === 1 ? '' : 's'}` };
  const why = (card.escalation as { reason?: unknown } | undefined)?.reason;
  if (typeof why === 'string' && why.trim()) return { reason: 'self', detail: why.trim() };
  return undefined;
}

/** The tiers a fresh session tries, in order. Hard starts on strong, easy on light,
 *  anything else on the agent's own tier; then every tier below the start, then the
 *  tiers above it, nearest first, up to the higher of the start and the agent's tier.
 *  An escalated hard card or an art kind (splat, visual-judgment, image-making) puts
 *  top in front; nothing else ever walks top. */
export function tierWalk(agentTier: Tier, difficulty?: Difficulty, escalation?: Escalation, kind?: WorkKind): Tier[] {
  const own = asAgentTier(agentTier);
  const start: AgentTier = difficulty === 'hard' ? 'strong' : difficulty === 'easy' ? 'light' : own;
  const s = rank(start);
  const ceiling = Math.min(s, rank(own));
  const walk = [...TIERS.slice(s), ...TIERS.slice(ceiling, s).reverse()];
  return (difficulty === 'hard' && escalation) || isArtWorkKind(kind) ? ['top', ...walk] : walk;
}

/** The stored tier lists as known entries. A model listed twice keeps its first place,
 *  strongest tier first; anything malformed is dropped. */
export function parseModelTiers(raw: unknown): ModelTiers {
  const out = emptyTiers();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const seen: AgentModelEntry[] = [];
  for (const t of TIERS) {
    for (const e of cleanModelList((raw as Record<string, unknown>)[t])) {
      if (seen.some((s) => sameEntry(s, e))) continue;
      seen.push(e);
      out[t].push(e);
    }
  }
  return out;
}

/** Whether tier lists may be saved: every entry valid, each model in one tier only. */
export function validateModelTiers(raw: unknown): { ok: true; tiers: ModelTiers } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'modelTiers must be { top, strong, medium, light }' };
  const out = emptyTiers();
  const where: Array<{ entry: AgentModelEntry; tier: Tier }> = [];
  for (const t of TIERS) {
    const list = (raw as Record<string, unknown>)[t] ?? [];
    if (!Array.isArray(list)) return { ok: false, reason: `the ${t} tier must be a list` };
    for (const [i, item] of list.entries()) {
      const res = parseModelEntry(item);
      if (!res.ok) return { ok: false, reason: `${t} tier entry ${i + 1}: ${res.reason}` };
      const dup = where.find((w) => sameEntry(w.entry, res.entry));
      if (dup) return { ok: false, reason: `${entryLabel(res.entry)} is in both ${dup.tier} and ${t}` };
      where.push({ entry: res.entry, tier: t });
      out[t].push(res.entry);
    }
  }
  return { ok: true, tiers: out };
}

export function tierOfEntry(tiers: ModelTiers, e: AgentModelEntry): Tier | undefined {
  return TIERS.find((t) => (tiers[t] ?? []).some((x) => sameEntry(x, e)));
}

/** Where a model goes when nobody placed it: by modelStrength, a neutral one in medium. */
export function defaultTierFor(model: string | undefined): AgentTier {
  const s = modelStrength(model);
  return s === 'neutral' ? 'medium' : s;
}

/** An agent's tier: the stored one, else the tier holding its current engine, else where
 *  that engine's model would go. Top reads as strong. */
export function agentTierOf(stored: unknown, tiers: ModelTiers, current: AgentModelEntry | undefined): AgentTier {
  if (isTier(stored)) return asAgentTier(stored);
  return asAgentTier((current && tierOfEntry(tiers, current)) ?? defaultTierFor(current?.model));
}

/** Stored modelTiers with an empty top list added, or null when there is nothing to
 *  write (no tiers yet, or top already there). */
export function withTopTier(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'top' in raw) return null;
  return { top: [], ...(raw as Record<string, unknown>) };
}

export interface WalkEntry {
  entry: AgentModelEntry;
  tier: Tier;
  /** A reservation keeps this entry for the card's kind, so it goes first. */
  preferred?: boolean;
}

export interface AgentWalk {
  /** The tiers walked, in order, after any widening. */
  tiers: Tier[];
  walk: WalkEntry[];
  /** Entries the agent's placement rules out. */
  excluded: Array<{ entry: AgentModelEntry; tier: Tier; reason: string }>;
  /** One line per reservation that excluded or preferred something. */
  notes: string[];
  /** Set when reservations left nothing to run. */
  blocked?: string;
  /** Set when nothing on the walk could run the agent and further tiers were added. */
  widened?: string;
  /** Set when the walk starts on top because the card escalated. */
  escalated?: Escalation;
}

export interface WalkInput {
  tiers: ModelTiers;
  agentTier: Tier;
  difficulty?: Difficulty;
  /** The card's escalation (cardEscalation); walks top only on a hard card. */
  escalation?: Escalation;
  nowMs: number;
  reservations?: readonly Reservation[];
  kind?: WorkKind;
  /** Why this agent cannot run an entry, or null when it can. */
  exclusion?: (e: AgentModelEntry) => string | null;
}

/** The agent's ordered entries for a fresh start: the tier walk, minus what its placement
 *  rules out, widened to the remaining tiers when that leaves nothing, then reservations
 *  applied over the walk (entries reserved for the card's kind first, from any tier). */
export function resolveAgentWalk(input: WalkInput): AgentWalk {
  const order = tierWalk(input.agentTier, input.difficulty, input.escalation, input.kind);
  const escalated = input.difficulty === 'hard' && input.escalation ? input.escalation : undefined;
  const excluded: AgentWalk['excluded'] = [];
  const runnable = (tiers: readonly Tier[]): WalkEntry[] => tiers.flatMap((tier) => (input.tiers[tier] ?? []).flatMap((entry) => {
    const why = input.exclusion?.(entry) ?? null;
    if (why) { excluded.push({ entry, tier, reason: why }); return []; }
    return [{ entry, tier }];
  }));
  let walked = [...order];
  let kept = runnable(order);
  let widened: string | undefined;
  const rest = [...AGENT_TIERS].reverse().filter((t) => !order.includes(t));
  if (!kept.length && rest.length) {
    kept = runnable(rest);
    walked = [...order, ...rest];
    widened = `nothing in tier ${order.join(', ')} can run this agent; widened to ${rest.join(', ')}`;
  }

  const reservations = input.reservations ?? [];
  const nowMs = input.nowMs;
  const onWalk = applyReservations(kept, reservations, input.kind, nowMs, (w) => w.entry);
  const active = reservations.filter((r) => isReservationActive(r, nowMs));
  const coveredForKind = (e: AgentModelEntry) => input.kind !== undefined && active.some((r) => reservationCovers(r, e));
  const everywhere = applyReservations(
    TIERS.flatMap((tier) => (input.tiers[tier] ?? []).filter((entry) => !input.exclusion?.(entry)).map((entry) => ({ entry, tier }))),
    reservations, input.kind, nowMs, (w) => w.entry
  );
  const preferred = everywhere.list.filter((w) => coveredForKind(w.entry)).map((w) => ({ ...w, preferred: true }));
  const walk = [...preferred, ...onWalk.list.filter((w) => !preferred.some((p) => sameEntry(p.entry, w.entry)))];
  const notes = [...new Set([...onWalk.notes, ...everywhere.notes.filter((n) => / preferred for /.test(n))])];
  return {
    tiers: walked,
    walk,
    excluded,
    notes,
    ...(!walk.length && onWalk.blocked ? { blocked: onWalk.blocked } : {}),
    ...(widened ? { widened } : {}),
    ...(escalated ? { escalated } : {})
  };
}

/** Placed on the top tier by the migration. */
export const FABLE_ENTRY: AgentModelEntry = { provider: 'claude', model: 'claude-fable-5-2' };

export interface MigrationAgent {
  id: string;
  archived?: boolean;
  provider: AgentModelEntry['provider'];
  model?: string;
  models?: unknown;
}

export interface TierMigration {
  tiers: ModelTiers;
  agentTiers: Record<string, AgentTier>;
  godTier?: AgentTier;
}

/** Whether config.json still needs its one-shot move from per-agent ladders to tiers. */
export function needsTierMigration(cfg: { modelTiers?: unknown } | null | undefined): boolean {
  const t = cfg?.modelTiers;
  return !t || typeof t !== 'object' || Array.isArray(t);
}

/**
 * Tier lists from the camp's per-agent ladders: the union of every live agent's ladder,
 * the Boss's, and each one's current engine, placed by modelStrength. Inside a tier the
 * order is the best position any ladder gave the model, then how many ladders list it,
 * then first seen; two caps on one model keep the lower. Fable 5.2 goes on top, alone
 * unless top already holds more. Each agent takes the stronger of its first entry's tier and its current
 * engine's tier, so its current engine stays on its own normal-card walk.
 */
export function planTierMigration(input: { god?: Omit<MigrationAgent, 'id'>; agents: readonly MigrationAgent[] }): TierMigration {
  interface Stat { entry: AgentModelEntry; best: number; count: number; seen: number; cap?: number }
  const stats: Stat[] = [];
  const note = (e: AgentModelEntry, pos: number, counts: boolean): void => {
    let s = stats.find((x) => sameEntry(x.entry, e));
    if (!s) {
      s = { entry: { provider: e.provider, ...(e.model ? { model: e.model } : {}) }, best: pos, count: 0, seen: stats.length };
      stats.push(s);
    }
    s.best = Math.min(s.best, pos);
    if (counts) s.count++;
    if (e.maxPercent !== undefined) s.cap = s.cap === undefined ? e.maxPercent : Math.min(s.cap, e.maxPercent);
  };
  const members = [
    ...(input.god ? [{ ...input.god, id: '' }] : []),
    ...input.agents.filter((a) => !a.archived)
  ];
  const current = (a: Omit<MigrationAgent, 'id'>): AgentModelEntry => ({ provider: a.provider, ...(a.model ? { model: a.model } : {}) });
  for (const a of members) {
    const ladder = cleanModelList(a.models);
    ladder.forEach((e, i) => note(e, i, true));
    const cur = current(a);
    if (!ladder.some((e) => sameEntry(e, cur))) note(cur, ladder.length, !ladder.length);
  }

  const tiers = emptyTiers();
  for (const t of TIERS) {
    tiers[t] = stats
      .filter((s) => defaultTierFor(s.entry.model) === t)
      .sort((a, b) => a.best - b.best || b.count - a.count || a.seen - b.seen)
      .map((s) => (s.cap !== undefined ? { ...s.entry, maxPercent: s.cap } : s.entry));
  }
  for (const t of AGENT_TIERS) tiers[t] = tiers[t].filter((e) => !sameEntry(e, FABLE_ENTRY));
  if (!tiers.top.some((e) => sameEntry(e, FABLE_ENTRY))) tiers.top.unshift({ ...FABLE_ENTRY });

  const tierFor = (a: Omit<MigrationAgent, 'id'>): AgentTier => {
    const cur = asAgentTier(tierOfEntry(tiers, current(a)) ?? defaultTierFor(a.model));
    const first = cleanModelList(a.models)[0];
    const lead = first ? asAgentTier(tierOfEntry(tiers, first) ?? cur) : cur;
    return rank(cur) < rank(lead) ? cur : lead;
  };
  const agentTiers: Record<string, AgentTier> = {};
  for (const a of input.agents) if (!a.archived) agentTiers[a.id] = tierFor(a);
  return { tiers, agentTiers, ...(input.god ? { godTier: tierFor(input.god) } : {}) };
}
