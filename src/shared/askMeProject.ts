/**
 * Which project an ASK ME card belongs to, for the board's project filter. The
 * card's own `project` wins; otherwise the title's "Project: …" prefix, which is how
 * the Boss has always named cards. Pure, so test/ask-me-project.test.cjs can pin it.
 */

/** The bucket for cards with neither a `project` nor a title prefix. */
export const OTHER_PROJECT = 'Other';

/** A prefix longer than this many words is a sentence with a colon, not a project. */
const MAX_PREFIX_WORDS = 3;

export function projectOf(task: { project?: unknown; title?: unknown }): string {
  if (typeof task.project === 'string' && task.project.trim()) return task.project.trim();
  const title = typeof task.title === 'string' ? task.title : '';
  const colon = title.indexOf(':');
  if (colon <= 0) return OTHER_PROJECT;
  const words = title.slice(0, colon).trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_PREFIX_WORDS) return OTHER_PROJECT;
  // "Alpha content: …" and "Alpha: …" are the same project.
  return words[0];
}

/** Projects with their card counts, busiest first, Other last. */
export function projectCounts(tasks: ReadonlyArray<{ project?: unknown; title?: unknown }>): Array<{ project: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    const p = projectOf(t);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts]
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => (a.project === OTHER_PROJECT ? 1 : 0) - (b.project === OTHER_PROJECT ? 1 : 0)
      || b.count - a.count || a.project.localeCompare(b.project));
}
