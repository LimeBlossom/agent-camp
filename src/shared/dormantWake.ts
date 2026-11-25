/**
 * When a dormant roster agent should be spawned.
 *
 * On app launch only the Boss starts; every other roster agent stays dormant
 * (restorable, no PTY) until this says it has work. Kept pure so the rule is
 * testable on its own, the way `broadcast.ts` is.
 */

import { isBlockedByDeps } from './taskDeps';

/** The subset of a tasks.json card the rule reads. */
export interface WakeTask {
  id?: string;
  assignee?: string;
  status?: string;
  dependsOn?: string[];
}

/** The subset of an inbox message the rule reads. */
export interface WakeMessage {
  id?: string;
  to?: string;
}

export interface WakeReason {
  /** Cards assigned to the agent in 'todo' or 'doing'. */
  taskIds: string[];
  /** Unread inbox messages addressed to the agent directly. */
  messageIds: string[];
}

/** Statuses that wake an agent. 'blocked' waits on the human's ASK ME answer and
 *  the Boss acts on that answer, so it never wakes the worker; 'done' is finished. */
const WORKING_STATUSES = new Set(['todo', 'doing']);

/** Accepts the raw `hive.tasks()` value: `{ tasks: [...] }`, a bare array, or junk. */
export function tasksOf(ledger: unknown): WakeTask[] {
  const list = Array.isArray(ledger)
    ? ledger
    : (ledger && typeof ledger === 'object' && Array.isArray((ledger as { tasks?: unknown }).tasks))
      ? (ledger as { tasks: unknown[] }).tasks
      : [];
  return list.filter((t): t is WakeTask => !!t && typeof t === 'object');
}

/**
 * Why `agentId` has work, or null when it has none and should stay asleep.
 *
 * `inbox` is the agent's unread mail (files directly in `inbox/`, not
 * `inbox/.done/`). A broadcast does not count: one reaches a dormant agent's disk
 * only when sent with `includeDormant`, and it is a floor-wide notice, not work
 * for that agent.
 */
export function dormantWakeReason(
  agentId: string,
  tasks: readonly WakeTask[],
  inbox: readonly WakeMessage[]
): WakeReason | null {
  const taskIds = tasks
    .filter((t) => t.assignee === agentId && WORKING_STATUSES.has(String(t.status)) && !isBlockedByDeps(t, tasks))
    .map((t) => String(t.id ?? '?'));
  const messageIds = inbox
    .filter((m) => m.to !== 'broadcast')
    .map((m) => String(m.id ?? '?'));
  return taskIds.length || messageIds.length ? { taskIds, messageIds } : null;
}

/**
 * The Boss's inbox message for an answered ASK ME, sent when the harness could not
 * route the answer to the assignee itself (HiveManager.routeHumanAnswer) or the answer
 * moves scope or model. A blocked card never wakes a worker, so it says how the
 * assignee resumes.
 */
export function humanAnswerBody(task: { id: string; title?: string; assignee?: string }, q: string, a: string): string {
  const lines = [
    `The human answered the open question on task ${task.id} ("${task.title ?? ''}"):`,
    `Q: ${q}`,
    `A: ${a}`,
    'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
  ];
  if (task.assignee && task.assignee !== 'god' && task.assignee !== 'boss') {
    lines.push(`Its assignee ${task.assignee} may be dormant (blocked cards do not wake it): set the card to "todo" or "doing", or send it direct mail with the answer, and it starts fresh.`);
  }
  return lines.join('\n');
}

/** memory.md above this many characters is archived down to a digest at the agent's
 *  next spawn. The file is read at the start of every task, so its size is paid on
 *  every wake. */
export const MEMORY_DIGEST_CAP = 8000;

/** One open card, as the start prompt names it. */
export interface StartTask {
  id: string;
  title?: string;
  status?: string;
  description?: string;
  brief?: string;
}

/** One pending inbox message, as the start prompt names it. */
export interface StartMessage {
  id: string;
  from?: string;
  subject?: string;
}

/** Everything the start prompt says; paths are absolute and native, built by the caller. */
export interface StartWork {
  isGod: boolean;
  memoryPath: string;
  archivePath: string;
  memoryChars: number;
  myTasksPath: string;
  tasksPath: string;
  inboxDir: string;
  tasks: readonly StartTask[];
  messages: readonly StartMessage[];
  /** The Boss's reason from wake-requests/, when that is what started the agent. */
  bossReason?: string;
  /** The harness's handoff note when a usage limit moved the agent off its last
   *  session's provider (main/handoff.ts). */
  handoff?: string;
  /** Root of the hive directory, for loading message template overrides from <hive>/prompts/messages/. */
  hiveRoot?: string;
}

const MAX_LISTED = 12;
const clip = (s: string | undefined, n: number): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The archive step, or '' while memory.md is under the cap. */
export function memoryArchiveStep(memoryPath: string, archivePath: string, chars: number): string {
  if (chars <= MEMORY_DIGEST_CAP) return '';
  return `Your memory.md is ${chars} chars, over the ${MEMORY_DIGEST_CAP}-char cap. Before anything else, move all but a current digest into ${archivePath}: APPEND the moved text there verbatim (never delete it; create the file if missing), then rewrite ${memoryPath} as a digest under ${MEMORY_DIGEST_CAP} chars (current work, standing rules, open threads, pointers into the archive). Do not run git on either file; the harness commits them.`;
}

/**
 * The first instruction a freshly spawned agent gets: its work by id, so the start turn
 * reads memory.md plus the named items instead of the whole inbox, the task ledger and
 * the protocol. Codex and other initial-prompt CLIs get it appended to the hive prompt;
 * Claude gets it typed as the first message.
 */
/** Registered by main/messageTemplates (this module is shared with the renderer, so it cannot read files). */
type StartTemplateLoader = (hiveRoot: string, key: string, values: Record<string, string | number>) => string | null;
let startTemplateLoader: StartTemplateLoader | null = null;
export function setStartTemplateLoader(loader: StartTemplateLoader | null): void { startTemplateLoader = loader; }

export function startPromptText(w: StartWork): string {
  const bundled = bundledStartPromptText(w);
  if (!w.hiveRoot || !startTemplateLoader) return bundled;
  return startTemplateLoader(w.hiveRoot, 'startPrompt', {
    bundled,
    memoryPath: w.memoryPath,
    archivePath: w.archivePath,
    myTasksPath: w.myTasksPath,
    tasksPath: w.tasksPath,
    inboxDir: w.inboxDir,
    role: w.isGod ? 'boss' : 'worker'
  }) ?? bundled;
}

function bundledStartPromptText(w: StartWork): string {
  const steps: string[] = [];
  const archive = memoryArchiveStep(w.memoryPath, w.archivePath, w.memoryChars);
  if (archive) steps.push(archive);
  if (w.handoff) {
    steps.push(`You are continuing work another session started; it stopped when its provider's usage limit ran out. Here is where it left off, as the harness recorded it:\n<handoff>\n${w.handoff.trim()}\n</handoff>\nThat session may have left uncommitted changes: check \`git status\` and \`git diff\` in the repo before editing anything, and build on its work rather than redoing it.`);
  }
  steps.push(`Read ${w.memoryPath}.`);
  const work: string[] = [];
  if (w.bossReason) work.push(`- The Boss woke you: ${clip(w.bossReason, 300)}`);
  for (const t of w.tasks.slice(0, MAX_LISTED)) {
    work.push(`- Task \`${t.id}\`${t.status ? ` (${t.status})` : ''}: ${clip(t.title, 120)}`);
  }
  for (const m of w.messages.slice(0, MAX_LISTED)) {
    work.push(`- Message \`${m.id}.json\` in ${w.inboxDir}${m.from ? ` from ${m.from}` : ''}: ${clip(m.subject, 120)}`);
  }
  const more = Math.max(0, w.tasks.length - MAX_LISTED) + Math.max(0, w.messages.length - MAX_LISTED);
  if (more) work.push(`- and ${more} more (see your inbox directory and ${w.myTasksPath}).`);
  const cardHelp = `Your open cards are summarised in ${w.myTasksPath}; read one card in full with \`jq '.tasks[] | select(.id=="<id>")' "${w.tasksPath}"\`.`;
  if (w.isGod) {
    steps.push(work.length
      ? `Handle what is pending for you:\n${work.join('\n')}`
      : 'Nothing is pending in your inbox.');
    steps.push(`The LIVE ROSTER line in your context is the floor's state. Do not read board.md, tasks.json, fleet.json, registry.json, COMMANDS.md or PROTOCOL-BOSS.md now; open them with jq or grep (never in full) when a message or heartbeat needs them. ${w.myTasksPath} lists every open card in a few lines.`);
    steps.push('Then wait for the next message.');
  } else if (work.length) {
    steps.push(`Your work, by id (read only these, not the rest of your inbox):\n${work.join('\n')}`);
    const first = w.tasks[0];
    const startWith = first ? `Start with \`${first.id}\`, the first card above${first.status === 'doing' ? ' (it is already "doing": continue it)' : ''}; work one card at a time. ` : '';
    steps.push(`${startWith}${cardHelp} Set a card to "doing" when you start it with a task-patch message (your prompt, rule 5); never write tasks.json. After handling a message, move its file into inbox/.done/.`);
    if (first) {
      if (first.description?.trim()) {
        steps.push(`Card \`${first.id}\` description:\n${first.description.trim()}`);
      }
      if (first.brief?.trim()) {
        steps.push(`Card \`${first.id}\` handoff brief:\n${first.brief.trim()}`);
      }
    }
  } else {
    steps.push('Nothing is assigned to you yet. Reply "ready" in one line and wait; do not read any other file until a message arrives.');
  }
  return [`START (${w.isGod ? 'boss boot' : 'your work'}):`, ...steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}

/** The subset of a registry entry the dormancy plan reads. */
export interface DormancyCandidate {
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
  dormant?: boolean;
}

/**
 * Which PTY-less registry agents to mark dormant and which to archive.
 *
 * `rosterIds` is every agent on the renderer roster (live cards plus the
 * restorable list), `restorableIds` the restorable list alone. Agents with a
 * live PTY, the Boss and the prep assistant outside boot are never touched.
 *
 * At boot no worker owns a PTY yet, so every roster agent becomes dormant and
 * every other non-archived entry is archived (a stale carry-over that would
 * otherwise be steered by the breaker and fanned broadcasts).
 *
 * At runtime only settled states move: an archived agent the human put back on
 * the restorable list becomes dormant, and a dormant agent dismissed from the
 * roster is archived. An entry that is neither archived nor dormant may be
 * mid-spawn (registered before its PTY is), so it is left alone.
 */
export function planDormancy(
  agents: Record<string, DormancyCandidate | undefined>,
  opts: { godId: string | null; liveIds: ReadonlySet<string>; rosterIds: ReadonlySet<string>; restorableIds: ReadonlySet<string>; boot: boolean }
): { dormant: string[]; archived: string[] } {
  const dormant: string[] = [];
  const archived: string[] = [];
  for (const [id, a] of Object.entries(agents)) {
    if (!a || id === opts.godId || a.isGod || opts.liveIds.has(id)) continue;
    if (opts.boot) {
      if (!a.isAssistant && opts.rosterIds.has(id)) {
        if (!a.dormant || a.archived) dormant.push(id);
      } else if (!a.archived || a.dormant) {
        archived.push(id);
      }
      continue;
    }
    if (a.isAssistant) continue;
    if (a.archived && !a.dormant && opts.restorableIds.has(id)) dormant.push(id);
    else if (a.dormant && !opts.rosterIds.has(id)) archived.push(id);
  }
  return { dormant, archived };
}

/** Agent ids out of a roster snapshot's opaque agent lists. */
export function rosterIdsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => (a && typeof a === 'object' ? (a as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}
