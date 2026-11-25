import { isBacklogged } from '../shared/backlog';
import { getUnmetDependencies, type TaskLike } from '../shared/taskDeps';
import { AWAITING_MERGE, latestNoteAwaitingMerge } from './mergeNote';
import { humanWords } from './humanName';

export const AWAITING_MERGE_RE = AWAITING_MERGE;

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** Notes indicating a card is held pending the human's decision, direction, or ask. */
export function humanAskRe(env: Record<string, string | undefined> = process.env): RegExp {
  const h = humanWords(env);
  return new RegExp(`(?:awaiting\\b.*?\\b${h}|waiting\\b.*?\\bon\\s+${h}|blocked\\b.*?\\bon\\s+${h}|blocked\\b.*?\\buntil\\s+${h}|${h}\\b.*?\\bask|ask\\b.*?\\b${h}|ask\\s+me\\b|paused\\s+by\\s+${h}|parked\\b.*?\\b${h})`, 'i');
}

/** True when the card has an open (unanswered, undismissed) humanQA question. */
export function hasOpenHumanQA(card: Raw): boolean {
  if (!Array.isArray(card.humanQA)) return false;
  return card.humanQA.some((q) => {
    if (!isRaw(q)) return false;
    return !hasText(q.a) && !q.dismissedAt;
  });
}

/** True when the card was blocked for reasons other than pending dependencies:
 *  an open humanQA question, a latest note awaiting boss merge, notes
 *  indicating an ask or wait on the human, or being shelved in the Backlog. */
export function isHeldByOtherReason(card: Raw): boolean {
  if (isBacklogged(card)) return true;
  if (hasOpenHumanQA(card)) return true;
  const notesStr = Array.isArray(card.notes)
    ? card.notes.join('\n')
    : typeof card.notes === 'string'
      ? card.notes
      : '';
  if (latestNoteAwaitingMerge(card.notes)) return true;
  if (humanAskRe().test(notesStr)) return true;
  return false;
}

export interface AutoUnblockPlanItem {
  id: string;
  assignee?: string;
  dependsOn: string[];
  patch: { status: 'todo' };
}

/** Check if a single task is eligible to be auto-unblocked to 'todo'. */
export function isAutoUnblockEligible(card: unknown, allTasks: readonly unknown[]): boolean {
  if (!isRaw(card) || typeof card.id !== 'string') return false;
  if (card.status !== 'blocked') return false;
  if (!Array.isArray(card.dependsOn) || card.dependsOn.length === 0) return false;
  if (isHeldByOtherReason(card)) return false;

  const validCards = allTasks.filter(isRaw) as TaskLike[];
  const unmet = getUnmetDependencies(card as TaskLike, validCards);
  return unmet.length === 0;
}

/** Plan auto-unblocks for all eligible blocked cards whose dependsOn are ALL done
 *  and which are not held for any other reason. Returns the items to patch. */
export function planAutoUnblock(tasks: readonly unknown[]): AutoUnblockPlanItem[] {
  const cards = tasks.filter(isRaw);
  const out: AutoUnblockPlanItem[] = [];

  for (const card of cards) {
    if (typeof card.id !== 'string') continue;
    if (isAutoUnblockEligible(card, tasks)) {
      out.push({
        id: card.id,
        assignee: typeof card.assignee === 'string' ? card.assignee : undefined,
        dependsOn: (card.dependsOn as string[]).slice(),
        patch: { status: 'todo' }
      });
    }
  }

  return out;
}
