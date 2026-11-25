/**
 * Off-main-thread writes for hive files the app touches on every beat. The Electron
 * main thread forwards keystrokes to the renderer, and the hive can sit on a spinning
 * disk: a sync append or rewrite there waits in write throttling for hundreds of ms
 * whenever another process is writing, and typing freezes for that long.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';

/** Ordered async appends per file. Lines queued while a write is in flight go out
 *  together in the next one, so order is kept and a burst costs one write. */
export class AppendQueue {
  private pending = new Map<string, string[]>();
  private writing = new Map<string, string>();
  private inFlight = new Map<string, Promise<void>>();

  append(path: string, text: string): void {
    const q = this.pending.get(path);
    if (q) q.push(text); else this.pending.set(path, [text]);
    if (!this.inFlight.has(path)) this.drain(path);
  }

  /** Text queued for `path` that is not on disk yet, oldest first. */
  unwritten(path: string): string {
    return (this.writing.get(path) ?? '') + (this.pending.get(path) ?? []).join('');
  }

  private drain(path: string): void {
    const run = (async () => {
      for (;;) {
        const q = this.pending.get(path);
        if (!q?.length) break;
        this.pending.delete(path);
        const text = q.join('');
        this.writing.set(path, text);
        try { await appendFile(path, text, 'utf8'); } catch { /* best-effort, like the sync append it replaces */ }
        this.writing.delete(path);
      }
    })().finally(() => { this.inFlight.delete(path); this.writing.delete(path); });
    this.inFlight.set(path, run);
  }

  /** Resolves once everything queued so far is on disk. */
  async flush(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  /** Last resort at process exit: writes what is still queued, synchronously. */
  flushSync(): void {
    for (const [path, q] of this.pending) {
      try { appendFileSync(path, q.join(''), 'utf8'); } catch { /* exiting anyway */ }
    }
    this.pending.clear();
  }
}

/** Async whole-file writes where only the newest content matters (a snapshot). A
 *  write requested while one is in flight replaces any older pending one. Writes go
 *  to a temp file and rename over the target, so readers never see half a file. */
export class LatestWriter {
  private pending = new Map<string, string>();
  private writing = new Map<string, string>();
  private inFlight = new Map<string, Promise<void>>();

  /** The newest content asked for that may not be on disk yet; undefined when disk is current. */
  latest(path: string): string | undefined {
    return this.pending.get(path) ?? this.writing.get(path);
  }

  write(path: string, content: string): void {
    this.pending.set(path, content);
    if (!this.inFlight.has(path)) this.drain(path);
  }

  private drain(path: string): void {
    const run = (async () => {
      for (;;) {
        const content = this.pending.get(path);
        if (content === undefined) break;
        this.pending.delete(path);
        this.writing.set(path, content);
        const tmp = `${path}.tmp`;
        try { await writeFile(tmp, content, 'utf8'); await rename(tmp, path); } catch { /* next snapshot retries */ }
        this.writing.delete(path);
      }
    })().finally(() => { this.inFlight.delete(path); this.writing.delete(path); });
    this.inFlight.set(path, run);
  }

  async flush(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  flushSync(): void {
    for (const [path, content] of this.pending) {
      try { writeFileSync(path, content, 'utf8'); } catch { /* exiting anyway */ }
    }
    this.pending.clear();
  }
}
