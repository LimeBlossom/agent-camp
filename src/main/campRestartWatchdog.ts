import { launchAppImage } from './campAppImageLaunch';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isCampRestartReplacement, runCampRestartWatchdog, type WatchdogRequest } from './campRestart';
import { processIdentity } from './campActivity';
import type { HiveMessage } from './hive';

const READY_TIMEOUT_MS = 60_000;
const NATIVE_LAUNCH_GRACE_MS = 5_000;
const POLL_MS = 250;

function replacements(token: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const started = processIdentity(pid);
    if (!started) continue;
    try {
      if (isCampRestartReplacement(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), token) &&
          processIdentity(pid) === started) result.set(pid, started);
    } catch { /* process exited or is owned by another user */ }
  }
  return result;
}

function startupReader(logPath: string): () => Record<string, unknown>[] {
  let offset = 0;
  let fileId: number | undefined;
  let partial = '';
  try {
    const stat = statSync(logPath);
    offset = stat.size;
    fileId = stat.ino;
  } catch { /* log will be created at boot */ }
  return () => {
    let fd: number;
    try { fd = openSync(logPath, 'r'); } catch { return []; }
    try {
      const { size, ino } = fstatSync(fd);
      if (ino !== fileId || size < offset) {
        offset = 0;
        partial = '';
        fileId = ino;
      }
      const bytes = Buffer.alloc(Math.min(size - offset, 128 * 1024));
      const count = readSync(fd, bytes, 0, bytes.length, offset);
      offset += count;
      const lines = (partial + bytes.toString('utf8', 0, count)).split('\n');
      partial = lines.pop() ?? '';
      return lines.flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
    } finally {
      closeSync(fd);
    }
  };
}

function deliverWatchdogOutcome(root: string, subject: string, body: string): void {
  const log = join(root, 'log.jsonl');
  const report = (event: Record<string, unknown>) => appendFileSync(log, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  report({ kind: 'camp-restart-watchdog', subject, body });

  const { godId } = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as { godId?: unknown };
  if (typeof godId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(godId)) return;
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const message: HiveMessage = {
    id, conversation: `conv-${randomUUID()}`, from: 'harness', to: 'boss', act: 'inform', subject, body,
    in_reply_to: null, hops: 0, created_at: createdAt, requires_reply: false, needs_human: false
  };
  const path = join(root, 'agents', godId, 'inbox', `${id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(message, null, 2), { flag: 'wx' });
  renameSync(`${path}.tmp`, path);
  report({ kind: 'message', id, from: message.from, to: message.to, act: message.act, subject, delivered: [godId] });
}

async function run(request: WatchdogRequest, root: string, oldPid: number, oldIdentity: string, launchOnExit: boolean, readStartupEvents: () => Record<string, unknown>[]): Promise<void> {
  const wait = () => delay(POLL_MS);
  await runCampRestartWatchdog({
    ...request,
    launchOnExit,
    timeoutMs: READY_TIMEOUT_MS,
    waitForOldExit: async () => {
      const deadline = performance.now() + 20_000;
      while (oldIdentity && processIdentity(oldPid) === oldIdentity) {
        if (performance.now() >= deadline) throw new Error('The previous Camp process did not exit.');
        await wait();
      }
    },
    launch: (path) => launchAppImage(path, path === request.execPath ? request.args : request.rollbackArgs),
    tryFallback: async () => {
      await delay(NATIVE_LAUNCH_GRACE_MS);
      if (replacements(request.token).size === 0) {
        // A startup proof read here must remain visible to the main proof loop.
        const events = readStartupEvents();
        if (events.some((event) => event?.kind === 'app-start' && event.restartToken === request.token && event.sha === request.expectedSha)) return events;
        await launchAppImage(request.execPath, request.args);
      }
      return [];
    },
    stopReplacement: async () => {
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        for (const [pid, started] of replacements(request.token)) {
          if (processIdentity(pid) !== started) continue;
          try { process.kill(pid, signal); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        const deadline = performance.now() + 2_000;
        while (replacements(request.token).size && performance.now() < deadline) await wait();
      }
      if (replacements(request.token).size) throw new Error('The failed replacement could not be stopped.');
    },
    verifyRollback: async () => {
      const deadline = performance.now() + READY_TIMEOUT_MS;
      while (performance.now() < deadline) {
        if (readStartupEvents().some((event) => event?.kind === 'app-start' &&
          event.restartToken === request.rollbackToken && event.sha === request.rollbackSha)) return true;
        await wait();
      }
      return false;
    },
    readStartupEvents,
    now: () => performance.now(),
    wait,
    mailBoss: (subject, body) => deliverWatchdogOutcome(root, subject, body)
  });
}

const [config, root, pid] = process.argv.slice(2);
if (process.send && config && root && pid) {
  const request = JSON.parse(config) as WatchdogRequest;
  const oldIdentity = processIdentity(Number(pid));
  if (!oldIdentity) throw new Error('Camp exited before it armed the watchdog.');
  const readStartupEvents = startupReader(join(root, 'log.jsonl'));
  process.once('message', (message) => {
    process.disconnect?.();
    if (message === 'native' || message === 'fallback') {
      void run(request, root, Number(pid), oldIdentity, message === 'fallback', readStartupEvents)
        .catch((error) => { console.error(`Camp watchdog for ${basename(request.execPath)}:`, error); process.exitCode = 1; });
    }
  });
  process.send('ready');
}
