/** Claude Code reasoning effort, per agent. Unset means the CLI's own default
 *  (the user's global `effortLevel`, or Claude Code's built-in one). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export function effortLevelsFor(provider: string, model?: string): readonly EffortLevel[] {
  if (provider === 'claude') return EFFORT_LEVELS;
  if (provider !== 'codex') return [];
  return /^gpt-(6(?:\.\d+)?-|5\.6-)/.test(model ?? '')
    ? EFFORT_LEVELS : EFFORT_LEVELS.filter((e) => e !== 'max');
}

/** Codex never runs above this (The human, 2026-10-23: xhigh on Codex is too expensive). */
export const CODEX_MAX_EFFORT: EffortLevel = 'medium';

/** Fable never runs above this (The human, 2026-11-21: "Cap Fable at high"). */
export const FABLE_MAX_EFFORT: EffortLevel = 'high';

function ceilingFor(provider: string, model: string | undefined): EffortLevel | undefined {
  if (provider === 'codex') return CODEX_MAX_EFFORT;
  if (provider === 'claude' && /^claude-fable-/.test(model ?? '')) return FABLE_MAX_EFFORT;
  return undefined;
}

/** `level` lowered to the ceiling of the provider (Codex) or model (Fable). */
export function capEffort(provider: string, level: EffortLevel | undefined, model?: string): EffortLevel | undefined {
  const cap = ceilingFor(provider, model);
  if (!cap || !level) return level;
  return EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(cap) ? cap : level;
}
