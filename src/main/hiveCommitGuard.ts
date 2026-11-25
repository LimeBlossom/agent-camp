import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A hive file bigger than this is never staged. The hive holds notes, cards and the
 *  images they reference; a file this size is a build, archive, video or profile that
 *  `git add` cannot hash inside the commit timeout (2026-10-11: 3.3 GB of game builds
 *  under research/ failed every commit and left 131 GB of tmp objects). */
export const HIVE_COMMIT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** How long the hive commit may keep failing before the boss is told, and how often
 *  the warning repeats while it stays broken. */
export const HIVE_COMMIT_WARN_AFTER_MS = 60 * 60 * 1000;
export const HIVE_COMMIT_WARN_REPEAT_MS = 6 * 60 * 60 * 1000;

/** A tmp object this old cannot belong to a git process still running. */
const ORPHAN_TMP_MIN_AGE_MS = 60 * 60 * 1000;
/** mtime granularity slack when matching tmp files to the attempt that wrote them. */
const TMP_MTIME_SLACK_MS = 2000;

type GitOut = { ok: boolean; out: string };
export type GitRunner = (args: string[]) => GitOut | Promise<GitOut>;

/** Untracked and modified paths under `scope` (git pathspecs) that exceed `maxBytes`,
 *  sorted. Deleted paths and anything already ignored are skipped. A failed listing
 *  returns [] so the add proceeds exactly as it would have without the guard. */
export async function oversizedPaths(root: string, git: GitRunner, scope: string[], maxBytes = HIVE_COMMIT_MAX_FILE_BYTES): Promise<string[]> {
  const paths = new Set<string>();
  for (const kind of ['--others', '--modified']) {
    const res = await git(['ls-files', '-z', kind, '--exclude-standard', '--', ...scope]);
    if (!res.ok) continue;
    for (const p of res.out.split('\0')) if (p) paths.add(p);
  }
  const big: string[] = [];
  for (const p of paths) {
    try { if (statSync(join(root, p)).size > maxBytes) big.push(p); } catch { /* deleted */ }
  }
  return big.sort();
}

/** Exclude pathspecs for `paths`; `literal` so a `*` or `[` in a file name is not a glob. */
export function excludePathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(exclude,literal)${p}`);
}

/** Remove the tmp object files a killed `git add`/`commit` leaves in `.git/objects`
 *  (git deletes them itself on a normal error exit, not on SIGTERM). With `sinceMs`,
 *  only files written since then, i.e. by the attempt that just timed out; without it,
 *  only orphans old enough that no running git can own them. Returns bytes freed. */
export function removeTmpObjects(gitDir: string, sinceMs?: number, now = Date.now()): number {
  let freed = 0;
  const objects = join(gitDir, 'objects');
  for (const [dir, prefix] of [[objects, 'tmp_obj_'], [join(objects, 'pack'), 'tmp_pack_']] as const) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        const mine = sinceMs === undefined
          ? now - st.mtimeMs > ORPHAN_TMP_MIN_AGE_MS
          : st.mtimeMs >= sinceMs - TMP_MTIME_SLACK_MS;
        if (!mine) continue;
        rmSync(path, { force: true });
        freed += st.size;
      } catch { /* raced away */ }
    }
  }
  return freed;
}

export type HiveCommitHealth = {
  lastOkAt: number | null;
  failingSince: number | null;
  failures: number;
  lastError: string | null;
};

/** Tracks whether the hive commit is working and decides when the boss hears about it. */
export class HiveCommitMonitor {
  private health: HiveCommitHealth = { lastOkAt: null, failingSince: null, failures: 0, lastError: null };
  private lastWarnAt: number | null = null;

  snapshot(): HiveCommitHealth { return { ...this.health }; }

  ok(now = Date.now()): void {
    this.health = { lastOkAt: now, failingSince: null, failures: 0, lastError: null };
    this.lastWarnAt = null;
  }

  /** `lastCommitAt` (the repo's newest commit time) dates a streak that began before
   *  this process started, so a restart does not reset the clock. */
  fail(error: string, now = Date.now(), lastCommitAt?: number | null): void {
    const h = this.health;
    if (h.failingSince === null) h.failingSince = h.lastOkAt ?? lastCommitAt ?? now;
    h.failures++;
    h.lastError = error.slice(0, 500);
  }

  /** The warning to send the boss now, or null. */
  warning(now = Date.now()): string | null {
    const since = this.health.failingSince;
    if (since === null || now - since < HIVE_COMMIT_WARN_AFTER_MS) return null;
    if (this.lastWarnAt !== null && now - this.lastWarnAt < HIVE_COMMIT_WARN_REPEAT_MS) return null;
    this.lastWarnAt = now;
    const hours = ((now - since) / 3_600_000).toFixed(1);
    return `The hive auto-commit has failed for ${hours} h (${this.health.failures} attempts this run). `
      + `Nothing in the hive is being versioned. Last error: ${this.health.lastError ?? 'unknown'}`;
  }
}
