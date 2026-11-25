/**
 * A finished snip becomes a todo card for the boss, with the PNG, the app
 * context and the logs saved under <hive>/card-attachments/<card id>/, then an
 * inform so the boss categorizes and routes it. The inform lands in the inbox
 * whether or not the boss is awake.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HiveManager, HiveTask } from './hive';
import { DEFAULT_PRIORITY } from '../shared/taskPriority';
import { snipTitle } from '../shared/snip';
import { getValidProjects } from './campTools';
import { namesProject, readHiveProjects, type HiveProject } from './hiveProjects';
import type { SnipContext } from './snipContext';

export const SNIP_ATTACH_DIR = 'card-attachments';

/** Names Camp's own window files under: its board project is named or aliased one of these. */
const CAMP_NAMES = ['Camp', 'munder-difflin'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** `snip-YYYYMMDD-HHMMSS`, UTC. */
export function snipCardId(now: Date): string {
  return `snip-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/** The repo holding `dir`: the nearest folder with a `.git`, and for a worktree the main checkout it belongs to. */
function repoRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    const git = join(d, '.git');
    try {
      const st = statSync(git);
      if (st.isDirectory()) return d;
      if (st.isFile()) {
        const m = readFileSync(git, 'utf8').match(/^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m);
        return m ? m[1] : d;
      }
    } catch { /* no .git here */ }
    if (dirname(d) === d) return null;
  }
}

/** The board project a snip most likely belongs to, matched by name or alias (projects.json);
 *  else the project marked `fallback`, else the first. */
export function guessSnipProject(ctx: SnipContext, projects: readonly (string | HiveProject)[]): string {
  const list: HiveProject[] = projects.map((p) => typeof p === 'string' ? { name: p, aliases: [], mentions: [] } : p);
  const valid = (name: string): string | null => list.find((p) => namesProject(p, name))?.name ?? null;
  const fallback = list.find((p) => p.fallback)?.name ?? list[0]?.name ?? 'General';
  if (ctx.kind === 'camp') return CAMP_NAMES.map(valid).find(Boolean) ?? fallback;
  if (ctx.kind === 'unity' && ctx.unityProject) {
    return valid(basename(repoRoot(ctx.unityProject) ?? ctx.unityProject)) ?? fallback;
  }
  return fallback;
}

export interface SnipInput { note: string; png: Buffer; context: SnipContext; now: Date }

export interface FileSnipOptions {
  validProjects?: readonly (string | HiveProject)[];
  guessProject?: (ctx: SnipContext, projects: readonly (string | HiveProject)[]) => string;
  /** Who gets the routing inform: the `snip` message route, the boss by default. */
  to?: string;
}

export type FileSnipResult = { ok: true; cardId: string } | { ok: false; error: string };

export type SnipAttachment = { kind: 'snip' | 'context' | 'logs'; path: string };

function appLabel(ctx: SnipContext): string {
  const w = ctx.window;
  return w.title?.trim() || w.processName || w.wmClass?.[1] || w.wmClass?.[0] || 'screen';
}

function appLine(ctx: SnipContext): string {
  const w = ctx.window;
  const facts = [w.wmClass?.length ? `WM_CLASS ${w.wmClass.join(', ')}` : '', w.processName ?? '', w.pid ? `pid ${w.pid}` : '']
    .filter(Boolean).join('; ');
  return `App: ${appLabel(ctx)}${facts ? ` (${facts})` : ''}`;
}

export function fileSnipCard(hive: HiveManager, input: SnipInput, opts: FileSnipOptions = {}): FileSnipResult {
  const root = hive.root();
  if (!root) return { ok: false, error: 'no hive to file into: set the harness home in Camp settings' };

  const projects: readonly (string | HiveProject)[] = opts.validProjects ?? readHiveProjects(root) ?? getValidProjects(root);
  const validProjects = projects.map((p) => typeof p === 'string' ? p : p.name);
  const guessed = (opts.guessProject ?? guessSnipProject)(input.context, projects);
  const project = validProjects.includes(guessed) ? guessed : guessSnipProject({ ...input.context, kind: 'other' }, projects);

  const ledger = hive.tasks() as { tasks?: HiveTask[] };
  const taken = new Set((Array.isArray(ledger?.tasks) ? ledger.tasks : []).map((t) => t?.id));
  const base = snipCardId(input.now);
  let id = base;
  for (let n = 2; taken.has(id) || existsSync(join(root, SNIP_ATTACH_DIR, id)); n++) id = `${base}-${n}`;

  const dir = join(root, SNIP_ATTACH_DIR, id);
  const attachments: SnipAttachment[] = [
    { kind: 'snip', path: join(dir, 'snip.png') },
    { kind: 'context', path: join(dir, 'context.json') }
  ];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(attachments[0].path, input.png);
    writeFileSync(attachments[1].path, `${JSON.stringify(input.context, null, 2)}\n`);
    if (input.context.logs.length) {
      const logs = join(dir, 'logs.txt');
      writeFileSync(logs, input.context.logs.map((l) => `== ${l.source} ==\n${l.text.replace(/\n*$/, '\n')}`).join('\n'));
      attachments.push({ kind: 'logs', path: logs });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `could not save the snip: ${(e as Error).message}` };
  }

  const title = snipTitle(input.note, `Snip: ${appLabel(input.context)}`);
  const description = [
    input.note.trim(),
    `![snip](${attachments[0].path})`,
    appLine(input.context),
    ...(input.context.unityProject ? [`Unity project: ${input.context.unityProject}`] : []),
    `Context: ${attachments[1].path}`,
    ...(attachments[2] ? [`Logs: ${attachments[2].path}`] : []),
    ...(input.context.errors.length ? [`Not captured: ${input.context.errors.join('; ')}`] : [])
  ].filter(Boolean).join('\n\n');

  const card = {
    id, title, description,
    assignee: hive.registry().godId ?? 'god',
    project,
    status: 'todo',
    dependsOn: [],
    priority: DEFAULT_PRIORITY,
    createdAt: input.now.toISOString(),
    attachments
  } as HiveTask;
  if (!hive.addTask(card)) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `could not add card ${id} to tasks.json` };
  }

  hive.send({
    to: opts.to ?? 'god',
    act: 'inform',
    subject: `Snip filed as ${id}: ${title}`,
    body: `The human filed ${id} with the snip hotkey from ${appLabel(input.context)}. It is yours for now, project guessed as ${project}. `
      + 'Set its project, assignee and priority, then route it. '
      + `Snip, context and logs: ${dir}`
  }, 'snip');
  return { ok: true, cardId: id };
}
