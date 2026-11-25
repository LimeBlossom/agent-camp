/**
 * Card nicknames for short UI spots (thought bubbles, side panels, ASK ME dialogs).
 *
 * Full card titles belong on the kanban board; in constrained UI dialogs and
 * thought bubbles, long titles either blow out the container or get cut off with
 * janky ellipsis mid-word. A nickname is an optional short handle (max ~20 chars,
 * 1-3 words) on the task card. When unset, deriveNickname derives one automatically
 * by dropping project prefixes and picking the first meaningful words without
 * ever cutting mid-word or adding an ellipsis.
 */

export const MAX_NICKNAME_CHARS = 20;
export const MAX_NICKNAME_WORDS = 3;

const LEADING_ARTICLES = new Set(['the', 'a', 'an']);

const TRAILING_STOP_WORDS = new Set([
  'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with',
  'by', 'from', 'the', 'a', 'an', 'that', 'this', 'so',
  'as', 'at', 'but'
]);

/**
 * Drop common project or issue prefixes:
 * - "[Project] Title" or "(Project) Title"
 * - "Project: Title" or "Alpha junk tower: Title" or "Delta phase 1: Title"
 */
export function stripProjectPrefix(title: string): string {
  let s = title.trim();
  // Strip bracketed tag at start: "[Studio] foo" or "(Alpha) foo"
  s = s.replace(/^[\[(][^\])]+[\])]\s*/, '');
  // Strip prefix ending with a colon or dash followed by whitespace:
  // "Alpha: foo", "Delta phase 1: foo", "Gamma VR: foo", "Follow-up: foo"
  const m = s.match(/^[A-Za-z0-9+._/ -]+?[:–—]\s+(.*)$/);
  if (m && m[1] && m[1].trim()) {
    s = m[1].trim();
  }
  return s;
}

/** Clean punctuation and quotes from around a word token. */
function cleanWord(w: string): string {
  // Standalone symbols/punctuation like "+", "&", "/" are not words
  if (!/[A-Za-z0-9]/.test(w)) return '';
  return w
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .trim();
}

/** Capitalize the very first character if it's a lowercase ASCII letter. */
function capitalizeFirst(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Validate a candidate nickname string.
 * Must be <= 20 chars and at most 3 words.
 */
export function isValidNickname(nick: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof nick !== 'string') return { ok: false, reason: 'nickname must be text' };
  const trimmed = nick.trim();
  if (!trimmed) return { ok: true, value: '' };
  if (trimmed.length > MAX_NICKNAME_CHARS) {
    return { ok: false, reason: `nickname must be at most ${MAX_NICKNAME_CHARS} characters` };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > MAX_NICKNAME_WORDS) {
    return { ok: false, reason: `nickname must be at most ${MAX_NICKNAME_WORDS} words` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Derive a short nickname (~20 chars, 1-3 words) from a full card title.
 * Never cuts mid-word; never emits ellipsis.
 */
export function deriveNickname(title: unknown, maxChars = MAX_NICKNAME_CHARS): string {
  if (typeof title !== 'string') return '';
  const stripped = stripProjectPrefix(title);
  if (!stripped) return '';

  const rawWords = stripped.split(/\s+/).map(cleanWord).filter(Boolean);
  if (!rawWords.length) return '';

  // Drop leading articles if there are subsequent words
  let words = rawWords;
  if (words.length > 1 && LEADING_ARTICLES.has(words[0].toLowerCase())) {
    words = words.slice(1);
  }
  if (!words.length) return '';

  // Accumulate 1 to 3 words under the maxChars ceiling
  const chosen: string[] = [words[0]];
  for (let i = 1; i < words.length && chosen.length < MAX_NICKNAME_WORDS; i++) {
    const candidate = chosen.join(' ') + ' ' + words[i];
    if (candidate.length <= maxChars) {
      chosen.push(words[i]);
    } else {
      break;
    }
  }

  // If the last word is a connector/stop word, drop it if > 1 word remains
  while (chosen.length > 1 && TRAILING_STOP_WORDS.has(chosen[chosen.length - 1].toLowerCase())) {
    chosen.pop();
  }

  return capitalizeFirst(chosen.join(' '));
}

export interface CardWithNickname {
  title?: unknown;
  nickname?: unknown;
  id?: unknown;
}

/**
 * Get the effective short nickname for a card.
 * Uses the explicit nickname if set, otherwise derives one from the title.
 */
export function cardNickname(card: CardWithNickname | string | null | undefined): string {
  if (!card) return '';
  if (typeof card === 'string') return deriveNickname(card);
  if (typeof card.nickname === 'string' && card.nickname.trim()) {
    return card.nickname.trim();
  }
  return deriveNickname(typeof card.title === 'string' ? card.title : '');
}
