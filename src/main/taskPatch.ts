/**
 * Card edits that agents send through their outbox instead of writing tasks.json.
 *
 * An outbox message with act "task-patch" (or "task-create", Boss only) carries the
 * edit in its body; the router applies it with HiveManager.patchTask/addTask, so the
 * harness is the only writer of the ledger. planTaskMessage decides what to write
 * and never touches disk, so the rules are unit-testable.
 */

import { DIFFICULTIES, isDifficulty } from '../shared/difficulty';
import { artCodeKindError, isWorkKind, workKindError } from '../shared/workKind';
import { CARD_NEEDS, isCardNeeds } from '../shared/cardNeeds';
import { isBacklogged } from '../shared/backlog';
import { retireSupersededAsks } from '../shared/taskLedger';
import { RESULT_LABELS, isResultLabel, questionShapedResult } from '../shared/resultsFeed';
import { validateDependencies, canStartTask, type TaskLike } from '../shared/taskDeps';
import { TASK_PRIORITIES, isTaskPriority } from '../shared/taskPriority';
import { validateApproveAction, headOnBranch } from './approvedMerge';

export const TASK_ACTS = ['task-patch', 'task-create'] as const;
export type TaskAct = (typeof TASK_ACTS)[number];

/** the human's answer that passes a card rather than sending it back. */
export const APPROVAL_ANSWER = /^\s*(?:approved?|looks good|ship it|lgtm|yes,? approved)\b/i;
import { AWAITING_MERGE, latestNoteAwaitingMerge } from './mergeNote';
export { AWAITING_MERGE, latestNoteAwaitingMerge };

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;

export function isTaskAct(act: unknown): act is TaskAct {
  return typeof act === 'string' && (TASK_ACTS as readonly string[]).includes(act);
}

type Raw = Record<string, unknown>;

/** Fields a worker may send for a card assigned to it. */
const WORKER_PATCH = new Set(['id', 'status', 'notesAppend', 'result', 'nickname', 'brief', 'briefAppend', 'testsReady', 'escalate']);
/** The Boss may also re-plan a card. */
const BOSS_PATCH = new Set([...WORKER_PATCH, 'title', 'description', 'assignee', 'priority', 'project', 'dependsOn', 'notes', 'humanQAAppend', 'resultsAppend', 'difficulty', 'difficultyReason', 'kind', 'kindReason', 'needs', 'backloggedAt', 'fence', 'netAllow', 'approveAction', 'merge']);
const BOSS_CREATE = new Set([...BOSS_PATCH].filter((f) => f !== 'notesAppend' && f !== 'briefAppend' && f !== 'resultsAppend' && f !== 'approveAction' && f !== 'testsReady' && f !== 'merge'));

export type TaskPlan =
  | { ok: true; kind: 'patch'; id: string; patch: Raw; fields: string[] }
  | { ok: true; kind: 'create'; id: string; card: Raw; fields: string[] }
  | { ok: false; id?: string; reason: string };

export interface TaskMessageInput {
  act: TaskAct;
  /** Projects marked artPipeline in projects.json. */
  artProjects?: ReadonlySet<string>;
  /** The message body: an object, or a JSON string of one. */
  body: unknown;
  sender: string;
  isBoss: boolean;
  /** The current ledger cards. */
  tasks: readonly unknown[];
  now: string;
  /** Closing time is running: no edit may start a worker on a card. */
  closingTime?: boolean;
  /** The full sha when `head` is a commit on `branch` in `worktree`; tests inject it. */
  headOnBranch?: (worktree: string, branch: string, head: string) => string | null;
}

/** What closing time refuses, from any sender: workers have packed up, so a card
 *  assigned or (re)opened now would only start work the floor is shutting down on. */
const CLOSING_REFUSAL = 'wrap-up is in progress, so cards cannot be assigned or moved to todo/doing until it ends; park with notes, result, blocked or done instead';

/** the human's rule: the Boss closes cards after reviewing and merging the work. */
const DONE_REFUSAL = 'only the Boss sets a card to done; send the Boss a done message (sha, tests, evidence) and set the card blocked with the note "awaiting boss merge"';

const CLOSED_REFUSAL = (id: string): string => `card ${id} is already done (closed by the Boss); a worker cannot change its status. Ask the Boss to reopen it if work remains`;

/** A worker moving a card to done or awaiting merge must record what was done and what is left. */
const BRIEF_REFUSAL = 'write the card\'s "brief" before moving it to awaiting boss merge; record what was done, files/branches/commits, gotchas, decisions, how to verify, and what is left';

/** The Boss closed a tests-first card whose tests left proposal steps uncovered, with nothing visible picking them up. */
const UNCOVERED_REFUSAL = (steps: string, id: string): string => `card ${id} cannot be closed: its tests-first handoff left these proposal steps uncovered: ${steps}. Send it back (status doing), or create a visible follow-up card that depends on ${id} or names it in its description, or record in this patch's result or notesAppend a line starting "Coverage:" that maps every original numbered step to the shipped commit and its test or evidence`;

const NO_UNCOVERED = /^\W*none\b\W*$/i;
const COVERAGE_LINE = /^\s*coverage:/im;

/** The uncovered steps a done patch must answer for, or null when closing is fine. */
function openUncovered(card: Raw, b: Raw, cards: Raw[]): string | null {
  if (b.merge === false || card.merge === false) return null;
  const ready = card.testsReady;
  if (!isRaw(ready) || typeof ready.uncovered !== 'string') return null;
  const steps = ready.uncovered.trim();
  if (!steps || NO_UNCOVERED.test(steps)) return null;
  const id = String(card.id);
  const followUp = cards.some((c) => c.id !== id && (
    (Array.isArray(c.dependsOn) && c.dependsOn.includes(id)) ||
    (typeof c.description === 'string' && c.description.includes(id))
  ));
  if (followUp) return null;
  if ([b.result, b.notesAppend].some((v) => typeof v === 'string' && COVERAGE_LINE.test(v))) return null;
  return steps;
}

/** A shelved card must never wake its assignee, so todo/doing waits until the shelf mark is cleared. */
const BACKLOG_REFUSAL = 'this card is in the Backlog, so it cannot be moved to todo/doing; the human brings it back from the Backlog tab, or the Boss sends "backloggedAt": null (with the new status) when the human asks';

const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function parseBody(body: unknown): Raw | null {
  if (isRaw(body)) return body;
  if (typeof body !== 'string') return null;
  try {
    const v = JSON.parse(body) as unknown;
    return isRaw(v) ? v : null;
  } catch { return null; }
}

const TESTS_READY_FORM = 'testsReady must be {"branch": "<branch>", "worktree": "<absolute path>", "head": "<commit sha>", "uncovered": "<original proposal steps these tests do not cover, or none>", "then"?: "implement"|"handoff"}';
const SHA = /^[0-9a-f]{7,40}$/i;
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
export const TESTS_READY_THEN = ['implement', 'handoff'] as const;

function badTestsReady(v: unknown): string | null {
  if (!isRaw(v)) return TESTS_READY_FORM;
  const extra = Object.keys(v).filter((k) => !['branch', 'worktree', 'head', 'then', 'uncovered'].includes(k));
  if (extra.length) return `testsReady field not allowed: ${extra.join(', ')}`;
  if (typeof v.branch !== 'string' || !REF.test(v.branch)) return 'testsReady needs branch, a plain branch name';
  if (typeof v.worktree !== 'string' || !v.worktree.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(v.worktree)) return 'testsReady worktree must be an absolute path';
  if (typeof v.head !== 'string' || !SHA.test(v.head)) return 'testsReady head must be a commit sha';
  if (typeof v.uncovered !== 'string' || !v.uncovered.trim()) return 'testsReady needs "uncovered": the numbered steps of the original proposal or brief that these tests do not cover (write "none" only if every step has a test)';
  if (v.then !== undefined && !(TESTS_READY_THEN as readonly unknown[]).includes(v.then)) return 'testsReady then must be "implement" or "handoff"';
  return null;
}

/** The first field with a wrong type, as a reason, or null. */
function badField(b: Raw): string | null {
  if (b.status !== undefined && !(TASK_STATUSES as readonly unknown[]).includes(b.status)) {
    return `status must be one of ${TASK_STATUSES.join(', ')}`;
  }
  for (const f of ['notesAppend', 'briefAppend', 'title']) if (b[f] !== undefined && !text(b[f])) return `${f} must be non-empty text`;
  for (const f of ['result', 'description', 'assignee', 'project', 'notes', 'brief']) if (b[f] !== undefined && typeof b[f] !== 'string') return `${f} must be text`;
  if (b.nickname !== undefined && b.nickname !== null) {
    if (typeof b.nickname !== 'string') return 'nickname must be text';
    const trimmed = b.nickname.trim();
    if (trimmed.length > 20) return 'nickname must be at most 20 characters';
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length > 3) return 'nickname must be at most 3 words';
  }
  if (b.priority !== undefined && !isTaskPriority(typeof b.priority === 'string' ? b.priority.trim().toLowerCase() : b.priority)) return `priority must be one of ${TASK_PRIORITIES.join(', ')}`;
  if (b.difficulty !== undefined && b.difficulty !== null && !isDifficulty(b.difficulty)) return `difficulty must be one of ${DIFFICULTIES.join(', ')}, or null to clear it`;
  if (b.kind !== undefined && b.kind !== null && !isWorkKind(b.kind)) return `${workKindError(b.kind)}, or null to clear it`;
  if (b.needs !== undefined && b.needs !== null && !isCardNeeds(b.needs)) return `needs must be a list of ${CARD_NEEDS.join(', ')}, or null to clear it`;
  if (b.backloggedAt !== undefined && b.backloggedAt !== null && !text(b.backloggedAt)) return 'backloggedAt must be an ISO time, or null to bring the card back';
  if (b.dependsOn !== undefined && !(Array.isArray(b.dependsOn) && b.dependsOn.every((d) => typeof d === 'string'))) return 'dependsOn must be a list of card ids';
  if (b.fence !== undefined && !(Array.isArray(b.fence) && b.fence.every((g) => typeof g === 'string' && g.trim().length > 0))) return 'fence must be a list of non-empty strings';
  if (b.netAllow !== undefined && !(Array.isArray(b.netAllow) && b.netAllow.every((h) => typeof h === 'string' && h.trim().length > 0))) return 'netAllow must be a list of host names';
  if (b.humanQAAppend !== undefined) {
    const qa = b.humanQAAppend;
    if (!isRaw(qa) || !text(qa.q) || (qa.askedAt !== undefined && typeof qa.askedAt !== 'string')) return 'humanQAAppend must be {"q": "...", "askedAt"?: "<iso>"}';
  }
  if (b.resultsAppend !== undefined) {
    const r = b.resultsAppend;
    if (!isRaw(r) || !text(r.text) || !isResultLabel(r.label)) return `resultsAppend must be {"text": "...", "label": ${RESULT_LABELS.map((l) => `"${l}"`).join(' | ')}}`;
    const asks = questionShapedResult(String(r.text));
    if (asks) return `resultsAppend text asks for the human's call ("${asks}"); a result has nothing to answer. Send the question as humanQAAppend {"q": "..."} and set the card blocked`;
  }
  if (b.approveAction !== undefined && b.approveAction !== null) {
    const bad = validateApproveAction(b.approveAction);
    if (bad) return bad;
    if (b.humanQAAppend === undefined) return 'approveAction must come with the humanQAAppend question it belongs to';
  }
  if (b.difficultyReason !== undefined && typeof b.difficultyReason !== 'string') return 'difficultyReason must be text';
  if (b.kindReason !== undefined && typeof b.kindReason !== 'string') return 'kindReason must be text';
  if (b.merge !== undefined && typeof b.merge !== 'boolean') return 'merge must be a boolean';
  if (b.testsReady !== undefined) {
    const bad = badTestsReady(b.testsReady);
    if (bad) return bad;
  }
  if (b.escalate !== undefined && !(isRaw(b.escalate) && text(b.escalate.reason))) return ESCALATE_FORM;
  return null;
}

const ESCALATE_FORM = 'escalate needs a reason: {"escalate": {"reason": "<why a strong model is not enough>"}}';
const ESCALATE_HARD = 'only a hard card escalates to top; ask the Boss to mark it hard';

/** Copy the plain fields of `b` that `apply` folds in specially. */
function plainFields(b: Raw): Raw {
  const out: Raw = {};
  for (const [k, v] of Object.entries(b)) if (k !== 'id' && k !== 'notesAppend' && k !== 'briefAppend' && k !== 'humanQAAppend' && k !== 'resultsAppend') out[k] = v;
  delete out.escalate;
  return out;
}

function withAppends(card: Raw, b: Raw, now: string, sender: string, fullHead?: string): Raw | string {
  const out = plainFields(b);
  if (isRaw(b.testsReady)) {
    out.testsReady = { branch: b.testsReady.branch, worktree: b.testsReady.worktree, head: fullHead ?? b.testsReady.head, then: b.testsReady.then ?? 'handoff', uncovered: (b.testsReady.uncovered as string).trim(), declaredAt: now };
  }
  delete out.difficultyReason;
  if (out.difficulty === null) out.difficulty = undefined;
  if (out.kind === null) out.kind = undefined;
  if (typeof out.kindReason === 'string') {
    const trimmed = out.kindReason.trim();
    out.kindReason = trimmed ? trimmed : undefined;
  }
  if ('needs' in out) out.needs = Array.isArray(out.needs) && out.needs.length ? [...new Set(out.needs as string[])] : undefined;
  if (out.backloggedAt === null) out.backloggedAt = undefined;
  if (out.nickname === null || out.nickname === '') out.nickname = undefined;
  else if (typeof out.nickname === 'string') out.nickname = out.nickname.trim();
  if (b.notesAppend !== undefined) {
    const prior = out.notes !== undefined ? out.notes : card.notes;
    if (prior !== undefined && prior !== null && typeof prior !== 'string') return 'this card\'s notes are not text; ask the Boss to change them';
    const add = String(b.notesAppend).trim();
    out.notes = prior ? `${prior}\n${add}` : add;
  }
  if (b.briefAppend !== undefined) {
    const prior = out.brief !== undefined ? out.brief : card.brief;
    if (prior !== undefined && prior !== null && typeof prior !== 'string') return 'this card\'s brief is not text; ask the Boss to change them';
    const add = String(b.briefAppend).trim();
    out.brief = prior ? `${prior}\n${add}` : add;
  }
  if (b.humanQAAppend !== undefined) {
    const qa = b.humanQAAppend as Raw;
    const prior = Array.isArray(card.humanQA) ? card.humanQA : [];
    out.humanQA = retireSupersededAsks({ humanQA: [...prior, { q: qa.q, askedAt: typeof qa.askedAt === 'string' ? qa.askedAt : now }] }, now).card.humanQA;
  }
  if (isRaw(b.resultsAppend)) {
    const prior = Array.isArray(card.results) ? card.results : [];
    out.results = [...prior, { text: String(b.resultsAppend.text), label: b.resultsAppend.label, at: now }];
  }
  if (b.approveAction === null || b.merge === false) out.approveAction = undefined;
  else if (isRaw(b.approveAction) && isRaw(b.humanQAAppend)) {
    const qa = b.humanQAAppend;
    out.approveAction = { ...b.approveAction, q: qa.q, askedAt: typeof qa.askedAt === 'string' ? qa.askedAt : now };
  }
  if (b.difficulty !== undefined && b.difficulty !== card.difficulty) {
    const history = Array.isArray(card.difficultyHistory) ? card.difficultyHistory : [];
    out.difficultyHistory = [...history, { old: card.difficulty ?? null, new: b.difficulty ?? null, who: sender, when: now, reason: typeof b.difficultyReason === 'string' ? b.difficultyReason : '' }];
  }
  if ((b.status === 'todo' || b.status === 'doing') && (card.status === 'blocked' || card.status === 'review')) {
    const latest = Array.isArray(card.humanQA) ? [...card.humanQA].reverse().find((q) => isRaw(q) && text(q.a) && !q.dismissedAt) : undefined;
    if (latest && !APPROVAL_ANSWER.test(String(latest.a))) {
      out.sendBacks = (typeof card.sendBacks === 'number' ? card.sendBacks : 0) + 1;
      out.sendBackHistory = [...(Array.isArray(card.sendBackHistory) ? card.sendBackHistory : []), { answer: latest.a, when: latest.answeredAt ?? now }];
    }
  }
  if (isRaw(b.escalate)) {
    const reason = String(b.escalate.reason).trim();
    out.escalation = { reason, by: sender, at: now };
    out.escalationHistory = [...(Array.isArray(card.escalationHistory) ? card.escalationHistory : []), { who: sender, when: now, reason }];
    const prior = out.notes !== undefined ? out.notes : card.notes;
    const line = `escalated to top by ${sender}: ${reason}`;
    out.notes = typeof prior === 'string' && prior ? `${prior}\n${line}` : line;
  }
  out.updatedAt = now;
  return out;
}

function isAwaitingMerge(b: Raw): boolean {
  if (typeof b.notesAppend === 'string' && AWAITING_MERGE.test(b.notesAppend)) return true;
  if (typeof b.notes === 'string' && AWAITING_MERGE.test(b.notes)) return true;
  return false;
}

export function planTaskMessage(m: TaskMessageInput): TaskPlan {
  const b = parseBody(m.body);
  if (!b) return { ok: false, reason: 'body must be a JSON object' };
  const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : undefined;
  if (m.act === 'task-create' && !m.isBoss) return { ok: false, id, reason: 'only the Boss creates cards; ask the Boss for one' };
  const allowed = m.act === 'task-create' ? BOSS_CREATE : m.isBoss ? BOSS_PATCH : WORKER_PATCH;
  const extra = Object.keys(b).filter((k) => !allowed.has(k));
  if (extra.length) return { ok: false, id, reason: `field${extra.length > 1 ? 's' : ''} not allowed: ${extra.join(', ')} (allowed: ${[...allowed].join(', ')})` };
  const bad = badField(b);
  if (bad) return { ok: false, id, reason: bad };
  const fields = Object.keys(b).filter((k) => k !== 'id');
  const cards = m.tasks.filter(isRaw);

  if (m.act === 'task-create') {
    if (m.closingTime && text(b.assignee)) return { ok: false, id, reason: CLOSING_REFUSAL };
    if (!text(b.title)) return { ok: false, id, reason: 'a new card needs a title' };
    const artKindErr = artCodeKindError({ project: b.project, title: b.title, description: b.description, kind: b.kind, kindReason: b.kindReason }, m.artProjects);
    if (artKindErr) return { ok: false, id, reason: artKindErr };
    const newId = id ?? `task-${m.now.replace(/[^0-9]/g, '').slice(0, 14)}-${cards.length + 1}`;
    if (cards.some((c) => c.id === newId)) return { ok: false, id: newId, reason: `card ${newId} already exists; send task-patch to change it` };
    if (b.dependsOn !== undefined) {
      const depVal = validateDependencies(newId, b.dependsOn as string[], cards as TaskLike[]);
      if (!depVal.valid) return { ok: false, id: newId, reason: depVal.reason ?? 'invalid dependencies' };
    }
    const rest = withAppends({}, b, m.now, m.sender) as Raw;
    const card: Raw = { id: newId, status: 'todo', dependsOn: [], createdAt: m.now, ...rest };
    if (card.status === 'doing') {
      const startCheck = canStartTask(card as TaskLike, cards as TaskLike[]);
      if (!startCheck.ok) return { ok: false, id: newId, reason: startCheck.reason ?? 'dependencies are not done' };
    }
    return { ok: true, kind: 'create', id: newId, card, fields };
  }

  if (!id) return { ok: false, reason: 'body needs the card "id"' };
  if (!fields.length) return { ok: false, id, reason: 'nothing to change' };
  const card = cards.find((c) => c.id === id);
  if (!card) return { ok: false, id, reason: `no card ${id}` };
  if (!m.isBoss && card.assignee !== m.sender) return { ok: false, id, reason: `card ${id} is not assigned to you` };
  if (!m.isBoss && b.status === 'done') return { ok: false, id, reason: DONE_REFUSAL };
  if (!m.isBoss && card.status === 'done' && b.status !== undefined) return { ok: false, id, reason: CLOSED_REFUSAL(id) };
  if (m.closingTime) {
    const reassigns = b.assignee !== undefined && b.assignee !== card.assignee;
    const reopens = (b.status === 'todo' || b.status === 'doing') && b.status !== card.status;
    if (reassigns || reopens) return { ok: false, id, reason: CLOSING_REFUSAL };
  }
  if (m.isBoss && m.sender !== 'harness' && b.status === 'done' && card.status !== 'done') {
    const open = openUncovered(card, b, cards);
    if (open) return { ok: false, id, reason: UNCOVERED_REFUSAL(open, id) };
  }
  const reopening = b.status === 'todo' || b.status === 'doing';
  const shelving = text(b.backloggedAt);
  if (reopening && (shelving || (isBacklogged(card) && b.backloggedAt !== null))) {
    return { ok: false, id, reason: BACKLOG_REFUSAL };
  }
  if (b.dependsOn !== undefined) {
    const depVal = validateDependencies(id, b.dependsOn as string[], cards as TaskLike[]);
    if (!depVal.valid) return { ok: false, id, reason: depVal.reason ?? 'invalid dependencies' };
  }
  const targetStatus = b.status !== undefined ? b.status : card.status;
  if (targetStatus === 'doing' && (b.status === 'doing' || b.dependsOn !== undefined)) {
    const effectiveDeps = b.dependsOn !== undefined ? (b.dependsOn as string[]) : (Array.isArray(card.dependsOn) ? (card.dependsOn as string[]) : []);
    const candidateTask = { ...card, dependsOn: effectiveDeps };
    const startCheck = canStartTask(candidateTask as TaskLike, cards as TaskLike[]);
    if (!startCheck.ok) return { ok: false, id, reason: startCheck.reason ?? 'dependencies are not done' };
  }
  if (b.escalate !== undefined && (b.difficulty !== undefined ? b.difficulty : card.difficulty) !== 'hard') return { ok: false, id, reason: ESCALATE_HARD };
  if (b.kind !== undefined || b.title !== undefined || b.description !== undefined || b.project !== undefined) {
    const artKindErr = artCodeKindError({
      project: b.project !== undefined ? b.project : card.project,
      title: b.title !== undefined ? b.title : card.title,
      description: b.description !== undefined ? b.description : card.description,
      kind: b.kind !== undefined ? b.kind : card.kind,
      kindReason: b.kindReason !== undefined ? b.kindReason : card.kindReason
    }, m.artProjects);
    if (artKindErr) return { ok: false, id, reason: artKindErr };
  }
  let fullHead: string | undefined;
  if (isRaw(b.testsReady)) {
    const t = b.testsReady as { branch: string; worktree: string; head: string };
    fullHead = (m.headOnBranch ?? headOnBranch)(t.worktree, t.branch, t.head) ?? undefined;
    if (!fullHead) return { ok: false, id, reason: `testsReady head ${t.head} is not a commit on ${t.branch} in ${t.worktree}; commit the failing tests first, then send the signal` };
  }
  const patch = withAppends(card, b, m.now, m.sender, fullHead);
  if (typeof patch === 'string') return { ok: false, id, reason: patch };
  if (!m.isBoss && isAwaitingMerge(b)) {
    const finalBrief = patch.brief !== undefined ? patch.brief : card.brief;
    const hasBrief = typeof finalBrief === 'string' && finalBrief.trim().length > 0;
    if (!hasBrief) return { ok: false, id, reason: BRIEF_REFUSAL };
  }
  if (shelving && b.status === undefined && card.status !== 'blocked' && card.status !== 'done') patch.status = 'blocked';
  if (m.closingTime && b.status === 'blocked' && (card.status === 'todo' || card.status === 'doing') && card.parkedFrom === undefined) {
    patch.parkedFrom = card.status;
    patch.parkedAt = m.now;
  } else if (!m.closingTime && b.status !== undefined && card.parkedFrom !== undefined) {
    patch.parkedFrom = undefined;
    patch.parkedAt = undefined;
  }
  return { ok: true, kind: 'patch', id, patch, fields };
}

/** Cards closing time parked (todo/doing moved to blocked) go back to todo once the floor
 *  is open again, unless a human question was asked on the card while it was parked or the human
 *  shelved it in the Backlog. Every
 *  parked card loses its marker either way. */
export function unparkPlan(tasks: readonly unknown[]): Array<{ id: string; patch: Raw; restored: boolean }> {
  const out: Array<{ id: string; patch: Raw; restored: boolean }> = [];
  for (const c of tasks.filter(isRaw)) {
    if (c.parkedFrom === undefined || typeof c.id !== 'string') continue;
    const parkedAt = typeof c.parkedAt === 'string' ? c.parkedAt : '';
    const askedSince = (Array.isArray(c.humanQA) ? c.humanQA : []).some((q) => {
      const e = q as Raw;
      return !e.a && !e.dismissedAt && typeof e.askedAt === 'string' && e.askedAt >= parkedAt;
    });
    const restored = c.status === 'blocked' && !askedSince && !isBacklogged(c);
    out.push({ id: c.id, restored, patch: { parkedFrom: undefined, parkedAt: undefined, ...(restored ? { status: 'todo' } : {}) } });
  }
  return out;
}

/** How an agent is told to change a card; `outboxDir` is its absolute outbox path. */
export function taskPatchHowTo(outboxDir: string): string {
  return `tasks.json is read-only for agents: change a card by writing ONE JSON file into ${outboxDir} like {"to":"harness","act":"task-patch","body":{"id":"<card-id>","status":"doing|blocked","notesAppend":"<one line>"}} (send only the fields you change; "result" holds the outcome summary; "brief" or "briefAppend" records handoff context). The harness applies it and mails you back only if it refuses. Only the Boss sets a card to done: when your work is finished, send the Boss a done message, write your "brief", and set the card "blocked" with notesAppend "awaiting boss merge". When your failing tests are committed on a branch, say so with "testsReady":{"branch":"<branch>","worktree":"<absolute path>","head":"<sha>","uncovered":"<numbered steps of the original proposal or brief these tests do not cover, or none>","then":"implement"|"handoff"} (re-read the original proposal, not just your tests, and name every step with no test; "handoff" when someone else implements, "implement" when you will; the harness refuses a head that is not on the branch). With "implement" the harness takes over: it writes your handoff, asks the human whether to switch models, and restarts you fresh on this card, so end your turn and do not start implementing in this session. On a hard card you judge too difficult for a strong model, send "escalate":{"reason":"<why>"}: your next fresh session starts on the top tier, and the reason goes in the card notes for the Boss.`;
}

/** The Boss's version: it creates cards and may change any field it plans with. */
export function taskCardHowToBoss(outboxDir: string): string {
  return `tasks.json is read-only for you too; the harness is its only writer. Write ONE JSON file into ${outboxDir} per edit: {"to":"harness","act":"task-create","body":{"id":"<new-id>","title":"...","assignee":"<agent-id>","project":"...","priority":"high|medium|low","description":"..."}} adds a card (status defaults to todo), and {"to":"harness","act":"task-patch","body":{"id":"<card-id>", ...only the fields you change}} edits one: status, title, description, assignee, priority, project, dependsOn, notes, notesAppend, brief, briefAppend, result, merge (false when closing a card as dropped so its branch is not merged), humanQAAppend {"q":"..."} (a decision the human must answer), resultsAppend {"text":"...","label":"answer|check"} (Results tab, nothing to answer), difficulty (easy|normal|hard: the assignee's model and effort at its next fresh session), testsReady. A refused edit comes back to your inbox with the reason.`;
}
