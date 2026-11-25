/**
 * Git directories a sandboxed Codex worker needs writable to commit. Codex's
 * workspace-write sandbox keeps every repo's .git read-only even when the repo, or a
 * parent of it, is a writable root; listing the git dir itself as a root lifts that.
 */
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** The git dirs for one working tree: its .git folder, or for a .git FILE (worktree,
 *  submodule) the gitdir it points at plus that gitdir's common dir. */
export function gitDirsOf(tree: string): string[] {
  const dotGit = join(tree, '.git');
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(dotGit); } catch { return []; }
  if (st.isDirectory()) return [dotGit];
  if (!st.isFile()) return [];
  let gitdir: string;
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return [];
    gitdir = isAbsolute(m[1]) ? m[1] : resolve(tree, m[1]);
    if (!statSync(gitdir).isDirectory()) return [];
  } catch { return []; }
  const out = [gitdir];
  try {
    const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim();
    if (common) out.push(isAbsolute(common) ? common : resolve(gitdir, common));
  } catch { /* a submodule's gitdir has no commondir */ }
  return out;
}

/** The root of the repo holding `dir` (dir itself or its nearest ancestor with a .git),
 *  or null. Never climbs to `ceiling` from below it: a home folder that is itself a repo
 *  would otherwise make every agent under it able to write the home repo's git dir. */
export function enclosingRepo(dir: string, ceiling?: string): string | null {
  let cur = resolve(dir);
  const stop = ceiling ? resolve(ceiling) : null;
  for (;;) {
    if (cur === stop && cur !== resolve(dir)) return null;
    try { lstatSync(join(cur, '.git')); return cur; } catch { /* keep climbing */ }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Absolute paths mentioned in free text (task titles and notes), trailing punctuation cut. */
export function absolutePathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s`'"(=:])(\/[^\s`'"()<>|,;*]+)/g)) {
    const p = m[1].replace(/[.:]+$/, '');
    if (p.length > 1) out.push(p);
  }
  return out;
}

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Repo roots an agent's open tasks point at, limited to repos inside `projectDirs` (the
 * agent's cwd and extra folders, the only places its sandbox can write anyway):
 *  - an absolute path in a task's text resolves to the repo holding it;
 *  - a task's `project` label matches a repo that is a direct child of a project dir
 *    by name, ignoring case and punctuation ("SphereSurvivors" finds Sphere-Survivors/).
 * Labels that name no folder (e.g. "Alpha" for BetaGame) resolve to nothing.
 */
export function taskRepoRoots(tasks: Array<{ text: string; project?: string }>, projectDirs: string[]): string[] {
  const roots = projectDirs.map((d) => resolve(d));
  const inside = (p: string): string | undefined => roots.find((r) => p === r || p.startsWith(r + sep));
  const out = new Set<string>();
  for (const t of tasks) {
    for (const p of absolutePathsIn(t.text)) {
      const base = inside(resolve(p));
      if (!base) continue;
      let probe = resolve(p);
      while (probe !== base && !existsSync(probe)) probe = dirname(probe);
      const repo = enclosingRepo(probe, dirname(base));
      if (repo && inside(repo)) out.add(repo);
    }
    const label = t.project ? normName(t.project) : '';
    if (!label) continue;
    for (const r of roots) {
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(r, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory() && normName(e.name) === label && gitDirsOf(join(r, e.name)).length) out.add(join(r, e.name));
      }
    }
  }
  return [...out];
}

/** Repos that are direct children of `dir`, plus repos directly inside a child whose name
 *  starts with `_` (a grouping folder such as `_Game Jams`). Hidden folders and symlinks
 *  are skipped, and nothing deeper is visited: a `_` folder inside a `_` folder is not. */
export function childRepos(dir: string, grouping = true): string[] {
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = resolve(dir, e.name);
    if (gitDirsOf(p).length > 0) out.push(p);
    if (grouping && e.name.startsWith('_')) out.push(...childRepos(p, false));
  }
  return out;
}

/**
 * Git dirs a sandboxed agent may write, so it can commit: the repo holding its cwd, the cwd
 * and each extra folder when it is a repo root, every repo directly inside one of them or
 * inside one of their `_` grouping folders (childRepos), and `taskRepos`. Nothing deeper (nested worktrees, submodules, repos two levels down): each
 * git dir becomes a writable root that Codex restates on every model call, and a full walk
 * of a parent folder made that hundreds of roots.
 */
export function agentGitDirs(cwd: string | undefined, extraDirs: string[], taskRepos: string[] = [], home?: string): string[] {
  const repos = new Set<string>();
  const own = cwd ? enclosingRepo(cwd, home) : null;
  if (own) repos.add(own);
  for (const d of [...(cwd ? [cwd] : []), ...extraDirs]) {
    if (gitDirsOf(d).length) repos.add(resolve(d));
    for (const r of childRepos(d)) repos.add(r);
  }
  for (const r of taskRepos) repos.add(resolve(r));
  const out = new Set<string>();
  for (const r of repos) for (const g of gitDirsOf(r)) out.add(g);
  return [...out];
}
