/**
 * Picking an agent's engine over its tier walk (shared/modelTiers.ts resolveAgentWalk).
 * Each tier is balanced on its own with the usual rules (engineChoice.ts balanceEngines);
 * the walk leaves a tier only when no entry in it has room, and the reason names every
 * tier it left. Pure, so test/model-tiers.test.cjs can pin it.
 */
import { balanceEngines, describeReading, minutesUntil, type Candidate, type EngineReadings, type EngineThresholds } from './engineChoice';
import { entryLabel, type AgentModelEntry } from '../shared/modelEntry';
import type { AgentWalk, Escalation, Tier } from '../shared/modelTiers';

export interface TierPickInput {
  walk: AgentWalk;
  /** The candidate for an entry: its meter, label and any refusal. */
  candidateOf: (e: AgentModelEntry) => Candidate;
  readings: EngineReadings;
  nowMs: number;
  thresholds?: Partial<EngineThresholds>;
  /** A pin the caller found usable; it wins while its entry is not refused. */
  pin?: AgentModelEntry | null;
}

export interface TierPick {
  entry: AgentModelEntry | null;
  tier?: Tier;
  /** Index into walk.walk; -1 for a pin or no pick. */
  index: number;
  reason: string;
  /** Nothing on the walk can take work until a reset: the agent waits. */
  quotaBlocked: boolean;
  /** Every tier was full and the soonest reset was taken. */
  full?: boolean;
  pinned?: boolean;
}

const groupOf = (w: { tier: Tier; preferred?: boolean }): string => (w.preferred ? 'reserved' : w.tier);
const groupLabel = (g: string): string => (g === 'reserved' ? 'reserved' : `tier ${g}`);

/** Distinct groups in walk order, each with the indices that belong to it. */
function groupsOf(groups: readonly string[]): Array<{ group: string; idx: number[] }> {
  const out: Array<{ group: string; idx: number[] }> = [];
  groups.forEach((g, i) => {
    const hit = out.find((o) => o.group === g);
    if (hit) hit.idx.push(i); else out.push({ group: g, idx: [i] });
  });
  return out;
}

/** A persistent agent's fresh-start pick. In order: a usable pin; the first group
 *  (reserved entries, then each walked tier) whose balancer finds room; when every entry
 *  is capped, spent or refused, a wait naming each tier's meters and the next room; else
 *  the entry past the soft cutoff whose room comes back first. */
export function pickAgentEntry(input: TierPickInput): TierPick {
  const { walk, readings, nowMs } = input;
  if (input.pin && !input.candidateOf(input.pin).blocked) {
    const at = walk.walk.findIndex((w) => entryLabel(w.entry) === entryLabel(input.pin!));
    return {
      entry: input.pin, ...(at >= 0 ? { tier: walk.walk[at].tier } : {}), index: -1, pinned: true, quotaBlocked: false,
      reason: `pinned to ${entryLabel(input.pin)}`
    };
  }
  if (walk.blocked) return { entry: null, index: -1, quotaBlocked: true, reason: `quota blocked: ${walk.blocked}` };
  if (!walk.walk.length) return { entry: null, index: -1, quotaBlocked: false, reason: 'every entry is ruled out; keeping the current engine' };

  const cands: Candidate[] = walk.walk.map((w) => ({
    ...input.candidateOf(w.entry),
    ...(w.entry.maxPercent !== undefined ? { maxPercent: w.entry.maxPercent } : {})
  }));
  const options = { thresholds: input.thresholds };
  const used = (i: number): number | undefined => { const e = cands[i].engine; return e ? readings[e]?.percent : undefined; };
  const prefix = [
    ...(walk.escalated ? [`escalated to top (${walk.escalated.reason}: ${walk.escalated.detail})`] : []),
    ...(walk.widened ? [walk.widened] : [])
  ];
  const notes = walk.notes;
  const join = (parts: string[]) => [...prefix, ...parts, ...notes].join('; ');
  const left: string[] = [];
  const groups = groupsOf(walk.walk.map(groupOf));
  for (const { group, idx } of groups) {
    const p = balanceEngines(idx.map((i) => cands[i]), readings, nowMs, options);
    if (p && !p.full) {
      const index = idx[p.index];
      return { entry: walk.walk[index].entry, tier: walk.walk[index].tier, index, quotaBlocked: false, reason: join([...left, `${groupLabel(group)}: ${p.reason}`]) };
    }
    left.push(`${groupLabel(group)}: no entry has room (${idx.map((i) => describeReading(cands[i], readings)).join(', ')})`);
  }

  const capped = (i: number): boolean => cands[i].maxPercent !== undefined && (used(i) ?? 0) >= cands[i].maxPercent!;
  const spent = (i: number): boolean => (used(i) ?? 0) >= 100;
  const soft = cands.map((_, i) => i).filter((i) => !cands[i].blocked && !capped(i) && !spent(i));
  if (!soft.length) {
    const describeOut = (i: number): string => cands[i].blocked
      ? `${cands[i].label} refused`
      : `${describeReading(cands[i], readings)}${capped(i) ? ` (cap ${cands[i].maxPercent}%)` : ''}`;
    const tiers = groups.map(({ group, idx }) => `${groupLabel(group)}: ${idx.map(describeOut).join(', ')}`);
    const timed = cands.map((c, i) => ({ i, at: c.engine ? readings[c.engine]?.roomAtMs : undefined }))
      .filter((x): x is { i: number; at: number } => x.at !== undefined && Number.isFinite(x.at))
      .sort((a, b) => a.at - b.at)[0];
    const next = timed ? `next room in ${minutesUntil(timed.at, nowMs)} (${cands[timed.i].label})` : 'next room: reset time unknown';
    return { entry: null, index: -1, quotaBlocked: true, reason: join([`waiting: every walked entry is capped, spent or refused`, ...tiers, next]) };
  }
  const p = balanceEngines(soft.map((i) => cands[i]), readings, nowMs, options)!;
  const index = soft[p.index];
  return { entry: walk.walk[index].entry, tier: walk.walk[index].tier, index, quotaBlocked: false, full: true, reason: join([`every tier is full`, ...left, p.reason]) };
}

/** Agent-pick ledger fields for an escalated walk: the reason when the pick landed on
 *  top, or which escalation fell back because top had no room. Empty otherwise. */
export function escalationLedger(walk: AgentWalk, pick: TierPick): { escalation?: Escalation['reason']; escalationDetail?: string; escalatedFellBack?: Escalation['reason'] } {
  if (!walk.escalated) return {};
  if (pick.tier === 'top') return { escalation: walk.escalated.reason, escalationDetail: walk.escalated.detail };
  return { escalatedFellBack: walk.escalated.reason };
}

/** The live limit switch over tier groups (`groups[i]` names the group of `cands[i]`): the
 *  first group, in order, where `limit` finds room; when none has any, `limit` over every
 *  candidate, flagged full. */
export function pickByTier<P extends { index: number; reason: string; full?: boolean }>(
  groups: readonly string[],
  cands: readonly Candidate[],
  limit: (list: readonly Candidate[]) => P | null
): (P & { full?: boolean }) | null {
  const left: string[] = [];
  for (const { group, idx } of groupsOf(groups)) {
    const p = limit(idx.map((i) => cands[i]));
    if (p && !p.full) return { ...p, index: idx[p.index], reason: [...left, `${groupLabel(group)}: ${p.reason}`].join('; ') };
    left.push(`${groupLabel(group)}: no entry has room`);
  }
  const p = limit(cands);
  return p && { ...p, full: true, reason: `every tier is full; ${p.reason}` };
}
