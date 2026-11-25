/**
 * Generic drop-folder notifiers: watches folders under <hive> and mails agents.
 * Replaces hand-written pollers (vault-inbox, card-proposals) with config-declared lanes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HiveMessage } from './hive';

export type DropFolderMode = 'count' | 'perFile';

export interface DropFolderConfig {
  /** Directory relative to hive root (or absolute path) */
  dir: string;
  /** File match pattern (e.g. '*.md', '*.json', '.md') */
  match?: string;
  /** Files or patterns to exclude (e.g. 'README.md') */
  exclude?: string | string[];
  /** Target agent recipient id (e.g. 'boss') */
  to?: string;
  /** Name of a file inside `dir` that contains the recipient agent id (e.g. 'KEEPER') */
  toFile?: string;
  /** Subject line or template for the delivered message */
  subject?: string;
  /** Body text or template for the delivered message */
  body?: string;
  /** How often to poll this folder in milliseconds (e.g. 60_000) */
  everyMs?: number;
  /** Minimum elapsed time before sending another notification for pending files (e.g. 1_800_000) */
  renudgeMs?: number;
  /** Processing mode: 'count' (counts pending files and sends 1 summary message) or 'perFile' (one message per file) */
  mode: DropFolderMode;
  /** Whether to pause polling during closing time */
  pauseDuringClosingTime?: boolean;
  /** Message action verb (default 'inform', or 'propose', 'request') */
  act?: string;
  /** perFile JSON lanes: fields a file must carry as non-empty strings, else it moves to .failed */
  requireFields?: string[];
  /** Removes the lane with this dir, seeded or not */
  disabled?: boolean;
}

export interface DropFolderState {
  lastNudgeAt?: number;
  lastCount?: number;
}

export interface ProcessDropFolderOptions {
  hiveRoot: string;
  folder: DropFolderConfig;
  deliver: (msg: Partial<HiveMessage>, source: string) => void;
  isAgentKnown?: (id: string) => boolean;
  isClosingTime?: () => boolean;
  now?: number;
  state?: DropFolderState;
}

export interface DropFolderResult {
  skipped?: boolean;
  reason?: 'closing-time' | 'no-recipient' | 'renudge-throttled' | 'no-files' | 'error';
  filesFound?: number;
  messagesSent?: number;
  filesProcessed?: string[];
  filesFailed?: string[];
  error?: string;
}

/** Seeded drop folders that replicate the existing hand-written pollers. */
export const DEFAULT_DROP_FOLDERS: readonly DropFolderConfig[] = [
  {
    dir: 'vault-inbox',
    match: '*.md',
    exclude: 'README.md',
    toFile: 'KEEPER',
    subject: 'vault-inbox: {{count}} pending',
    body: '{{count}} entries wait in {{dir}}. Drain them per your vault-inbox standing rule.',
    everyMs: 60_000,
    renudgeMs: 1_800_000,
    mode: 'count',
    pauseDuringClosingTime: true,
    act: 'inform'
  },
  {
    dir: 'card-proposals',
    match: '*.json',
    to: 'boss',
    subject: 'Card proposal: {{title}}',
    body: [
      'A Claude session outside the hive proposes a card. Create it with create_card (you pick the assignee), fold it into an existing card, or drop it. Nothing replies to the proposer.',
      '',
      'Project: {{project}}',
      'Suggested priority: {{priority}}',
      'From session in: {{source}}',
      '',
      '{{description}}'
    ].join('\n'),
    everyMs: 60_000,
    mode: 'perFile',
    requireFields: ['title', 'description'],
    pauseDuringClosingTime: true,
    act: 'propose'
  }
];

const DEFAULT_EVERY_MS = 60_000;
/** A timer fires a hair early; without slack a folder due at 60s would wait for the next 60s beat. */
const DUE_SLACK_MS = 1_000;
const MIN_EVERY_MS = 1_000;

/**
 * The seeds always run. A config entry with a seed's dir overrides it field by field,
 * an entry with a new dir adds a lane, and `disabled: true` removes a lane.
 */
export function getDropFolders(config?: { dropFolders?: DropFolderConfig[] } | null): DropFolderConfig[] {
  const lanes = new Map<string, DropFolderConfig>(DEFAULT_DROP_FOLDERS.map((f) => [f.dir, { ...f }]));
  for (const entry of Array.isArray(config?.dropFolders) ? config!.dropFolders! : []) {
    lanes.set(entry.dir, { ...lanes.get(entry.dir), ...entry });
  }
  return [...lanes.values()].filter((f) => !f.disabled);
}

const stringify = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/**
 * Replaces {{var}} and ${var}. With dropEmptyLines, a line whose placeholder resolved
 * to nothing is removed, so an optional field takes its label line with it.
 */
export function interpolateTemplate(template: string, vars: Record<string, unknown>, dropEmptyLines = false): string {
  const placeholder = /\{\{\s*(\w+)\s*\}\}|\$\{\s*(\w+)\s*\}/g;
  const fill = (line: string): string => line.replace(placeholder, (_m, a, b) => stringify(vars[a ?? b]));
  if (!dropEmptyLines) return fill(template);
  return template.split('\n').filter((line) => {
    const names = [...line.matchAll(placeholder)].map((m) => m[1] ?? m[2]);
    return names.length === 0 || names.every((n) => stringify(vars[n]).trim() !== '');
  }).map(fill).join('\n');
}

function globToRegExp(glob: string): RegExp {
  // A bare suffix such as '.md' means "ends with .md".
  const src = /[*?]/.test(glob) || !glob.startsWith('.') ? glob : `*${glob}`;
  const re = src.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`);
}

export function matchesPattern(filename: string, match?: string, exclude?: string | string[]): boolean {
  if (filename.startsWith('.')) return false;
  const excludes = exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude];
  if (excludes.some((e) => globToRegExp(e).test(filename))) return false;
  return match ? globToRegExp(match).test(filename) : true;
}

function folderDir(hiveRoot: string, folder: DropFolderConfig): string {
  return path.isAbsolute(folder.dir) ? folder.dir : path.join(hiveRoot, folder.dir);
}

/** Pending file names in the folder, sorted; a missing folder has none. */
export function scanDropFolder(hiveRoot: string, folder: DropFolderConfig): string[] {
  const dir = folderDir(hiveRoot, folder);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name !== folder.toFile && matchesPattern(e.name, folder.match, folder.exclude))
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

/** The agent to mail, or null when none is named or the registry does not know it. */
export function resolveRecipient(
  hiveRoot: string,
  folder: DropFolderConfig,
  isAgentKnown?: (id: string) => boolean
): string | null {
  let id = folder.to?.trim() ?? '';
  if (!id && folder.toFile) {
    try { id = fs.readFileSync(path.join(folderDir(hiveRoot, folder), folder.toFile), 'utf8').trim(); } catch { return null; }
  }
  if (!id) return null;
  return !isAgentKnown || isAgentKnown(id) ? id : null;
}

function moveInto(dir: string, sub: string, file: string): void {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.renameSync(path.join(dir, file), path.join(dir, sub, file));
}

export function processDropFolder(options: ProcessDropFolderOptions): DropFolderResult {
  const { hiveRoot, folder, deliver, isAgentKnown, isClosingTime, state } = options;
  const now = options.now ?? Date.now();
  if (folder.pauseDuringClosingTime && isClosingTime?.()) return { skipped: true, reason: 'closing-time' };

  const dir = folderDir(hiveRoot, folder);
  const files = scanDropFolder(hiveRoot, folder);
  if (files.length === 0) return { skipped: false, reason: 'no-files', filesFound: 0, messagesSent: 0 };

  const to = resolveRecipient(hiveRoot, folder, isAgentKnown);
  if (!to) return { skipped: true, reason: 'no-recipient', filesFound: files.length, messagesSent: 0 };

  const act = folder.act ?? 'inform';
  const source = path.basename(dir);
  const subject = folder.subject ?? '{{dir}}';
  const body = folder.body ?? '';

  if (folder.mode === 'count') {
    if (state && state.lastNudgeAt !== undefined && now - state.lastNudgeAt < (folder.renudgeMs ?? 0)) {
      return { skipped: true, reason: 'renudge-throttled', filesFound: files.length, messagesSent: 0 };
    }
    const vars = { count: files.length, dir, to };
    deliver({
      to, act: act as HiveMessage['act'], requires_reply: false,
      subject: interpolateTemplate(subject, vars),
      body: interpolateTemplate(body, vars, true)
    }, source);
    if (state) { state.lastNudgeAt = now; state.lastCount = files.length; }
    return { skipped: false, filesFound: files.length, messagesSent: 1 };
  }

  const processed: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const vars: Record<string, unknown> = { filename: f, dir, to };
    if (f.endsWith('.json')) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        for (const field of folder.requireFields ?? []) {
          if (typeof parsed[field] !== 'string' || !(parsed[field] as string).trim()) throw new Error(`missing ${field}`);
        }
        Object.assign(vars, parsed);
      } catch {
        moveInto(dir, '.failed', f);
        failed.push(f);
        continue;
      }
    }
    try {
      deliver({
        to, act: act as HiveMessage['act'], requires_reply: false,
        subject: interpolateTemplate(subject, vars),
        body: interpolateTemplate(body, vars, true)
      }, source);
    } catch { continue; }
    moveInto(dir, '.done', f);
    processed.push(f);
  }
  return { skipped: false, filesFound: files.length, messagesSent: processed.length, filesProcessed: processed, filesFailed: failed };
}

export class DropFolderWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private states = new Map<string, DropFolderState & { lastTickAt?: number }>();

  constructor(
    private getHiveRoot: () => string | null,
    private getDropFolders: () => DropFolderConfig[],
    private deliver: (msg: Partial<HiveMessage>, source: string) => void,
    private isClosingTime?: () => boolean,
    private isAgentKnown?: (id: string) => boolean
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Waits for the shortest folder interval, re-read each beat so a config edit takes effect. */
  private schedule(): void {
    if (!this.running) return;
    const everies = this.getDropFolders().map((f) => f.everyMs ?? DEFAULT_EVERY_MS);
    const wait = Math.max(MIN_EVERY_MS, everies.length ? Math.min(...everies) : DEFAULT_EVERY_MS);
    this.timer = setTimeout(() => {
      try { this.tick(); } catch (e) { console.error('[dropFolders] tick error:', e); }
      this.schedule();
    }, wait);
  }

  /** Runs every folder that is due and returns one result per folder run. */
  tick(now = Date.now()): DropFolderResult[] {
    const root = this.getHiveRoot();
    if (!root) return [];
    const results: DropFolderResult[] = [];
    for (const folder of this.getDropFolders()) {
      const key = folder.dir;
      const state = this.states.get(key) ?? {};
      this.states.set(key, state);
      const every = folder.everyMs ?? DEFAULT_EVERY_MS;
      if (state.lastTickAt !== undefined && now - state.lastTickAt < every - DUE_SLACK_MS) continue;
      state.lastTickAt = now;
      try {
        results.push(processDropFolder({
          hiveRoot: root, folder, deliver: this.deliver,
          isAgentKnown: this.isAgentKnown, isClosingTime: this.isClosingTime, now, state
        }));
      } catch (e) {
        results.push({ skipped: true, reason: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }
}
