/**
 * The phone view: a small read-and-answer web page for the floor, served only
 * on this machine's Tailscale address. It shows each agent's status and last
 * reply, the task board and the ASK ME questions, and takes two writes: an
 * answer to an open question (the same two steps the ASK ME card performs) and
 * a message to an agent (enqueued by the primary window like its composer).
 *
 * The one thing it can do to an agent is switch its model (POST /api/agent-model),
 * which restarts the agent on the new model. Every request needs the token. Agent-written text reaches the page as JSON and is inserted with
 * textContent, never as HTML.
 */
import { resultsFeed } from '../shared/resultsFeed';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openForRead, readFileBinary, safeResolve } from './fs';
import { extensionOf, isImagePath } from '../shared/imageTypes';
import { humanAnswerBody } from '../shared/dormantWake';
import { PHONE_PAGE, brandPhonePage } from './phonePage';
import { brandTitle } from './themePacks';
import { projectOf } from '../shared/askMeProject';
import { backlogMailBody, backlogPatch, dependentsTree, isBacklogged, unbacklogMailBody, unbacklogPatch } from '../shared/backlog';
import type { PhoneEngineLimit } from '../shared/engineLimits';

export const PHONE_PORT = 7788;
const MAX_BODY = 64 * 1024;
/** Dependents listed under a shelved card; the rest are counted (desktop StuckList shows six). */
const MAX_STUCK = 6;

interface PublishedAgent {
  id: string; name: string; status?: string; action?: string; isGod?: boolean;
  model?: string | null; liveModel?: string | null; usage7dLine?: string;
  character?: string; cwd?: string; recentAssistantText?: string; recentTextTs?: number;
}
interface QA { q?: string; a?: string; askedAt?: string; answeredAt?: string; dismissedAt?: string }
interface Task {
  id: string; title?: string; status?: string; assignee?: string; humanQA?: QA[]; dependsOn?: string[];
  project?: string; backloggedAt?: string; description?: string;
  notes?: string; result?: string; createdAt?: string; updatedAt?: string; priority?: string | number;
}

export interface AgentActivity {
  /** Epoch ms the current action text first appeared. */
  actionSince?: number;
  /** Epoch ms of the agent terminal's last output byte. */
  lastOutputAt?: number;
}

type PhoneModelChoices = { current: PhoneModelChoice; choices: PhoneModelChoice[] } | null;

export interface PhoneDeps {
  /** Stamps every unseen result seen (the Results tab on open); returns how many. */
  markResultsSeen?: () => number;
  /** Per-agent live activity timing; unset leaves the fields null. */
  activity?: (agentId: string) => AgentActivity | undefined;
  /** Raw recent terminal output for an agent, ANSI included; null when it has no terminal. */
  transcript?: (agentId: string) => string | null;
  /** Absolute path of a phone page file, read per request; unset or unusable serves the bundled page. */
  pagePath?: () => string | undefined;
  token: () => string;
  /** The primary window's latest published store slice (desktop.ts). */
  state: () => unknown;
  tasks: () => unknown;
  patchTask: (id: string, patch: Record<string, unknown>) => boolean;
  sendToGod: (subject: string, body: string) => void;
  /** Routes an answer already saved on the card (HiveManager.routeHumanAnswer). Unset: the Boss is mailed. */
  routeAnswer?: (taskId: string, q: string, a: string) => void;
  enqueue: (agentId: string, text: string) => boolean;
  /** Folders images may be served from (hive, harness home, repos). */
  roots: () => string[];
  limits?: () => PhoneEngineLimit[];
  feedback?: () => unknown[];
  sendFeedback?: (reportId: string, agentId: string, note?: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  saveFeedbackNote?: (reportId: string, note: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  dismissFeedback?: (reportId: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /** The models an agent can be switched to, and the one it runs now; null for an unknown agent. */
  modelChoices?: (agentId: string, refresh?: boolean) => PhoneModelChoices | Promise<PhoneModelChoices>;
  /** modelSwitch.switchAgentModel with reason "phone". */
  switchModel?: (agentId: string, entry: { provider: string; model?: string }, confirmBoss: boolean) => Promise<{ ok: boolean; state?: string; error?: string; code?: string }>;
  /** A switch queued or restarting for this agent. */
  modelSwitching?: (agentId: string) => { to: string; state: string } | null;
  /** The agent's model tier label and its pin, with why an unusable pin is not used; null when unknown. */
  agentTier?: (agentId: string) => PhoneAgentTier | null;
  /** Clears an agent's model pin the way Edit Agent does; false for an unknown agent. */
  clearPin?: (agentId: string) => boolean;
}

export interface PhoneAgentTier { tier: string; pin?: { provider: string; model?: string; label: string; unused?: string } }

export interface PhoneModelChoice { provider: string; model?: string; label: string }

/** The Tailscale IPv4 address (100.64.0.0/10), or null when not on a tailnet. */
export function tailscaleAddress(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [p, q] = a.address.split('.').map(Number);
      if (p === 100 && q >= 64 && q <= 127) return a.address;
      if (name.startsWith('tailscale')) return a.address;
    }
  }
  return null;
}

export function newPhoneToken(): string {
  return randomBytes(16).toString('hex');
}

function tokenOk(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function taskList(raw: unknown): Task[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
    ? (raw as { tasks: Task[] }).tasks : [];
  return list.filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
}

/** The ASK ME definition (TasksKanban.openQuestion). */
function openQuestion(t: Task): QA | undefined {
  const qa = Array.isArray(t.humanQA) ? t.humanQA : [];
  for (let i = qa.length - 1; i >= 0; i--) {
    const e = qa[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** Every open ask on a card, in the order asked. */
function openQuestions(t: Task): QA[] {
  const qa = Array.isArray(t.humanQA) ? t.humanQA : [];
  return qa.filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);
}

function snapshot(deps: PhoneDeps) {
  const st = deps.state() as { agents?: PublishedAgent[]; restorableAgents?: PublishedAgent[] } | null;
  const agents = (st?.agents ?? []).map((a) => ({
    id: a.id, name: a.name, status: a.status ?? 'idle', action: a.action ?? '',
    isGod: !!a.isGod, character: a.character ?? '', lastReply: a.recentAssistantText ?? '',
    lastReplyAt: a.recentTextTs ?? null,
    actionSince: deps.activity?.(a.id)?.actionSince ?? null,
    lastOutputAt: deps.activity?.(a.id)?.lastOutputAt ?? null,
    ...(a.usage7dLine ? { usage7dLine: a.usage7dLine } : {}),
    ...(deps.modelSwitching?.(a.id) ? { switching: deps.modelSwitching(a.id) } : {}),
    ...(deps.agentTier?.(a.id) ?? {}),
    ...((typeof a.liveModel === 'string' && a.liveModel.trim())
      ? { model: a.liveModel.trim() }
      : (typeof a.model === 'string' && a.model.trim()) ? { model: a.model.trim() } : {}),
  }));
  // Dormant floor agents wake when assigned work, so the feedback picker lists them too.
  const dormant = (st?.restorableAgents ?? [])
    .filter((a) => !a.isGod && !agents.some((l) => l.id === a.id))
    .map((a) => ({ id: a.id, name: a.name }));
  const tasks = taskList(deps.tasks());
  // Every open ask, oldest first within a card, each with its own askedAt.
  const asks = tasks
    .filter((t) => t.status === 'blocked' && !isBacklogged(t))
    .flatMap((t) => openQuestions(t).map((e) => ({ id: t.id, title: t.title ?? '', assignee: t.assignee ?? '', project: projectOf(t), q: e.q as string, askedAt: e.askedAt })));
  const board = tasks.filter((t) => !isBacklogged(t)).map((t) => ({ id: t.id, title: t.title ?? '', status: t.status ?? 'todo', assignee: t.assignee ?? '', project: projectOf(t) }));
  const shelvedMs = (t: Task): number => Date.parse(t.backloggedAt ?? '') || 0;
  // Newest shelved first, as the desktop Backlog orders it.
  const backlog = tasks.filter(isBacklogged).sort((a, b) => shelvedMs(b) - shelvedMs(a)).map((t) => {
    const stuck = dependentsTree(t.id, tasks);
    return {
      id: t.id, title: t.title ?? '', status: t.status ?? 'todo', assignee: t.assignee ?? '', project: projectOf(t),
      backloggedAt: t.backloggedAt ?? '', description: t.description ?? '', q: openQuestion(t)?.q ?? '',
      stuckCount: stuck.length,
      stuck: stuck.slice(0, MAX_STUCK).map((d) => ({ title: d.title ?? d.id, status: d.status ?? 'todo', assignee: d.assignee ?? '' })),
    };
  });
  const limits = deps.limits ? deps.limits() : [];
  const feedback = deps.feedback ? deps.feedback() : [];
  const results = resultsFeed(tasks);
  return { agents, dormant, asks, results, board, backlog, live: !!st, limits, feedback };
}

async function backlogCard(deps: PhoneDeps, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const b = body as { taskId?: unknown };
  if (typeof b.taskId !== 'string' || !b.taskId) return { ok: false, error: 'missing taskId' };
  const task = taskList(deps.tasks()).find((t) => t.id === b.taskId);
  if (!task || task.status !== 'blocked' || !openQuestion(task) || isBacklogged(task)) {
    return { ok: false, error: 'question changed; refresh' };
  }
  if (!deps.patchTask(task.id, backlogPatch(new Date().toISOString()))) return { ok: false, error: 'task changed; refresh and retry' };
  deps.sendToGod(`BACKLOG: "${task.title ?? task.id}"`, backlogMailBody(task.title ?? task.id, task.id));
  return { ok: true };
}

async function unbacklog(deps: PhoneDeps, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const b = body as { taskId?: unknown };
  if (typeof b.taskId !== 'string' || !b.taskId) return { ok: false, error: 'missing taskId' };
  const task = taskList(deps.tasks()).find((t) => t.id === b.taskId);
  if (!task || !isBacklogged(task)) return { ok: false, error: 'card is no longer in the backlog' };
  if (!deps.patchTask(task.id, unbacklogPatch())) return { ok: false, error: 'task changed; refresh and retry' };
  deps.sendToGod(`BACK FROM BACKLOG: "${task.title ?? task.id}"`, unbacklogMailBody(task.title ?? task.id, task.id));
  return { ok: true };
}

/** Agents the phone may switch: live floor agents and dormant roster ones. */
function knownAgent(deps: PhoneDeps, id: string): { isGod: boolean } | null {
  const st = deps.state() as { agents?: PublishedAgent[]; restorableAgents?: PublishedAgent[] } | null;
  const a = [...(st?.agents ?? []), ...(st?.restorableAgents ?? [])].find((x) => x.id === id);
  return a ? { isGod: !!a.isGod } : null;
}

/** POST /api/agent-model: validate, then hand the switch to the camp. Returns the HTTP status and body. */
async function agentModel(deps: PhoneDeps, body: unknown): Promise<{ code: number; body: Record<string, unknown> }> {
  const b = (body && typeof body === 'object' ? body : {}) as { id?: unknown; provider?: unknown; model?: unknown; confirmBoss?: unknown };
  if (!deps.switchModel || !deps.modelChoices) return { code: 501, body: { ok: false, error: 'not implemented' } };
  if (typeof b.id !== 'string' || !b.id || typeof b.provider !== 'string' || !b.provider
    || (b.model !== undefined && b.model !== null && typeof b.model !== 'string')) {
    return { code: 400, body: { ok: false, error: 'missing fields' } };
  }
  const agent = knownAgent(deps, b.id);
  if (!agent) return { code: 404, body: { ok: false, error: 'agent not found' } };
  const confirmBoss = b.confirmBoss === true;
  if (agent.isGod && !confirmBoss) return { code: 403, body: { ok: false, error: 'switching the Boss needs confirmation' } };
  const model = typeof b.model === 'string' && b.model ? b.model : undefined;
  const choices = (await deps.modelChoices(b.id))?.choices ?? [];
  if (!choices.some((c) => c.provider === b.provider && (c.model ?? '') === (model ?? ''))) {
    return { code: 400, body: { ok: false, error: 'that model is not available for this agent' } };
  }
  const res = await deps.switchModel(b.id, { provider: b.provider, ...(model ? { model } : {}) }, confirmBoss);
  return { code: res.ok ? 200 : 400, body: { ...res } };
}

export const TRANSCRIPT_MAX_LINES = 400;
export const TRANSCRIPT_MAX_BYTES = 64 * 1024;

/** Removes terminal escape sequences and control bytes, keeping \n, \r and \t. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\-_=>78]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** The last lines of terminal output, ANSI stripped, within both bounds. A bare \r redraws the line, so the text after it wins. */
export function tailLines(raw: string, maxLines: number, maxBytes: number): { lines: string[]; truncated: boolean } {
  const all = stripAnsi(raw).replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).replace(/\s+$/, ''));
  while (all.length && !all[all.length - 1]) all.pop();
  let lines = all.slice(-maxLines);
  let truncated = lines.length < all.length;
  let bytes = 0, keep = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(lines[i]) + 1;
    if (bytes > maxBytes) break;
    keep++;
  }
  if (keep < lines.length) { lines = lines.slice(lines.length - keep); truncated = true; }
  return { lines, truncated };
}

function transcriptTail(deps: PhoneDeps, id: string): { ok: true; lines: string[]; truncated: boolean } | { ok: false; error: string } {
  const st = deps.state() as { agents?: PublishedAgent[] } | null;
  if (!id || !st?.agents?.some((a) => a.id === id)) return { ok: false, error: 'agent not found' };
  const raw = deps.transcript?.(id);
  if (raw == null) return { ok: false, error: 'no terminal output for this agent' };
  return { ok: true, ...tailLines(raw, TRANSCRIPT_MAX_LINES, TRANSCRIPT_MAX_BYTES) };
}

/** Read-only detail for one card, the phone's stand-in for the desktop task drawer. */
function taskDetail(deps: PhoneDeps, id: string): { ok: true; task: Record<string, unknown> } | { ok: false; error: string } {
  const tasks = taskList(deps.tasks());
  const t = tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'card not found' };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const titleOf = (dep: string): string => tasks.find((x) => x.id === dep)?.title ?? dep;
  return {
    ok: true,
    task: {
      id: t.id, title: t.title ?? '', status: t.status ?? 'todo', assignee: t.assignee ?? '', project: projectOf(t),
      priority: t.priority ?? '', createdAt: str(t.createdAt), updatedAt: str(t.updatedAt), backloggedAt: str(t.backloggedAt),
      description: str(t.description), notes: str(t.notes), result: str(t.result),
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => ({ id: d, title: titleOf(d) })),
      qa: (Array.isArray(t.humanQA) ? t.humanQA : []).filter((e) => e && typeof e.q === 'string').map((e) => ({
        q: e.q, a: e.a ?? '', askedAt: e.askedAt ?? '', answeredAt: e.answeredAt ?? '', dismissed: !!e.dismissedAt,
      })),
    },
  };
}

/** Clears an ask off ASK ME without answering it, as the desktop X does: the open entry
 *  gets `dismissedAt`, the question stays in the card's history, and HiveManager.patchTask mails the Boss the card's loose ends. */
async function dismissAsk(deps: PhoneDeps, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const b = body as { taskId?: unknown; q?: unknown };
  if (typeof b.taskId !== 'string' || typeof b.q !== 'string') return { ok: false, error: 'missing fields' };
  const task = taskList(deps.tasks()).find((t) => t.id === b.taskId);
  const open = task && openQuestion(task);
  if (!task || !open || open.q !== b.q) return { ok: false, error: 'question changed; refresh' };
  const now = new Date().toISOString();
  const qa = (task.humanQA ?? []).map((e) => (e === open ? { ...e, dismissedAt: now } : e));
  if (!deps.patchTask(task.id, { humanQA: qa })) return { ok: false, error: 'task changed; refresh' };
  return { ok: true };
}

async function answer(deps: PhoneDeps, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const b = body as { taskId?: unknown; q?: unknown; text?: unknown };
  if (typeof b.taskId !== 'string' || typeof b.q !== 'string' || typeof b.text !== 'string' || !b.text.trim()) {
    return { ok: false, error: 'missing fields' };
  }
  const text = b.text.trim();
  const task = taskList(deps.tasks()).find((t) => t.id === b.taskId);
  const open = task && openQuestion(task);
  // Re-located by text, as the card does, so an answer never lands on a question
  // the orchestrator swapped in since the phone last polled.
  if (!task || !open || open.q !== b.q) return { ok: false, error: 'question changed; refresh' };
  const qa = (task.humanQA ?? []).map((e) => (e === open ? { ...e, a: text, answeredAt: new Date().toISOString() } : e));
  if (!deps.patchTask(task.id, { humanQA: qa })) return { ok: false, error: 'task changed; refresh' };
  if (deps.routeAnswer) deps.routeAnswer(task.id, open.q, text);
  else deps.sendToGod(`HUMAN ANSWER on task "${task.title ?? task.id}"`, humanAnswerBody(task, open.q, text));
  return { ok: true };
}

const VIDEO_MIME: Readonly<Record<string, string>> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };
const AUDIO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac',
};

export function videoMimeForPath(p: string): string | null {
  return VIDEO_MIME[extensionOf(p)] ?? null;
}

export function audioMimeForPath(p: string): string | null {
  return AUDIO_MIME[extensionOf(p)] ?? null;
}

/** Video and audio both stream with Range support. */
function streamMimeForPath(p: string): string | null {
  return videoMimeForPath(p) ?? audioMimeForPath(p);
}

/** One `bytes=` range against a file of `size` bytes: inclusive bounds, null when
 *  unsatisfiable, 'all' when absent or multi-range (answered with the whole file). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'all' | null {
  if (!header) return 'all';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.includes(',') ? 'all' : null;
  if (!m[1] && !m[2]) return null;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n <= 0 || size === 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return null;
  return { start, end };
}

/** Each root-confined candidate for `clean`: absolute paths under a root, or relative to any. */
function candidates(deps: PhoneDeps, clean: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of deps.roots()) {
    const root = raw.replace(/\/+$/, '');
    if (!root) continue;
    if (clean.startsWith('/')) { if (clean.startsWith(root + '/')) out.push([root, clean.slice(root.length + 1)]); }
    else out.push([root, clean]);
  }
  return out;
}

/** A video or sound file streamed from disk with Range support: phones refuse to seek,
 *  and iOS refuses to play at all, without 206 answers. */
async function serveStream(deps: PhoneDeps, clean: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const mime = streamMimeForPath(clean)!;
  for (const [root, rel] of candidates(deps, clean)) {
    const abs = await safeResolve(root, rel);
    if (!abs) continue;
    let fh;
    try { fh = await openForRead(abs); } catch { continue; }
    const st = await fh.stat().catch(() => null);
    if (!st || !st.isFile()) { await fh.close().catch(() => {}); continue; }
    const range = parseRange(req.headers.range, st.size);
    const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=60' };
    if (range === null) {
      await fh.close().catch(() => {});
      res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` });
      res.end();
      return true;
    }
    const { start, end } = range === 'all' ? { start: 0, end: st.size - 1 } : range;
    const length = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(range === 'all' ? 200 : 206, {
      ...base,
      'content-length': String(length),
      ...(range === 'all' ? {} : { 'content-range': `bytes ${start}-${end}/${st.size}` })
    });
    if (req.method === 'HEAD' || length === 0) { await fh.close().catch(() => {}); res.end(); return true; }
    const stream = fh.createReadStream({ start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }
  return false;
}

/** An image, video or sound file named by an absolute path or one relative to any root, under a root. */
export async function serveFile(deps: PhoneDeps, p: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const clean = p.trim();
  if (clean && !clean.includes('\0') && streamMimeForPath(clean)) {
    if (!(await serveStream(deps, clean, req, res))) { res.writeHead(404); res.end(); }
    return;
  }
  if (!clean || clean.includes('\0') || !isImagePath(clean)) { res.writeHead(404); res.end(); return; }
  for (const [root, rel] of candidates(deps, clean)) {
    const r = await readFileBinary(root, rel);
    if (r.ok) {
      res.writeHead(200, { 'content-type': r.mime, 'cache-control': 'private, max-age=60' });
      res.end(Buffer.from(r.bytes));
      return;
    }
  }
  res.writeHead(404); res.end();
}

/** The phone page: the file at `customPath` when it is an absolute, readable file, else the bundled string. */
function phonePage(customPath: string | undefined): string {
  try {
    if (customPath && isAbsolute(customPath) && statSync(customPath).isFile()) return readFileSync(customPath, 'utf8');
  } catch { /* an unusable override serves the bundled page */ }
  return PHONE_PAGE;
}

export function startPhoneServer(deps: PhoneDeps): { server: Server; url: string } | null {
  const host = tailscaleAddress();
  if (!host) return null;
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'",
          'referrer-policy': 'no-referrer',
        });
        res.end(brandPhonePage(phonePage(deps.pagePath?.()), brandTitle()));
        return;
      }
      const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('t');
      if (!tokenOk(auth, deps.token())) { json(res, 401, { error: 'unauthorized' }); return; }
      try {
        if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, snapshot(deps)); return; }
        if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/file') {
          await serveFile(deps, url.searchParams.get('p') ?? '', req, res);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/task') { json(res, 200, taskDetail(deps, url.searchParams.get('id') ?? '')); return; }
        if (req.method === 'GET' && url.pathname === '/api/transcript') { json(res, 200, transcriptTail(deps, url.searchParams.get('id') ?? '')); return; }
        if (req.method === 'GET' && url.pathname === '/api/agent-model') {
          const id = url.searchParams.get('id') ?? '';
          const known = knownAgent(deps, id);
          const info = known && deps.modelChoices ? await deps.modelChoices(id, true) : null;
          if (!known || !info) { json(res, 404, { ok: false, error: 'agent not found' }); return; }
          json(res, 200, { ok: true, isGod: known.isGod, ...info });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/agent-model') {
          const r = await agentModel(deps, await readBody(req));
          json(res, r.code, r.body);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/clear-pin') {
          if (!deps.clearPin) { json(res, 501, { ok: false, error: 'not implemented' }); return; }
          const b = await readBody(req) as { id?: unknown };
          if (typeof b.id !== 'string' || !b.id) { json(res, 400, { ok: false, error: 'missing id' }); return; }
          if (!knownAgent(deps, b.id) || !deps.clearPin(b.id)) { json(res, 404, { ok: false, error: 'agent not found' }); return; }
          json(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dismiss') { json(res, 200, await dismissAsk(deps, await readBody(req))); return; }
        if (req.method === 'POST' && url.pathname === '/api/answer') { json(res, 200, await answer(deps, await readBody(req))); return; }
        if (req.method === 'POST' && url.pathname === '/api/results/seen') { json(res, 200, { ok: true, count: deps.markResultsSeen ? deps.markResultsSeen() : 0 }); return; }
        if (req.method === 'POST' && url.pathname === '/api/backlog') { json(res, 200, await backlogCard(deps, await readBody(req))); return; }
        if (req.method === 'POST' && url.pathname === '/api/unbacklog') { json(res, 200, await unbacklog(deps, await readBody(req))); return; }
        if (req.method === 'POST' && url.pathname === '/api/message') {
          const b = await readBody(req) as { agentId?: unknown; text?: unknown };
          const ok = typeof b.agentId === 'string' && typeof b.text === 'string' && !!b.text.trim()
            && deps.enqueue(b.agentId, b.text.trim());
          json(res, 200, { ok });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/feedback/send') {
          if (!deps.sendFeedback) { json(res, 501, { error: 'not implemented' }); return; }
          const b = await readBody(req) as { reportId?: unknown; agentId?: unknown; note?: unknown };
          if (typeof b.reportId !== 'string' || typeof b.agentId !== 'string') {
            json(res, 400, { error: 'missing fields' }); return;
          }
          const resObj = await deps.sendFeedback(b.reportId, b.agentId, typeof b.note === 'string' ? b.note : undefined);
          json(res, 200, resObj);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/feedback/note') {
          if (!deps.saveFeedbackNote) { json(res, 501, { error: 'not implemented' }); return; }
          const b = await readBody(req) as { reportId?: unknown; note?: unknown };
          if (typeof b.reportId !== 'string' || typeof b.note !== 'string') {
            json(res, 400, { error: 'missing fields' }); return;
          }
          json(res, 200, await deps.saveFeedbackNote(b.reportId, b.note));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/feedback/dismiss') {
          if (!deps.dismissFeedback) { json(res, 501, { error: 'not implemented' }); return; }
          const b = await readBody(req) as { reportId?: unknown };
          if (typeof b.reportId !== 'string') {
            json(res, 400, { error: 'missing fields' }); return;
          }
          const resObj = await deps.dismissFeedback(b.reportId);
          json(res, 200, resObj);
          return;
        }
        json(res, 404, { error: 'not found' });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'bad request' });
      }
    })();
  });
  server.on('error', (e) => console.warn('[phone] server error:', e));
  server.listen(PHONE_PORT, host);
  return { server, url: `http://${host}:${PHONE_PORT}/` };
}
