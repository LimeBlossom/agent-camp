import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Activity = 'merge' | 'restart';

export function processIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] !== 'Z') return fields[19];
  } catch { /* no live process */ }
  return undefined;
}

export function campActivityInProgress(root: string, activity: Activity): boolean {
  const dir = join(root, '.camp-activity');
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const pid = Number(name.match(new RegExp(`^${activity}-(\\d+)$`))?.[1]);
    const started = Number.isInteger(pid) ? processIdentity(pid) : undefined;
    if (!started) continue;
    try { if (readFileSync(join(dir, name), 'utf8') === started) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}

export function beginCampActivity(root: string, activity: Activity): () => void {
  const started = processIdentity(process.pid);
  if (!started) return () => {};
  const dir = join(root, '.camp-activity');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, `${activity}-${process.pid}`);
  writeFileSync(marker, started, { mode: 0o600 });
  return () => {
    try { unlinkSync(marker); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}

export function campBuildLocked(installDir: string): boolean {
  const lock = join(installDir, '.build.lock');
  if (!existsSync(lock)) return false;
  try {
    execFileSync('flock', ['-n', '-E', '75', lock, 'true'], { stdio: 'ignore', timeout: 2_000 });
    return false;
  } catch (error) {
    if ((error as { status?: number }).status === 75) return true;
    throw new Error('Could not check the Camp autobuild lock.', { cause: error });
  }
}
