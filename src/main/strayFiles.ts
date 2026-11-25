import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realLeftoverDeps, type LeftoverDeps } from './leftovers';

/** An entry at the top of a watched folder that is not in that folder's baseline. */
export interface StrayEntry {
  path: string;
  isDir: boolean;
  sizeBytes: number | null;
  mtimeMs: number;
  /** The agent whose name the entry (or its git branch) carries, else null. */
  owner: string | null;
}

/** Watched folder -> entry names present when its baseline was taken. */
export type StrayBaseline = Record<string, string[]>;

/** Agents are allowed to write here, so it never counts as stray. */
export const HIVE_SCRATCH_NAME = '.hive-scratch';
const REPORT_MAX_LINES = 20;

export function readStrayBaseline(file: string): StrayBaseline {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StrayBaseline : {};
  } catch { return {}; }
}

function list(dir: string): string[] | null {
  try { return readdirSync(dir); } catch { return null; }
}

function ownerOf(name: string, branch: string | null, agentNames: string[]): string | null {
  for (const text of [name, branch ?? '']) {
    const lower = text.toLowerCase();
    const hit = agentNames.find((a) => lower.includes(a));
    if (hit) return hit;
  }
  return null;
}

/** New top-level entries in each of `dirs` versus `baselineFile`. A folder with no
 *  baseline yet has its current entries recorded as the baseline and reports nothing,
 *  which is the only write this makes. Report only: nothing listed is moved or deleted.
 *  `agentNames` match case-insensitively, single words of four letters or more. */
export async function scanStrayFiles(
  dirs: string[],
  baselineFile: string,
  agentNames: string[],
  d: Pick<LeftoverDeps, 'git' | 'sizeOf'> = realLeftoverDeps
): Promise<StrayEntry[]> {
  const names = agentNames.map((n) => n.toLowerCase()).filter((n) => /^[a-z]{4,}$/.test(n));
  const baseline = readStrayBaseline(baselineFile);
  let seeded = false;
  const out: StrayEntry[] = [];
  for (const dir of dirs) {
    const entries = list(dir);
    if (!entries) continue;
    const known = baseline[dir];
    if (!known) {
      baseline[dir] = [...entries].sort();
      seeded = true;
      continue;
    }
    const knownSet = new Set(known);
    for (const name of entries) {
      if (knownSet.has(name) || name === HIVE_SCRATCH_NAME) continue;
      const path = join(dir, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
      const isDir = st.isDirectory();
      const branch = isDir && existsSync(join(path, '.git')) ? (await d.git(path, ['branch', '--show-current']))?.trim() || null : null;
      out.push({
        path,
        isDir,
        sizeBytes: isDir ? await d.sizeOf(path) : st.size,
        mtimeMs: st.mtimeMs,
        owner: ownerOf(name, branch, names)
      });
    }
  }
  if (seeded) {
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function size(bytes: number | null): string {
  if (bytes === null) return 'size ?';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The standup's stray-files section, or null when there is nothing to list. */
export function formatStrayFiles(list: StrayEntry[], baselineFile: string): string | null {
  if (!list.length) return null;
  const lines = list.slice(0, REPORT_MAX_LINES).map((e) =>
    `- ${e.isDir ? 'dir' : 'file'} \`${e.path}\`: ${size(e.sizeBytes)}, modified ${new Date(e.mtimeMs).toISOString().slice(0, 10)}, likely owner ${e.owner ?? 'unknown'}`);
  const rest = list.length - REPORT_MAX_LINES;
  if (rest > 0) lines.push(`- and ${rest} more`);
  return `Stray files (${list.length}; report only, nothing was moved). Agent files belong under ${HIVE_SCRATCH_NAME}/<agent-id>/; ask the owner to move each there. If one is the human's, add its name to \`${baselineFile}\`:\n${lines.join('\n')}`;
}
