/**
 * The handoff note a limit switch leaves for the agent's next session. The old
 * provider is out of quota, so the note is built by the harness from what is on
 * disk, with no model call: the agent's cards, its recent mail, its memory pointer,
 * the git state of its worktrees (handoffGather.ts reads those) and the last
 * assistant messages and tool calls of the old session's log. It lands in
 * agents/<id>/handoff.md; the next start prompt inlines it once and renames it to
 * handoff.consumed.md (hive.ts takeHandoff). Parsing and capping are pure, so
 * test/handoff.test.cjs pins them.
 */

import { isBacklogged } from '../shared/backlog';
import { APPROVAL_ANSWER, AWAITING_MERGE } from './taskPatch';
import { humanWords } from './humanName';

export const HANDOFF_CAP = 6000;
const MAX_MESSAGES = 4;
const MAX_TOOLS = 10;
const MESSAGE_CHARS = 600;
const CALL_CHARS = 200;
const RESULT_CHARS = 160;
const MIN_TOOLS = 3;
const NOTE_LINES = 3;
const NOTE_CHARS = 400;
const WHY_CHARS = 300;
const MAIL_SUBJECT_CHARS = 160;
const MAIL_BODY_CHARS = 300;
const MIN_MAIL = 2;
const MAX_UNPUSHED = 5;
/** An answer this close to the card's last update is the last thing that happened on it. */
const FRESH_ANSWER_MS = 5 * 60_000;
const waitsOn = (): RegExp => new RegExp(`\\b(?:awaiting|waiting (?:on|for)|waits (?:on|for)|blocked on)\\s+(?:the boss|boss|${humanWords()})\\b`, 'i');

export interface ToolStep {
  call: string;
  result?: string;
}

export interface SessionDigest {
  /** Assistant messages, oldest first. */
  messages: string[];
  /** Tool calls with a short result, oldest first. */
  tools: ToolStep[];
}

export interface HandoffCard {
  id: string;
  title?: string;
  status?: string;
  notes?: string;
  /** On a blocked card: what the agent can do on it. */
  why?: string;
}

export interface HandoffRepo {
  path: string;
  status: string;
  diffStat: string;
  branch?: string;
  /** Short hash and subject of HEAD. */
  head?: string;
  /** What is not pushed, newest first: the label says what the commits are compared with. */
  unpushed?: { label: string; commits: string[] };
}

export interface HandoffMail {
  atMs: number;
  dir: 'in' | 'out';
  peer: string;
  act: string;
  subject: string;
  body: string;
}

/** A tasks.json card, untyped as it is on disk. */
export interface BoardCard {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  assignee?: unknown;
  notes?: unknown;
  description?: unknown;
  humanQA?: unknown;
  backloggedAt?: unknown;
  dependsOn?: unknown;
  updatedAt?: unknown;
}

export interface HandoffInput {
  agentName: string;
  from: string;
  to?: string;
  resetAtMs?: number;
  /** Why the session ended: its usage limit (default) or the human switching models. */
  reason?: 'limit' | 'manual' | 'checkpoint';
  nowMs: number;
  digest: SessionDigest;
  cards: HandoffCard[];
  /** Blocked cards left out because they only wait on the human or another agent. */
  hiddenBlocked?: number;
  repos: HandoffRepo[];
  mail?: HandoffMail[];
  /** Where the agent's memory digest is, as one line. */
  memory?: string;
  /** What the provider said when it stopped the session. */
  stopDetail?: string;
  /** Why there is no session history, when the digest is empty. */
  logGap?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clipStart = (s: string, n: number): string => (s.length > n ? `…${s.slice(s.length - n + 1)}` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Codex's `exec` tool takes a script; the shell commands are its `cmd:"..."` strings. */
function execCommands(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try { out.push(JSON.parse(`"${m[1]}"`) as string); } catch { out.push(m[1]); }
  }
  return out;
}

function callLabel(name: string, args: unknown): string {
  if (typeof args === 'string') {
    const cmds = execCommands(args);
    if (cmds.length) return cmds.map((c) => `$ ${oneLine(c)}`).join(' ; ');
    try { return callLabel(name, JSON.parse(args)); } catch { return `${name} ${oneLine(args)}`; }
  }
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const cmd = a.cmd ?? a.command;
    if (typeof cmd === 'string') return `$ ${oneLine(cmd)}`;
    if (Array.isArray(cmd)) return `$ ${oneLine(cmd.map(String).join(' '))}`;
    const target = a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.description;
    if (typeof target === 'string') return `${name} ${oneLine(target)}`;
    return `${name} ${oneLine(JSON.stringify(a))}`;
  }
  return name;
}

/** A tool result as one short line: exit code when shown, then the first output text. */
function resultLabel(raw: string, isError = false): string {
  let text = raw;
  const exit = /"exit_code"\s*:\s*(-?\d+)/.exec(text) ?? /Process exited with code (-?\d+)/.exec(text);
  const inner = /"output"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (inner) { try { text = JSON.parse(`"${inner[1]}"`) as string; } catch { text = inner[1]; } }
  text = text.replace(/^Script completed\s*Wall time[^\n]*\n(?:Output:\n)?/i, '');
  const body = oneLine(text);
  const head = exit ? `exit ${exit[1]}` : isError ? 'error' : '';
  return [head, body].filter(Boolean).join(': ');
}

/** The last assistant messages and tool calls of a Codex rollout. */
export function codexDigest(text: string): SessionDigest {
  const messages: string[] = [];
  const tools: ToolStep[] = [];
  const byCall = new Map<string, ToolStep>();
  for (const line of text.split('\n')) {
    if (!line.includes('"response_item"')) continue;
    const d = parse(line);
    const p = d?.payload as Record<string, unknown> | undefined;
    if (!d || d.type !== 'response_item' || !p) continue;
    if (p.type === 'message' && p.role === 'assistant') {
      const t = textOf(p.content).trim();
      if (t) messages.push(t);
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const step: ToolStep = { call: callLabel(String(p.name ?? p.type), p.input ?? p.arguments ?? p.action) };
      tools.push(step);
      if (typeof p.call_id === 'string') byCall.set(p.call_id, step);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const step = typeof p.call_id === 'string' ? byCall.get(p.call_id) : undefined;
      const out = p.output;
      const raw = typeof out === 'string' ? out : Array.isArray(out) ? textOf(out) : out && typeof out === 'object' ? String((out as { output?: unknown }).output ?? '') : '';
      if (step) step.result = resultLabel(raw);
    }
  }
  return { messages, tools };
}

/** The last assistant messages and tool calls of a Claude Code transcript. Claude
 *  Code writes one record per content block, so text blocks sharing a message id are
 *  joined into one message. */
export function claudeDigest(text: string): SessionDigest {
  const messages: string[] = [];
  const tools: ToolStep[] = [];
  const byId = new Map<string, ToolStep>();
  let lastMsgId: string | undefined;
  for (const line of text.split('\n')) {
    const d = parse(line);
    if (!d) continue;
    const msg = d.message as { id?: string; content?: unknown } | undefined;
    if (!msg || !Array.isArray(msg.content)) continue;
    if (d.type === 'assistant' && d.isApiErrorMessage !== true) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          if (msg.id && msg.id === lastMsgId && messages.length) messages[messages.length - 1] += `\n${b.text.trim()}`;
          else messages.push(b.text.trim());
          lastMsgId = msg.id;
        } else if (b?.type === 'tool_use') {
          const step: ToolStep = { call: callLabel(String(b.name ?? 'tool'), b.input) };
          tools.push(step);
          if (typeof b.id === 'string') byId.set(b.id, step);
        }
      }
    } else if (d.type === 'user') {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const step = byId.get(b.tool_use_id);
        if (step) step.result = resultLabel(textOf(b.content), b.is_error === true);
      }
    }
  }
  return { messages, tools };
}

/** Folders the session's recent commands ran git in (`git -C <dir>`) or moved to
 *  (`cd <dir>`), newest first. The agent's cwd repo is often not where it was working:
 *  a worker that clones a repo into its own folder commits there. */
export function repoHints(digest: SessionDigest, max = 3): string[] {
  const out: string[] = [];
  for (const t of [...digest.tools].reverse()) {
    for (const m of t.call.matchAll(/(?:git\s+-C|\bcd)\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/g)) {
      const dir = m[1] ?? m[2] ?? m[3];
      if (dir && dir.startsWith('/') && !out.includes(dir)) out.push(dir);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function noteLines(card: BoardCard): string[] {
  return (str(card.notes) || str(card.description)).split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * What the agent can do on a blocked card, or null when the card only waits on the human
 * (backlog, an open ask, a note saying so) or on another agent (a dependency still
 * open, the Boss's merge). A fresh answer from the human that is not an approval is the
 * agent's to act on even when the card's last note says it awaits a merge.
 */
export function blockedWork(card: BoardCard, byId: ReadonlyMap<string, BoardCard>): string | null {
  if (isBacklogged(card)) return null;
  const deps = Array.isArray(card.dependsOn) ? card.dependsOn : [];
  if (deps.some((d) => { const dep = byId.get(String(d)); return dep !== undefined && dep.status !== 'done'; })) return null;
  const asks = (Array.isArray(card.humanQA) ? card.humanQA : [])
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && !(q as { dismissedAt?: unknown }).dismissedAt);
  const ask = asks[asks.length - 1];
  if (ask && !str(ask.a).trim()) return null;
  if (ask && !APPROVAL_ANSWER.test(str(ask.a)) && !(Date.parse(str(card.updatedAt)) - Date.parse(str(ask.answeredAt)) > FRESH_ANSWER_MS)) {
    return `The human answered your ask: ${clip(oneLine(str(ask.a)), WHY_CHARS)}`;
  }
  const last = noteLines(card).at(-1) ?? '';
  if (AWAITING_MERGE.test(last) || waitsOn().test(last)) return null;
  return last ? `its last note is a step of yours: ${clip(last, WHY_CHARS)}` : 'blocked with no note or ask saying what it waits on';
}

/** The agent's cards for the note: doing and todo in full, then the blocked ones it can
 *  act on, each with the last lines of its notes; the other blocked ones are counted. */
export function pickCards(tasks: readonly BoardCard[], agentId: string): { cards: HandoffCard[]; hiddenBlocked: number } {
  const byId = new Map(tasks.map((t) => [String(t.id), t]));
  const cards: HandoffCard[] = [];
  let hiddenBlocked = 0;
  for (const status of ['doing', 'todo', 'blocked']) {
    for (const t of tasks) {
      if (t.assignee !== agentId || t.status !== status) continue;
      const why = status === 'blocked' ? blockedWork(t, byId) : undefined;
      if (why === null) { hiddenBlocked++; continue; }
      const notes = noteLines(t).slice(-NOTE_LINES).join(' | ');
      cards.push({ id: String(t.id ?? '?'), title: str(t.title) || undefined, status, ...(notes ? { notes } : {}), ...(why ? { why } : {}) });
    }
  }
  return { cards, hiddenBlocked };
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function renderRepo(r: HandoffRepo): string {
  // Only blank lines go: the leading column of `--short` is the index state.
  const lines = (t: string): string[] => t.split('\n').filter((l) => l.trim());
  const status = lines(r.status);
  const stat = lines(r.diffStat);
  const statusText = status.length ? [...status.slice(0, 12), ...(status.length > 12 ? [`… ${status.length - 12} more`] : [])].join('\n') : '(clean)';
  const statText = stat.length ? [...(stat.length > 8 ? ['…'] : []), ...stat.slice(-8)].join('\n') : '(no unstaged changes)';
  const where = r.branch ? `branch ${r.branch}${r.head ? `, HEAD ${clip(r.head, 120)}` : ''}\n` : '';
  const pushed = r.unpushed
    ? `${r.unpushed.label}${r.unpushed.commits.length ? `:\n${r.unpushed.commits.slice(0, MAX_UNPUSHED).map((c) => clip(c, 120)).join('\n')}` : ''}\n`
    : '';
  return `## Git: ${r.path}\n${where}${pushed}\`git status --short\`:\n\`\`\`\n${statusText}\n\`\`\`\n\`git diff --stat\`:\n\`\`\`\n${statText}\n\`\`\``;
}

/**
 * The note, at most `cap` characters. Cards, memory and git state are kept whole
 * (each capped on its own); the session history gives way oldest first, tool calls
 * down to MIN_TOOLS before messages, so the note keeps both what the agent last said
 * and what it last ran, and then the oldest mail down to MIN_MAIL.
 */
export function buildHandoff(input: HandoffInput, cap = HANDOFF_CAP, redact: (s: string) => string = (s) => s): string {
  const stopped = input.reason === 'checkpoint'
    ? 'was stopped at the tests-to-implementation checkpoint: the failing tests are committed and this session implements them'
    : input.reason === 'manual'
    ? 'was stopped when the human switched models'
    : `stopped at its usage limit${input.resetAtMs ? ` (resets ${clock(input.resetAtMs)})` : ''}`;
  const head = [
    `# Handoff for ${input.agentName}`,
    '',
    `Written by the harness ${new Date(input.nowMs).toISOString()}. The previous session ran on ${input.from} and ${stopped}${input.to ? `; this one runs on ${input.to}` : ''}. Nothing below was summarised by a model: the harness read it from the card board, your folders, your worktrees and the end of that session's log.`,
    ...(input.stopDetail ? ['', `The provider's stop message: ${clip(oneLine(redact(input.stopDetail)), WHY_CHARS)}`] : [])
  ].join('\n');
  const hidden = input.hiddenBlocked ?? 0;
  const cards = [
    '## Open cards',
    ...(input.cards.length ? input.cards.map((c) => {
      const notes = c.notes ? clipStart(oneLine(c.notes), NOTE_CHARS) : '';
      return `- \`${c.id}\` ${c.status ?? ''}: ${clip(oneLine(c.title ?? ''), 160)}${c.why ? `\n  yours because: ${c.why}` : ''}${notes ? `\n  notes: ${notes}` : ''}`;
    }) : [hidden ? '_None you can act on._' : '_None._']),
    ...(hidden ? [`${hidden} blocked card${hidden === 1 ? '' : 's'} waiting on others, not shown.`] : [])
  ].join('\n');
  const memory = input.memory ? `## Memory\n${input.memory}` : '';
  const repos = input.repos.map(renderRepo);
  let mail = (input.mail ?? []).map((m) => {
    const body = clip(oneLine(redact(m.body)), MAIL_BODY_CHARS);
    return `- ${stamp(m.atMs)} ${m.dir === 'in' ? 'from' : 'to'} ${m.peer}, ${m.act}: ${clip(oneLine(redact(m.subject)), MAIL_SUBJECT_CHARS)}${body ? `\n  ${body}` : ''}`;
  });
  let messages = input.digest.messages.slice(-MAX_MESSAGES).map((m) => clip(oneLine(redact(m)), MESSAGE_CHARS));
  let tools = input.digest.tools.slice(-MAX_TOOLS).map((t) => {
    const call = clip(redact(t.call), CALL_CHARS);
    const result = t.result ? clip(redact(t.result), RESULT_CHARS) : '';
    return `- ${call}${result ? `\n  -> ${result}` : ''}`;
  });
  const hadHistory = messages.length > 0 || tools.length > 0;
  const history = (): string[] => hadHistory
    ? [
        `## Last messages (oldest first)\n${messages.length ? messages.map((m) => `- ${m}`).join('\n') : '_None in the end of the log._'}`,
        `## Last tool calls (oldest first)\n${tools.length ? tools.join('\n') : '_None in the end of the log._'}`
      ]
    : [`## Session log\n${input.logGap ?? 'The end of the session log held no assistant messages or tool calls.'}`];
  const render = (): string => [
    head,
    cards,
    memory,
    ...(mail.length ? [`## Recent mail (oldest first, from your inbox and outbox folders)\n${mail.join('\n')}`] : []),
    ...repos,
    ...history()
  ].filter(Boolean).join('\n\n') + '\n';
  let note = render();
  while (note.length > cap && (tools.length || messages.length || mail.length > MIN_MAIL)) {
    if (tools.length > MIN_TOOLS || (tools.length && messages.length <= 1)) tools = tools.slice(1);
    else if (messages.length) messages = messages.slice(1);
    else mail = mail.slice(1);
    note = render();
  }
  return note.length > cap ? `${note.slice(0, cap - 2)}…\n` : note;
}
