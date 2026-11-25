/**
 * What was under a snip: the X11 window, its process, and a capped tail of the
 * one log that app writes. Every outside call goes through `deps`, so the
 * read allowlist below is the whole of what this module touches:
 *   X11:    xprop -root _NET_CLIENT_LIST_STACKING, xwininfo -id, xprop -id
 *   /proc:  <pid>/comm and <pid>/cmdline only
 *   logs:   Unity -> ~/.config/unity3d/Editor.log; Camp -> <userData>/renderer.log
 *           and <hive>/log.jsonl; anything else -> journalctl --user _PID=<pid>
 * Secrets are masked and anything naming a private folder is withheld before
 * the result leaves this module, because it goes onto a card agents read.
 */
import type { Rect } from '../shared/snip';

export interface StackWindow { id: string; x: number; y: number; width: number; height: number; viewable: boolean }

export interface SnipWindow {
  id?: string;
  title?: string;
  wmClass?: string[];
  pid?: number;
  processName?: string;
  cmdline?: string;
}

export type SnipAppKind = 'unity' | 'camp' | 'other';

export interface SnipContext {
  window: SnipWindow;
  kind: SnipAppKind;
  unityProject?: string;
  logs: Array<{ source: string; text: string }>;
  errors: string[];
}

export interface SnipContextDeps {
  run: (cmd: string, args: string[]) => Promise<string>;
  readText: (path: string) => string | null | Promise<string | null>;
  campPid: number;
  home: string;
  userData: string;
  hiveRoot: string | null;
}

export const SNIP_LOG_MAX_LINES = 200;
export const SNIP_LOG_MAX_BYTES = 32 * 1024;
export const SNIP_CMDLINE_MAX = 2000;

/** Folders whose names never reach a card, matched anywhere in a line. */
export const PRIVATE_PATH_PREFIXES: readonly string[] = [
  ['Storage', 'Games', 'Other'].join('/')
];

const WITHHELD = '[withheld: private folder]';
const REDACTED = '[redacted]';

/** `_NET_CLIENT_LIST_STACKING` window ids, bottom to top. */
export function parseStackingIds(out: string): string[] {
  const hash = out.indexOf('#');
  return hash < 0 ? [] : out.slice(hash + 1).match(/0x[0-9a-f]+/gi) ?? [];
}

export function parseXwininfo(out: string, id: string): StackWindow | null {
  const num = (label: string): number | null => {
    const m = out.match(new RegExp(`${label}:\\s*(-?\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const x = num('Absolute upper-left X');
  const y = num('Absolute upper-left Y');
  const width = num('Width');
  const height = num('Height');
  if (x === null || y === null || width === null || height === null) return null;
  return { id, x, y, width, height, viewable: /Map State:\s*IsViewable/.test(out) };
}

const quoted = (s: string): string[] =>
  [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));

/** Title (`_NET_WM_NAME`, else `WM_NAME`), both `WM_CLASS` parts and `_NET_WM_PID`, whichever xprop found. */
export function parseWindowProps(out: string): { title?: string; wmClass?: string[]; pid?: number } {
  const props: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z_]+)\([A-Z0-9_]+\)\s*=\s*(.*)$/);
    if (m) props[m[1]] = m[2];
  }
  const result: { title?: string; wmClass?: string[]; pid?: number } = {};
  const title = quoted(props._NET_WM_NAME ?? '')[0] ?? quoted(props.WM_NAME ?? '')[0];
  if (title !== undefined) result.title = title;
  const wmClass = quoted(props.WM_CLASS ?? '');
  if (wmClass.length) result.wmClass = wmClass;
  const pid = Number(props._NET_WM_PID);
  if (props._NET_WM_PID && Number.isInteger(pid) && pid > 0) result.pid = pid;
  return result;
}

/** The topmost viewable window holding the snip's centre. `stack` is topmost first. */
export function windowUnderRect(stack: readonly StackWindow[], rect: Rect): StackWindow | null {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return stack.find((w) => w.viewable && cx >= w.x && cx < w.x + w.width && cy >= w.y && cy < w.y + w.height) ?? null;
}

/** The value after Unity's `-projectPath`, which it accepts in any case. */
export function unityProjectPath(args: readonly string[]): string | null {
  const i = args.findIndex((a) => a.toLowerCase() === '-projectpath');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const CAMP_CLASSES = new Set(['munder-difflin', 'camp']);

export function classifyApp(app: { pid?: number; wmClass?: string[]; processName?: string }, campPid: number): SnipAppKind {
  const classes = (app.wmClass ?? []).map((c) => c.toLowerCase());
  if (app.pid === campPid || classes.some((c) => CAMP_CLASSES.has(c))) return 'camp';
  if (classes.includes('unity') || app.processName === 'Unity') return 'unity';
  return 'other';
}

const SECRET_WORD = '[\\w.-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)[\\w.-]*';
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
  // key=value / key: value, including -licensingToken=...
  [new RegExp(`(${SECRET_WORD})(\\s*[=:]\\s*)("?)[^\\s"&]+`, 'gi'), `$1$2$3${REDACTED}`],
  // --api-key value
  [new RegExp(`(--?${SECRET_WORD})(\\s+)(?!-)(?!\\[redacted\\])\\S+`, 'gi'), `$1$2${REDACTED}`]
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}

const namesPrivate = (text: string): boolean => PRIVATE_PATH_PREFIXES.some((p) => text.includes(p));

/** Every line naming a private folder replaced whole, so the file name after it goes too. */
export function withholdPrivate(text: string): string {
  return text.split('\n').map((l) => (namesPrivate(l) ? WITHHELD : l)).join('\n');
}

/** The newest `maxLines` lines, then the newest `maxBytes` bytes of those. */
export function tailText(text: string, maxLines: number, maxBytes: number): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  let out = lines.slice(-maxLines).join('\n');
  const buf = Buffer.from(out, 'utf8');
  if (buf.length > maxBytes) {
    let start = buf.length - maxBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    out = buf.subarray(start).toString('utf8');
    const nl = out.indexOf('\n');
    if (nl >= 0) out = out.slice(nl + 1);
  }
  return out;
}

const clean = (text: string): string => withholdPrivate(redactSecrets(text));
const capChars = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** All managed windows with their geometry, topmost first. Empty when X11 cannot be read. */
export async function windowStack(deps: Pick<SnipContextDeps, 'run'>): Promise<StackWindow[]> {
  let ids: string[];
  try {
    ids = parseStackingIds(await deps.run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']));
  } catch {
    return [];
  }
  const windows = await Promise.all(ids.map(async (id) => {
    try { return parseXwininfo(await deps.run('xwininfo', ['-id', id]), id); } catch { return null; }
  }));
  return windows.filter((w): w is StackWindow => !!w).reverse();
}

async function readLog(deps: SnipContextDeps, path: string, source: string, errors: string[]): Promise<{ source: string; text: string } | null> {
  try {
    const raw = await deps.readText(path);
    if (raw === null || !raw.trim()) return null;
    return { source, text: clean(tailText(raw, SNIP_LOG_MAX_LINES, SNIP_LOG_MAX_BYTES)) };
  } catch (e) {
    errors.push(`${source}: ${errText(e)}`);
    return null;
  }
}

/** The window under `rect` and its logs. Never throws: what could not be read is listed in `errors`. */
export async function collectSnipContext(stack: readonly StackWindow[], rect: Rect, deps: SnipContextDeps): Promise<SnipContext> {
  const errors: string[] = [];
  const under = windowUnderRect(stack, rect);
  if (!under) {
    errors.push('no window found under the snip (X11 window list empty or unreadable)');
    return { window: {}, kind: 'other', logs: [], errors };
  }

  let props: ReturnType<typeof parseWindowProps> = {};
  try {
    props = parseWindowProps(await deps.run('xprop', ['-id', under.id, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID']));
  } catch (e) {
    errors.push(`xprop: ${errText(e)}`);
  }

  let processName: string | undefined;
  let args: string[] = [];
  if (props.pid) {
    try {
      processName = (await deps.readText(`/proc/${props.pid}/comm`))?.trim() || undefined;
      args = ((await deps.readText(`/proc/${props.pid}/cmdline`)) ?? '').split('\0').filter(Boolean);
    } catch (e) {
      errors.push(`/proc/${props.pid}: ${errText(e)}`);
    }
  }

  const kind = classifyApp({ pid: props.pid, wmClass: props.wmClass, processName }, deps.campPid);
  const identity = [props.title ?? '', ...(props.wmClass ?? []), processName ?? '', ...args];
  if (identity.some(namesPrivate)) {
    return { window: { id: under.id, title: WITHHELD, pid: props.pid }, kind: 'other', logs: [], errors };
  }

  const window: SnipWindow = { id: under.id };
  if (props.title !== undefined) window.title = clean(props.title);
  if (props.wmClass) window.wmClass = props.wmClass;
  if (props.pid) window.pid = props.pid;
  if (processName) window.processName = processName;
  if (args.length) window.cmdline = capChars(clean(args.join(' ')), SNIP_CMDLINE_MAX);

  const ctx: SnipContext = { window, kind, logs: [], errors };
  const add = (log: { source: string; text: string } | null): void => { if (log) ctx.logs.push(log); };

  if (kind === 'unity') {
    const project = unityProjectPath(args);
    if (project) ctx.unityProject = project;
    add(await readLog(deps, `${deps.home}/.config/unity3d/Editor.log`, '~/.config/unity3d/Editor.log', errors));
  } else if (kind === 'camp') {
    add(await readLog(deps, `${deps.userData}/renderer.log`, `${deps.userData}/renderer.log`, errors));
    if (deps.hiveRoot) add(await readLog(deps, `${deps.hiveRoot}/log.jsonl`, `${deps.hiveRoot}/log.jsonl`, errors));
  } else if (props.pid) {
    try {
      const out = await deps.run('journalctl', ['--user', `_PID=${props.pid}`, '-n', String(SNIP_LOG_MAX_LINES), '--no-pager', '-o', 'short-iso']);
      if (out.trim() && !/^-- No entries --\s*$/.test(out.trim())) {
        add({ source: `journalctl --user _PID=${props.pid}`, text: clean(tailText(out, SNIP_LOG_MAX_LINES, SNIP_LOG_MAX_BYTES)) });
      }
    } catch (e) {
      errors.push(`journalctl: ${errText(e)}`);
    }
  }
  return ctx;
}
