/**
 * One-shot boot migration onto the palace the current mine input set builds.
 *
 * A palace whose `.scope` marker is not PALACE_SCOPE was mined under an older
 * input rule, so its chunks are not what the mine loop feeds today. It is
 * renamed aside (never deleted here) with a sha256 + byte-count manifest of
 * the tree taken before and after the rename, and a fresh palace holding only
 * the marker takes its place. Bump PALACE_SCOPE whenever the mine input set
 * changes and every install rebuilds on its next mine pass.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync
} from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PALACE_SCOPE = 'agent-notes-v1';
export const SCOPE_MARKER = '.scope';

export type PalaceScopeAction = 'current' | 'rotated' | 'refused' | 'fresh';

export interface PalaceScopeResult {
  action: PalaceScopeAction;
  /** Where the old palace went ('rotated' only). */
  to?: string;
  /** The before/after manifest directory ('rotated' only). */
  manifestDir?: string;
}

export interface PalaceScopeOptions {
  home: string;
  now: Date;
  /** True while any mempalace process may hold the palace open. */
  mempalaceLive: () => boolean;
}

/** A mempalace CLI process: the entrypoint itself, an interpreter running it
 *  (`python3 ~/.local/bin/mempalace`), or `python -m mempalace`. Only the
 *  program position counts, so an agent whose prompt merely mentions
 *  mempalace never blocks the rotation. */
export function isMempalaceArgv(argv: string[]): boolean {
  const isEntry = (a: string | undefined) => !!a && /(^|[\\/])mempalace(\.exe)?$/.test(a);
  if (isEntry(argv[0]) || isEntry(argv[1])) return true;
  const m = argv.indexOf('-m');
  return m >= 0 && m <= 2 && argv[m + 1] === 'mempalace';
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function utcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

/** Chunked, because a palace's chroma.sqlite3 can pass Node's 2 GiB buffer cap. */
function sha256File(f: string): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = openSync(f, 'r');
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** `sha256sum` lines ("<hex>  ./rel", sorted) and the total byte count. */
function manifest(dir: string): { sha: string; size: string } {
  let bytes = 0;
  const lines = filesUnder(dir).map((f) => {
    bytes += statSync(f).size;
    const hex = sha256File(f);
    return `${hex}  ./${relative(dir, f).split(sep).join('/')}`;
  }).sort();
  return { sha: lines.join('\n') + (lines.length ? '\n' : ''), size: `${bytes}\n` };
}

function readMarker(palace: string): string | null {
  try { return readFileSync(join(palace, SCOPE_MARKER), 'utf8'); } catch { return null; }
}

function freshPalace(palace: string): void {
  mkdirSync(palace, { recursive: true });
  writeFileSync(join(palace, SCOPE_MARKER), PALACE_SCOPE);
}

export function ensurePalaceScope({ home, now, mempalaceLive }: PalaceScopeOptions): PalaceScopeResult {
  const palace = join(home, 'palace');
  if (!existsSync(palace)) {
    freshPalace(palace);
    return { action: 'fresh' };
  }
  if (readMarker(palace) === PALACE_SCOPE) return { action: 'current' };
  if (mempalaceLive()) return { action: 'refused' };

  const base = join(home, `palace-old-${utcDay(now)}`);
  let to = base;
  for (let n = 2; existsSync(to); n += 1) to = `${base}-${n}`;

  const before = manifest(palace);
  renameSync(palace, to);
  const after = manifest(to);

  let manifestDir = join(home, 'palace-rotations', utcStamp(now));
  for (let n = 2; existsSync(manifestDir); n += 1) manifestDir = join(home, 'palace-rotations', `${utcStamp(now)}-${n}`);
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, 'before.sha'), before.sha);
  writeFileSync(join(manifestDir, 'after.sha'), after.sha);
  writeFileSync(join(manifestDir, 'before.size'), before.size);
  writeFileSync(join(manifestDir, 'after.size'), after.size);

  freshPalace(palace);
  return { action: 'rotated', to, manifestDir };
}
