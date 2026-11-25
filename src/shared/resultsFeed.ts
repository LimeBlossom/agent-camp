/**
 * Results: what the human should see but never has to answer (answers to their own
 * questions, final checks that passed). They live on the card as `results[]`,
 * apart from `humanQA`, so ASK ME lists only decisions that block work.
 */

export const ASK_KINDS = ['decision', 'result'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** `answer`: the reply to a question the human asked. `check`: a final check that passed. */
export const RESULT_LABELS = ['answer', 'check'] as const;
export type ResultLabel = (typeof RESULT_LABELS)[number];

export function isResultLabel(v: unknown): v is ResultLabel {
  return typeof v === 'string' && (RESULT_LABELS as readonly string[]).includes(v);
}

export interface CardResult {
  text: string;
  label: ResultLabel;
  at: string;
  seenAt?: string;
}

export interface ResultFeedItem {
  cardId: string;
  title: string;
  project: string;
  text: string;
  label: ResultLabel;
  at: string;
  seen: boolean;
}

interface CardLike {
  id?: unknown;
  title?: unknown;
  project?: unknown;
  results?: unknown;
}

export function isCardResult(e: unknown): e is CardResult {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return typeof r.text === 'string' && r.text.trim().length > 0 && isResultLabel(r.label) && typeof r.at === 'string';
}

/** Every well-formed result on every card, newest first. */
export function resultsFeed(tasks: readonly unknown[]): ResultFeedItem[] {
  const out: ResultFeedItem[] = [];
  for (const raw of tasks) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as CardLike;
    if (typeof t.id !== 'string' || !Array.isArray(t.results)) continue;
    for (const r of t.results) {
      if (!isCardResult(r)) continue;
      out.push({
        cardId: t.id,
        title: typeof t.title === 'string' ? t.title : '',
        project: typeof t.project === 'string' ? t.project : '',
        text: r.text,
        label: r.label,
        at: r.at,
        seen: typeof r.seenAt === 'string' && r.seenAt.length > 0
      });
    }
  }
  const ms = (s: string) => Date.parse(s) || 0;
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

export function unseenResultCount(tasks: readonly unknown[]): number {
  return resultsFeed(tasks).filter((r) => !r.seen).length;
}

/** Wording that hands the human a call to make. A result never asks; a question goes to humanQAAppend. */
const QUESTION_SHAPES: readonly RegExp[] = [
  /\bsay so if\b/i,
  /\b(?:let me know|tell me|shout) if\b/i,
  /\bwant (?:[\w'-]+ ){0,4}back\?/i,
  /\b(?:do|would) you (?:want|like|prefer)\b/i,
  /\bshould (?:I|we)\b[^.!\n]*\?/i,
  /\bif you(?:'d| would)? (?:rather|prefer)\b/i
];

/** The question-shaped phrase in a result's text, or null when it only reports. */
export function questionShapedResult(text: string): string | null {
  for (const re of QUESTION_SHAPES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** The result text as a markdown blockquote. */
export function quoteResult(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}
