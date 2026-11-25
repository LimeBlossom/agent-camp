import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';

export function appImageEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const mount = env.APPDIR;
  for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  for (const key of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    if (mount && env[key]) env[key] = env[key].split(':').filter((dir) => dir !== mount && !dir.startsWith(mount + '/')).join(':');
  }
  // A sandboxed parent cannot use setuid fusermount. The AppImage runtime can
  // extract itself without privileges and cleans the temporary image on exit.
  if (/^NoNewPrivs:\s+1$/m.test(readFileSync('/proc/self/status', 'utf8'))) env.APPIMAGE_EXTRACT_AND_RUN = '1';
  return env;
}

// Node cannot close fds between fork and exec, and Electron-as-Node passes its
// own non-CLOEXEC fds (some on the old AppImage mount) to every child. bash
// closes everything above stderr, then execs the build in its place.
const CLOSE_FDS_THEN_EXEC = 'for fd in /proc/self/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';

export function launchAppImage(path: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try { accessSync(path, constants.X_OK); } catch (error) { reject(error); return; }
    const child = spawn('/bin/bash', ['-c', CLOSE_FDS_THEN_EXEC, 'camp-launch', path, ...args], { detached: true, stdio: 'ignore', env: appImageEnv() });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
