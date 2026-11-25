import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_DIGEST_CAP } from '../shared/dormantWake';

const DATED = /^## +(\d{4}-\d{2}-\d{2})/;

function isSurrogatePairSplit(str: string, index: number): boolean {
  if (index <= 0 || index >= str.length) return false;
  const prev = str.charCodeAt(index - 1);
  const curr = str.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff;
}

/** memory.md cut back toward `cap` by moving whole dated `## YYYY-MM-DD ...` sections out,
 *  oldest date first. Undated sections (standing rules, gotchas, open threads) and the
 *  newest dated section always stay. Null when nothing needs to or can move; the result
 *  may still be over `cap`, and the agent's own archive step does the rest. */
export function trimMemoryDigest(text: string, cap = MEMORY_DIGEST_CAP): { keep: string; moved: string } | null {
  if (text.length < cap) return null;

  const headingRegex = /^## +/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(text)) !== null) {
    starts.push(m.index);
  }
  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b);
  if (uniqueStarts.length === 0 || uniqueStarts[0] > 0) {
    uniqueStarts.unshift(0);
  }

  interface Sec {
    id: number;
    start: number;
    end: number;
    date: string | null;
    raw: string;
  }

  const sections: Sec[] = [];
  for (let i = 0; i < uniqueStarts.length; i++) {
    const start = uniqueStarts[i];
    const end = i + 1 < uniqueStarts.length ? uniqueStarts[i + 1] : text.length;
    const raw = text.slice(start, end);
    const firstLine = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'));
    const dateMatch = DATED.exec(firstLine);
    sections.push({
      id: i,
      start,
      end,
      date: dateMatch ? dateMatch[1] : null,
      raw
    });
  }

  const dated = sections.filter((s) => s.date !== null);
  const datedCandidates: Sec[] = [];
  if (dated.length >= 2) {
    const newest = dated.reduce((a, b) => (b.date! >= a.date! ? b : a));
    datedCandidates.push(
      ...dated
        .filter((s) => s !== newest)
        .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : a.id - b.id))
    );
  }

  const movedWhole = new Set<number>();
  let currentKeep = text.length;

  for (const s of datedCandidates) {
    if (currentKeep < cap) break;
    movedWhole.add(s.id);
    currentKeep -= s.raw.length;
  }

  const cutSuffix = new Map<number, number>();
  const targetCap = Math.min(cap, MEMORY_DIGEST_CAP);
  if (currentKeep >= cap && (currentKeep >= MEMORY_DIGEST_CAP || datedCandidates.length === 0)) {
    const remaining = sections.filter((s) => !movedWhole.has(s.id));
    const undatedNonHeader = remaining.filter((s) => s.id !== 0 && s.date === null);
    const fallbackCandidates = remaining.filter((s) => !undatedNonHeader.includes(s));
    const furtherCandidates = [...undatedNonHeader, ...fallbackCandidates];

    for (const s of furtherCandidates) {
      if (currentKeep < targetCap) break;
      const needed = currentKeep - targetCap + 1;
      if (s.raw.length <= needed) {
        movedWhole.add(s.id);
        currentKeep -= s.raw.length;
      } else {
        let cutLen = needed;
        let cutPoint = s.raw.length - cutLen;
        if (isSurrogatePairSplit(s.raw, cutPoint)) {
          cutPoint--;
          cutLen = s.raw.length - cutPoint;
        }
        if (cutPoint === 0) {
          movedWhole.add(s.id);
          currentKeep -= s.raw.length;
        } else {
          cutSuffix.set(s.id, cutLen);
          currentKeep -= cutLen;
          break;
        }
      }
    }
  }

  if (movedWhole.size === 0 && cutSuffix.size === 0) return null;

  let keep = '';
  let moved = '';

  for (const s of sections) {
    if (movedWhole.has(s.id)) {
      moved += s.raw;
    } else if (cutSuffix.has(s.id)) {
      const cutLen = cutSuffix.get(s.id)!;
      keep += s.raw.slice(0, s.raw.length - cutLen);
      moved += s.raw.slice(s.raw.length - cutLen);
    } else {
      keep += s.raw;
    }
  }

  return { keep, moved };
}

/** Apply trimMemoryDigest to an agent folder: the moved sections are APPENDED to
 *  memory-archive.md first, then memory.md is rewritten through a temp file. Returns the
 *  number of characters moved (0 when nothing changed). */
export function trimMemoryFile(agentDir: string, today: string, cap = MEMORY_DIGEST_CAP): number {
  const memPath = join(agentDir, 'memory.md');
  let text: string;
  try { text = readFileSync(memPath, 'utf8'); } catch { return 0; }
  const r = trimMemoryDigest(text, cap);
  if (!r) return 0;
  appendFileSync(join(agentDir, 'memory-archive.md'), `\n\n## Archived from memory.md ${today} (harness digest trim)\n\n${r.moved}\n`, 'utf8');
  const tmp = `${memPath}.trim-tmp`;
  writeFileSync(tmp, r.keep, 'utf8');
  renameSync(tmp, memPath);
  return r.moved.length;
}
