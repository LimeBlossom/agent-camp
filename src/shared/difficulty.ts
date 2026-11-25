import { capEffort, effortLevelsFor, EFFORT_LEVELS, type EffortLevel } from './effort';

/** How hard a card is. Optional on a card and on a spawn-request;
 *  absent picks exactly as before the field existed. */
export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type Difficulty = typeof DIFFICULTIES[number];

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

const RANK: Record<Difficulty, number> = { easy: 0, normal: 1, hard: 2 };

/** Effort each difficulty asks for; undefined keeps the agent's own setting. */
export const DIFFICULTY_EFFORT: Record<Difficulty, EffortLevel | undefined> = {
  easy: 'medium',
  normal: undefined,
  hard: 'xhigh'
};

/** The hardest difficulty among the agent's open (todo or doing) cards that carry one.
 *  Cards without the field do not count, so an agent with none set picks as before. */
export function hardestOpenDifficulty(
  tasks: readonly { assignee?: string; status?: string; difficulty?: unknown }[],
  agentId: string
): Difficulty | undefined {
  let best: Difficulty | undefined;
  for (const t of tasks) {
    if (t.assignee !== agentId || (t.status !== 'todo' && t.status !== 'doing')) continue;
    if (!isDifficulty(t.difficulty)) continue;
    if (!best || RANK[t.difficulty] > RANK[best]) best = t.difficulty;
  }
  return best;
}

/** A spawn-request's `engines` list is in order of preference (Claude first for code work).
 *  Hard keeps that order but sends weak engines (`isWeak`, e.g. Flash) to the back, so
 *  they are taken only when nothing stronger has room. Easy and normal keep the order. */
export function engineOrderFor<T>(engines: readonly T[], d: Difficulty | undefined, isWeak: (e: T) => boolean = () => false): T[] {
  if (d !== 'hard') return [...engines];
  return [...engines.filter((e) => !isWeak(e)), ...engines.filter(isWeak)];
}

/**
 * The effort a fresh session on `provider`/`model` runs at for difficulty `d`. Hard never
 * lowers an agent's own higher setting; easy replaces it. A level the CLI does not take
 * (agy, or `max` on older Codex models) falls back to the agent's own. Codex and Fable are
 * then capped (CODEX_MAX_EFFORT, FABLE_MAX_EFFORT) whatever was asked.
 */
export function difficultyEffort(
  d: Difficulty | undefined,
  provider: string,
  model: string | undefined,
  own: EffortLevel | undefined
): EffortLevel | undefined {
  const want = d ? DIFFICULTY_EFFORT[d] : undefined;
  if (!want || !effortLevelsFor(provider, model).includes(want)) return capEffort(provider, own, model);
  if (d === 'hard' && own && EFFORT_LEVELS.indexOf(own) > EFFORT_LEVELS.indexOf(want)) return capEffort(provider, own, model);
  return capEffort(provider, want, model);
}

/** What the engine ledger records for a spawn: the level actually passed to the CLI, after
 *  the Codex and Fable caps, or "default" when none is passed and the CLI uses its own. */
export function ledgerEffort(
  d: Difficulty | undefined,
  provider: string,
  model: string | undefined,
  own: EffortLevel | undefined
): string {
  return difficultyEffort(d, provider, model, own) ?? 'default';
}
