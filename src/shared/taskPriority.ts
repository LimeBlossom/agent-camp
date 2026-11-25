/**
 * A card's priority. tasks.json stores only these words: openCards ranks by them, and a
 * number on disk used to rank as medium whatever it meant.
 */
export const TASK_PRIORITIES = ['high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const DEFAULT_PRIORITY: TaskPriority = 'medium';

const HIGH_FROM = 4;
const LOW_UP_TO = 2;

export function isTaskPriority(p: unknown): p is TaskPriority {
  return typeof p === 'string' && (TASK_PRIORITIES as readonly string[]).includes(p);
}

/** The level of any stored or incoming priority. A number is read on the kanban's
 *  1 (lowest) to 5 (highest) dot scale; anything unreadable is medium. */
export function priorityLevel(p: unknown): TaskPriority {
  if (typeof p === 'string') {
    const word = p.trim().toLowerCase();
    return isTaskPriority(word) ? word : DEFAULT_PRIORITY;
  }
  if (typeof p === 'number' && Number.isFinite(p)) return p >= HIGH_FROM ? 'high' : p <= LOW_UP_TO ? 'low' : 'medium';
  return DEFAULT_PRIORITY;
}

/** Sort key: high first. */
export function priorityRank(p: unknown): number {
  return TASK_PRIORITIES.indexOf(priorityLevel(p));
}

const MIN_DOTS = 1;
const MAX_DOTS = 5;
const DOTS: Record<TaskPriority, number> = { high: MAX_DOTS, medium: 3, low: MIN_DOTS };

/** Dots on the kanban's 1 (lowest) to 5 (highest) scale. A number keeps its own count. */
export function priorityDots(p: unknown): number {
  if (typeof p === 'number' && Number.isFinite(p)) return Math.max(MIN_DOTS, Math.min(MAX_DOTS, Math.round(p)));
  return DOTS[priorityLevel(p)];
}
