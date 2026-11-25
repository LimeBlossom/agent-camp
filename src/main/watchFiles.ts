import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

/** Watch directories so atomic rename saves do not detach the file watcher. */
export function watchFiles(
  paths: string[], onChanged: (path: string) => void, debounceMs = 100
): { close: () => void } {
  const watchers = new Map<string, FSWatcher>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const notify = (path: string): void => {
    clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => {
      timers.delete(path);
      if (!closed) onChanged(path);
    }, debounceMs));
  };
  const attach = (): void => {
    for (const path of paths) {
      // Watch the nearest existing ancestor until a missing directory appears.
      let dir = dirname(path);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_event, filename) => {
          for (const target of paths) {
            if (!filename || String(filename) === relative(dir, target).split(sep)[0]) notify(target);
          }
          attach();
        });
        watcher.on('error', () => { watcher.close(); watchers.delete(dir); });
        watchers.set(dir, watcher);
      } catch { /* unavailable home; next bootstrap can try again */ }
    }
  };
  attach();
  return { close: () => {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    timers.clear();
    watchers.clear();
  } };
}
