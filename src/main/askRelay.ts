/**
 * ASK ME answers relayed by Claude sessions outside the hive. answer_ask on the camp-propose
 * MCP (cardProposals.ts) checks the card and drops one JSON file into <hive>/ask-answers/;
 * main applies it with the same patchTask + routeHumanAnswer path the desktop ASK ME uses,
 * so the harness stays the only writer of tasks.json. Runs under plain node: no electron.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ASK_ANSWERS_DIR = 'ask-answers';
/** Provenance on a relayed humanQA entry, so the Boss can tell it from one the human typed in the UI. */
export const RELAY_VIA = 'camp-propose';

type Raw = Record<string, unknown>;
interface QA { q: string; a?: unknown; dismissedAt?: unknown; askedAt?: unknown; [k: string]: unknown }

export interface OpenAsk { cardId: string; title: string; status: string; assignee: string; question: string; askedAt?: string }

export interface RelayedAnswer { cardId: string; q: string; answer: string; via: string; source: string; relayedAt: string }

export interface ApplyDeps {
  tasks: () => unknown;
  patchTask: (id: string, patch: { humanQA: unknown[] }) => boolean;
  routeAnswer: (id: string, q: string, a: string) => void;
  /** A queued answer that can no longer land (its question was answered, dismissed or replaced). */
  reject: (relay: RelayedAnswer, reason: string) => void;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

function cardsOf(raw: unknown): Raw[] {
  const list = isRaw(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  return list.filter((t): t is Raw => isRaw(t) && typeof t.id === 'string');
}

function readLedger(hiveRoot: string): Raw[] {
  return cardsOf(JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8')));
}

/** The ASK ME definition (TasksKanban.openQuestion): the latest entry neither answered nor dismissed. */
function openQuestion(card: Raw): QA | undefined {
  const qa = Array.isArray(card.humanQA) ? card.humanQA : [];
  for (let i = qa.length - 1; i >= 0; i--) {
    const e = qa[i] as QA;
    if (isRaw(e) && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

export function listOpenAsks(hiveRoot: string): OpenAsk[] {
  const out: OpenAsk[] = [];
  for (const card of readLedger(hiveRoot)) {
    const open = openQuestion(card);
    if (!open) continue;
    out.push({
      cardId: card.id as string, title: str(card.title), status: str(card.status), assignee: str(card.assignee),
      question: open.q, ...(typeof open.askedAt === 'string' ? { askedAt: open.askedAt } : {})
    });
  }
  return out;
}

let relaySeq = 0;

export function writeAskAnswer(
  hiveRoot: string,
  args: Raw,
  source: string,
  now = new Date()
): { ok: boolean; cardId?: string; question?: string; path?: string; error?: string } {
  const cardId = str(args.cardId);
  const answer = str(args.answer);
  if (!cardId) return { ok: false, error: 'cardId is required' };
  if (!answer) return { ok: false, error: 'answer is required' };
  if (!hiveRoot || !fs.existsSync(hiveRoot)) return { ok: false, error: `hive root not found: ${hiveRoot || '(HIVE_ROOT unset)'}` };
  const card = readLedger(hiveRoot).find((t) => t.id === cardId);
  if (!card) return { ok: false, error: `unknown card id: ${cardId}` };
  const open = openQuestion(card);
  if (!open) return { ok: false, error: `card ${cardId} has no open ASK ME` };
  const relay: RelayedAnswer = { cardId, q: open.q, answer, via: RELAY_VIA, source, relayedAt: now.toISOString() };
  const dir = path.join(hiveRoot, ASK_ANSWERS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  relaySeq = (relaySeq + 1) % 1_000_000;
  const file = path.join(dir, `${now.getTime()}-${process.pid}-${relaySeq}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(relay, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  return { ok: true, cardId, question: open.q, path: file };
}

function moveTo(dir: string, sub: string, f: string): void {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.renameSync(path.join(dir, f), path.join(dir, sub, f));
}

/** Applies each queued answer; returns how many landed. A failed ledger write leaves the file for the next tick. */
export function applyAskAnswers(hiveRoot: string, deps: ApplyDeps): number {
  const dir = path.join(hiveRoot, ASK_ANSWERS_DIR);
  if (!hiveRoot || !fs.existsSync(dir)) return 0;
  let applied = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let relay: RelayedAnswer;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Raw;
      if (!str(raw.cardId) || typeof raw.q !== 'string' || !str(raw.answer)) throw new Error('malformed');
      relay = { cardId: str(raw.cardId), q: raw.q, answer: str(raw.answer), via: RELAY_VIA, source: str(raw.source), relayedAt: str(raw.relayedAt) };
    } catch {
      moveTo(dir, '.failed', f);
      continue;
    }
    const card = cardsOf(deps.tasks()).find((t) => t.id === relay.cardId);
    const open = card && openQuestion(card);
    // Re-located by text, as the phone and desktop do, so an answer never lands on a question swapped in since it was queued.
    if (!card || !open || open.q !== relay.q) {
      deps.reject(relay, card ? 'the question is no longer open (answered, dismissed or replaced since it was relayed)' : 'the card no longer exists');
      moveTo(dir, '.failed', f);
      continue;
    }
    const answeredAt = new Date().toISOString();
    const qa = (card.humanQA as unknown[]).map((e) => (e === open ? { ...open, a: relay.answer, answeredAt, via: RELAY_VIA, relayedFrom: relay.source } : e));
    if (!deps.patchTask(relay.cardId, { humanQA: qa })) continue;
    moveTo(dir, '.done', f);
    deps.routeAnswer(relay.cardId, relay.q, relay.answer);
    applied++;
  }
  return applied;
}
