/**
 * Machine-local folders the harness works in. None is spelled out in code: each comes
 * from an environment variable, else from the workspace root, which is config
 * `workspaceRoot` or the real parent folder of the hive home. The app exports the root
 * as MD_WORKSPACE_ROOT at startup so child processes (the Camp MCP servers) resolve the
 * same folders.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { expandTilde } from './fs';

type Env = Record<string, string | undefined>;

/** Config `workspaceRoot` when set, else the hive home's real parent (a symlinked home
 *  resolves to where it actually lives), else the user's home folder. */
export function deriveWorkspaceRoot(cfg: { workspaceRoot?: string | null; harnessHome?: string | null }): string {
  if (cfg.workspaceRoot && cfg.workspaceRoot.trim()) return resolve(expandTilde(cfg.workspaceRoot.trim()));
  if (cfg.harnessHome && cfg.harnessHome.trim()) {
    const home = resolve(expandTilde(cfg.harnessHome.trim()));
    let real = home;
    try { real = realpathSync(home); } catch { /* not created yet: use it as given */ }
    return dirname(real);
  }
  return homedir();
}

const LAUNCH_WORKSPACE_ROOT = process.env.MD_WORKSPACE_ROOT;

/** Sets MD_WORKSPACE_ROOT from config unless the launch environment set it. Call again
 *  after a config write: onboarding sets the hive home without a relaunch. */
export function exportWorkspaceRoot(
  cfg: { workspaceRoot?: string | null; harnessHome?: string | null },
  env: Env = process.env,
  launchRoot: string | undefined = LAUNCH_WORKSPACE_ROOT
): string {
  const root = launchRoot || deriveWorkspaceRoot(cfg);
  env.MD_WORKSPACE_ROOT = root;
  return root;
}

export function workspaceRoot(env: Env = process.env): string {
  return env.MD_WORKSPACE_ROOT || homedir();
}

/** Where agent build output lives instead of the hive folder: a run's results reach
 *  gigabytes, and inside the hive they filled the root disk (2026-10-11). */
export function hiveScratchRoot(env: Env = process.env): string {
  return env.MD_HIVE_SCRATCH_ROOT || join(workspaceRoot(env), '.hive-scratch');
}

/** Top-level folders where agents must not leave files (they belong in
 *  <workspace>/.hive-scratch/<agent-id>/): the workspace root, and each folder between it
 *  and a merge repo. */
export function strayWatchDirs(repoPaths: readonly string[] = [], env: Env = process.env): string[] {
  const root = workspaceRoot(env);
  const dirs = new Set([root]);
  for (const repo of repoPaths) {
    const rel = relative(root, resolve(repo));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    let d = dirname(resolve(repo));
    while (d !== root && d.startsWith(root)) { dirs.add(d); d = dirname(d); }
  }
  return [...dirs];
}
