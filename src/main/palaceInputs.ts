/**
 * Which files of an agent's folder the palace mines.
 *
 * Markdown only: the agent's memory files and any other top-level note, plus
 * everything under research/ and reviews/. Transcripts, results json, html and
 * bundled js swamped search when whole folders were mined, so nothing else
 * qualifies. MemPalace 3.12 `mine` takes only a directory and has no allowlist
 * flag, hence the staged copy.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Top-level folders whose notes are mined at any depth. */
const NOTE_DIRS = ['research', 'reviews'];

/** The live memory files. Any other memory* file is a snapshot of one
 *  (memory-before-*, memory.pre-*, memory-checkpoint-*) and would only repeat
 *  its hits. */
const MEMORY_FILES = ['memory.md', 'memory-archive.md'];

/** Harness-written task state, not something the agent learned. */
function isTaskState(name: string): boolean {
  return name === 'my-tasks.md' || name.startsWith('handoff');
}

/** Snapshot names agents use at any depth. */
const SNAPSHOT = /^memory[-.](before|pre|checkpoint)/i;

function isMemorySnapshot(name: string, topLevel: boolean): boolean {
  if (SNAPSHOT.test(name)) return true;
  return topLevel && name.startsWith('memory') && !MEMORY_FILES.includes(name);
}

/** Churn that would bury the notes: tool homes, scratch, backups, art workspaces. */
function isChurn(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('.') || n.startsWith('scratch') || n.includes('backup') || n.endsWith('-art');
}

function isNote(name: string): boolean {
  return name.endsWith('.md') && !isTaskState(name) && !isChurn(name);
}

/** Directory entries, or none when the directory is unreadable. Symlinks are
 *  neither files nor directories here, so they are never followed. */
function entries(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function walkNotes(abs: string, rel: string, out: string[]): void {
  for (const e of entries(abs)) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (!isChurn(e.name)) walkNotes(join(abs, e.name), r, out); }
    else if (e.isFile() && isNote(e.name) && !isMemorySnapshot(e.name, false)) out.push(r);
  }
}

/** Mined files as sorted '/'-separated paths relative to `agentDir`. */
export function minedNoteFiles(agentDir: string): string[] {
  const out: string[] = [];
  for (const e of entries(agentDir)) {
    if (e.isFile() && isNote(e.name) && !isMemorySnapshot(e.name, true)) out.push(e.name);
    else if (e.isDirectory() && NOTE_DIRS.includes(e.name)) walkNotes(join(agentDir, e.name), e.name, out);
  }
  return out.sort();
}

/** Replace `stageDir`'s contents with copies of the mined files at their
 *  relative paths, so a mine of `stageDir` sees nothing else and a note the
 *  agent removed is gone. */
export function stageNoteFiles(agentDir: string, stageDir: string): void {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const rel of minedNoteFiles(agentDir)) {
    const dest = join(stageDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    try { copyFileSync(join(agentDir, rel), dest); } catch { /* removed mid-walk */ }
  }
}

/** Change signature over the mined set: each path with its mtime, so an
 *  edited, added or removed note all move it. */
export function noteSignature(agentDir: string): string {
  return minedNoteFiles(agentDir).map((rel) => {
    try { return `${rel}:${statSync(join(agentDir, rel)).mtimeMs}`; } catch { return `${rel}:-1`; }
  }).join('|');
}
