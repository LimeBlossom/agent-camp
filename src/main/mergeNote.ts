export const AWAITING_MERGE = /awaiting\b.*?\bmerge/i;
const NOT_AWAITING = /\b(?:not|no longer)\s+awaiting\b/i;

/** True when the card's latest note (last array entry, or last non-empty line of a
 *  string) says it waits on the Boss to merge. Earlier notes are superseded. */
export function latestNoteAwaitingMerge(notes: unknown): boolean {
  const entries = Array.isArray(notes)
    ? notes.filter((n): n is string => typeof n === 'string')
    : typeof notes === 'string' ? notes.split('\n') : [];
  const last = entries.map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return AWAITING_MERGE.test(last) && !NOT_AWAITING.test(last);
}
