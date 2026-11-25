/**
 * The board's projects, from `<hive>/projects.json`. An entry is a project name, or an
 * object that also says where the project's repo lives so the harness can fast-forward
 * merge its done branches:
 *
 *   { "name": "Game", "aliases": ["GameRepo"], "mentions": ["GM", "game-"],
 *     "repo": "~/src/game", "branch": "main" }
 *
 * `repo` may start with `~`, may be relative to the workspace root, and may use
 * `${ENV_VAR}`; one that expands to nothing is left out. `branch` is the integration
 * branch and is required with `repo`: it is never read from the main tree, where a worker
 * can leave its own branch checked out. `aliases` are
 * other spellings of the project (folder names, old names). `mentions` are words that
 * point a card with no project at this repo; one ending in `-` matches as a prefix.
 * `"fallback": true` marks the project a snip files under when nothing else fits.
 * `"artPipeline": true` makes kind "code" on its unit-art cards need a kindReason.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { expandTilde } from './fs';
import { workspaceRoot } from './workspacePaths';

type Env = Record<string, string | undefined>;

export interface HiveProject {
  name: string;
  aliases: string[];
  mentions: string[];
  repo?: string;
  branch?: string;
  fallback?: boolean;
  artPipeline?: boolean;
}

export interface MergeRepo {
  /** The board project; merge reports name the repo by it. */
  project: string;
  path: string;
  /** The integration branch the harness fast-forwards. */
  branch: string;
  aliases: string[];
  mentions: string[];
}

export const normProject = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];

function parseEntry(v: unknown): HiveProject | null {
  if (typeof v === 'string') return v.trim() ? { name: v.trim(), aliases: [], mentions: [] } : null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) return null;
  const out: HiveProject = { name: o.name.trim(), aliases: strings(o.aliases), mentions: strings(o.mentions) };
  if (typeof o.repo === 'string' && o.repo.trim()) out.repo = o.repo.trim();
  if (typeof o.branch === 'string' && o.branch.trim()) out.branch = o.branch.trim();
  if (o.fallback === true) out.fallback = true;
  if (o.artPipeline === true) out.artPipeline = true;
  return out;
}

/** The projects in `<hive>/projects.json`, or null when the file is missing, malformed or empty. */
export function readHiveProjects(hiveRoot?: string | null, env: Env = process.env): HiveProject[] | null {
  const root = hiveRoot || env.HIVE_ROOT || '';
  if (!root) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const entries = parsed.map(parseEntry);
    return entries.every((e): e is HiveProject => e !== null) ? entries : null;
  } catch {
    return null;
  }
}

/** `repo` with `${VAR}`, `~` and a workspace-relative path resolved; '' when a variable is unset. */
export function resolveRepoPath(repo: string, env: Env = process.env): string {
  let unset = false;
  const expanded = repo.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (!v) unset = true;
    return v ?? '';
  });
  if (unset || !expanded.trim()) return '';
  const path = expandTilde(expanded.trim());
  return isAbsolute(path) ? path : join(workspaceRoot(env), path);
}

export function mergeReposOf(projects: readonly HiveProject[], env: Env = process.env): MergeRepo[] {
  const out: MergeRepo[] = [];
  for (const p of projects) {
    const path = p.repo ? resolveRepoPath(p.repo, env) : '';
    if (path && p.branch) out.push({ project: p.name, path, branch: p.branch, aliases: p.aliases, mentions: p.mentions });
  }
  return out;
}

/** The repos the harness merges into: every project in `<hive>/projects.json` with a `repo`. */
export function loadMergeRepos(hiveRoot?: string | null, env: Env = process.env): MergeRepo[] {
  return mergeReposOf(readHiveProjects(hiveRoot, env) ?? [], env);
}

/** True when `name` is the project or one of its aliases. */
export function namesProject(p: { name?: string; project?: string; aliases: readonly string[] }, name: string): boolean {
  const n = normProject(name);
  return !!n && [p.name ?? p.project ?? '', ...p.aliases].some((a) => normProject(a) === n);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `text` carries one of `mentions`: a word, or a prefix for one ending in `-`. */
export function mentionsAny(text: string, mentions: readonly string[]): boolean {
  return mentions.some((m) => m.endsWith('-')
    ? text.includes(m)
    : new RegExp(`\\b${escape(m).replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
}

/** Names of the projects marked `artPipeline`. */
export function artPipelineProjects(hiveRoot?: string | null, env: Env = process.env): Set<string> {
  return new Set((readHiveProjects(hiveRoot, env) ?? []).filter((p) => p.artPipeline).map((p) => p.name));
}
