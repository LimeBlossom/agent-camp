import catalog from './modelCatalog.json';

/** Which models count as strong, medium or light, as case-insensitive substrings of the
 *  model id. The lists live in modelCatalog.json ("modelStrength") so a new model is a
 *  data edit. A model matching none of them is neutral: neither strong nor weak. */
const STRENGTH = (catalog as { modelStrength: { strong: string[]; medium: string[]; light: string[] } }).modelStrength;

export type ModelStrength = 'strong' | 'medium' | 'light' | 'neutral';

const has = (name: string, words: readonly string[]): boolean => words.some((w) => name.includes(w.toLowerCase()));

export function modelStrength(model: string | undefined): ModelStrength {
  const name = (model ?? '').toLowerCase();
  if (!name) return 'neutral';
  if (has(name, STRENGTH.strong)) return 'strong';
  if (has(name, STRENGTH.medium)) return 'medium';
  if (has(name, STRENGTH.light)) return 'light';
  return 'neutral';
}

/** Sonnet, Flash, Luna, Haiku and the like: a hard card must not land on these while a
 *  strong entry has room. */
export function isWeakModel(model: string | undefined): boolean {
  const s = modelStrength(model);
  return s === 'medium' || s === 'light';
}
