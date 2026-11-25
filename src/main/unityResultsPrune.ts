/**
 * Daily cleanup of Unity broker results: a run folder under any `unity-results` dir whose
 * newest file is older than the cutoff is deleted. Results are kept 7 days.
 *
 * Only direct children of a folder literally named `unity-results` are ever removed, and a
 * symlinked child is skipped. Age is the newest mtime anywhere inside the run, so a run an
 * agent is still writing outputs into, or that is mid-flight, stays.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

export const UNITY_RESULTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const UNITY_RESULTS_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const RESULTS_DIR_NAME = 'unity-results';

export interface PruneEntry { path: string; bytes: number; newestMs: number }
export interface PruneReport { deleted: PruneEntry[]; kept: number; freedBytes: number; errors: string[] }

/** Newest mtime and total size of a tree, never following symlinks. */
export function treeStats(path: string): { newestMs: number; bytes: number } {
  const st = lstatSync(path);
  let newestMs = st.mtimeMs;
  let bytes = st.isFile() ? st.size : 0;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      const child = treeStats(join(path, name));
      if (child.newestMs > newestMs) newestMs = child.newestMs;
      bytes += child.bytes;
    }
  }
  return { newestMs, bytes };
}

/** Every `unity-results` folder the broker can write: `<scratchRoot>/<agent>/unity-results`
 *  and the fallback `<hiveRoot>/agents/<agent>/unity-results`. */
export function unityResultsDirs(hiveRoot: string | null, scratchRoot: string | null): string[] {
  const parents = [scratchRoot, hiveRoot ? join(hiveRoot, 'agents') : null].filter((p): p is string => !!p);
  const out: string[] = [];
  for (const parent of parents) {
    let agents: string[] = [];
    try { agents = readdirSync(parent); } catch { continue; }
    for (const a of agents) {
      const dir = join(parent, a, RESULTS_DIR_NAME);
      try { if (lstatSync(dir).isDirectory()) out.push(dir); } catch { /* none */ }
    }
  }
  return out;
}

export function pruneUnityResults(dirs: string[], nowMs: number, maxAgeMs = UNITY_RESULTS_MAX_AGE_MS, dryRun = false): PruneReport {
  const report: PruneReport = { deleted: [], kept: 0, freedBytes: 0, errors: [] };
  const cutoff = nowMs - maxAgeMs;
  for (const dir of dirs) {
    if (basename(dir) !== RESULTS_DIR_NAME) { report.errors.push(`not a ${RESULTS_DIR_NAME} dir: ${dir}`); continue; }
    let runs: string[] = [];
    try { runs = readdirSync(dir); } catch (e) { report.errors.push(`${dir}: ${(e as Error).message}`); continue; }
    for (const run of runs) {
      const path = join(dir, run);
      try {
        if (lstatSync(path).isSymbolicLink()) { report.kept++; continue; }
        const { newestMs, bytes } = treeStats(path);
        if (newestMs >= cutoff) { report.kept++; continue; }
        if (!dryRun) rmSync(path, { recursive: true, force: true });
        report.deleted.push({ path, bytes, newestMs });
        report.freedBytes += bytes;
      } catch (e) {
        report.errors.push(`${path}: ${(e as Error).message}`);
      }
    }
  }
  return report;
}
