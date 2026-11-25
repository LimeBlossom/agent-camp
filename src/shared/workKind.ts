/** What a card or spawn-request is doing. Optional on both; absent
 *  matches no engine reservation, so unknown work is never reserved work. */
export const WORK_KINDS = ['code', 'visual-judgment', 'image-making', 'video', 'splat', 'research'] as const;
export type WorkKind = typeof WORK_KINDS[number];

export function isWorkKind(v: unknown): v is WorkKind {
  return typeof v === 'string' && (WORK_KINDS as readonly string[]).includes(v);
}

/** Unit-art kinds that walk top tier automatically: Codex first, Fable when Codex is full. */
export const ART_WORK_KINDS = ['splat', 'visual-judgment', 'image-making'] as const satisfies readonly WorkKind[];

export function isArtWorkKind(v: unknown): v is typeof ART_WORK_KINDS[number] {
  return typeof v === 'string' && (ART_WORK_KINDS as readonly string[]).includes(v);
}

/** Every worker's standing rule. Boss-facing prose points at it with VISUAL_CHECK_POINTER. */
export const VISUAL_CHECK_TIERS = 'VISUAL CHECKS, three tiers: (1) measurable (clipping at a cell edge, foot slide, mask parity): write a script guard that exits 1, no model looks. (2) factual yes/no a script cannot easily answer: look yourself (Read the image) or use your own subagent; do not route through Camp and do not shell out to codex (it bypasses Camp quota). (3) taste (does it read, which look is better): Willow via a card or message.';

export const VISUAL_CHECK_POINTER = 'the worker runs that check itself by its VISUAL CHECKS tiers: a script guard first, its own eyes or subagent next, Willow only for taste';

/** Kind descriptions for the Boss's card tools and spawn prompt. */
export const WORK_KIND_GUIDE = `${WORK_KINDS.join(', ')}. Unit-art deliverables (splat/sprite export, felt/material settings, holdout/silhouette parity, look tuning) take an art kind (${ART_WORK_KINDS.join(', ')}) even when the work is Python/Blender; split mixed cards rather than tagging unit-art work as code. visual-judgment and image-making are only for work whose deliverable is the worker's own judgment of a look or the images it makes; code with a visual check is code (${VISUAL_CHECK_POINTER}). Reserved engines are kept for their kinds`;


const ART_KIND_KEYWORD = /(?:^|[^a-z])(splat|felt|sprite|strip|export)/i;

/** Refuses kind "code" on cards of an art-pipeline project (projects.json `"artPipeline": true`)
 *  whose title or description names splat, felt, sprite, strip or export, unless a non-empty
 *  kindReason is set. */
export function artCodeKindError(card: {
  project?: unknown;
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  kindReason?: unknown;
}, artProjects: ReadonlySet<string> = new Set()): string | undefined {
  if (card.kind !== 'code') return undefined;
  const project = typeof card.project === 'string' ? card.project.trim() : '';
  if (!artProjects.has(project)) return undefined;
  if (typeof card.kindReason === 'string' && card.kindReason.trim().length > 0) return undefined;
  const haystack = `${typeof card.title === 'string' ? card.title : ''}\n${typeof card.description === 'string' ? card.description : ''}`;
  const m = ART_KIND_KEYWORD.exec(haystack);
  if (!m) return undefined;
  return `kind "code" refused on ${project} card naming "${m[1].toLowerCase()}" (unit-art deliverables take an art kind such as ${ART_WORK_KINDS.join(', ')} even when the work is Python/Blender; pass kindReason to override if this card is genuinely non-art code)`;
}

const RETIRED_KINDS: Record<string, string> = {
  visual: 'kind "visual" was split into visual-judgment (the worker\'s own judgment of a look is the deliverable) and image-making; a visual check is code, so code with a yes/no look check is kind code'
};

/** Why `v` is not a work kind, or undefined when it is one. */
export function workKindError(v: unknown): string | undefined {
  if (isWorkKind(v)) return undefined;
  const retired = typeof v === 'string' ? RETIRED_KINDS[v] : undefined;
  return `kind must be one of ${WORK_KINDS.join(', ')}${retired ? ` (${retired})` : ''}`;
}
