import { latestNoteAwaitingMerge } from './mergeNote';

type Raw = Record<string, unknown>;

/** The note the harness appends when it parks a card on a worker's done message. */
export const AUTO_BLOCK_NOTE = 'awaiting boss merge (auto: done message)';

export interface DoneMessageLike {
  act?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  conversation?: unknown;
}

const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** True when `id` appears in `text` as a whole card id, not as part of a longer one. */
function mentions(text: string, id: string): boolean {
  let at = text.indexOf(id);
  while (at >= 0) {
    const before = at === 0 ? '' : text[at - 1];
    const after = text[at + id.length] ?? '';
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
    at = text.indexOf(id, at + 1);
  }
  return false;
}

/** The task-patch body that parks a worker's card after its done message to the Boss,
 *  or null when nothing should change. The card is the sender's open card the message
 *  names (subject, body or conversation), else its only `doing` card. A card without a
 *  brief, or already blocked or done, is left alone: the brief rule and the Boss's
 *  own close stay exactly as they are. */
export function doneAutoBlockPatch(sender: string, msg: DoneMessageLike, tasks: readonly unknown[], isBossTarget: (to: string) => boolean): { id: string; status: 'blocked'; notesAppend: string } | null {
  if (msg.act !== 'done' || typeof msg.to !== 'string' || !isBossTarget(msg.to)) return null;
  const mine = tasks.filter((t): t is Raw => isRaw(t) && typeof t.id === 'string' && t.assignee === sender);
  const open = mine.filter((t) => t.status === 'doing' || t.status === 'todo');
  const text = [msg.subject, msg.body, msg.conversation].filter((v): v is string => typeof v === 'string').join('\n');
  const named = open.filter((t) => mentions(text, t.id as string));
  const doing = open.filter((t) => t.status === 'doing');
  const card = named.length === 1 ? named[0] : named.length === 0 && doing.length === 1 ? doing[0] : null;
  if (!card || !hasText(card.brief)) return null;
  if (latestNoteAwaitingMerge(card.notes)) return null;
  return { id: card.id as string, status: 'blocked', notesAppend: AUTO_BLOCK_NOTE };
}
