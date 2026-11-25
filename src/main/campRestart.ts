import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RESTART_CAMP_ACT = 'restart-camp';
const PACKAGE = /^Camp-([a-f0-9]{40})\.AppImage$/;
const SHA = /^[a-f0-9]{40}$/;
const TOKEN_ARG = '--camp-restart-token=';
const OLD_SHA_ARG = '--camp-restart-old-sha=';
const EXPECTED_SHA_ARG = '--camp-restart-expected-sha=';
const ROLLBACK_ARG = '--camp-restart-rollback';

type Result = { ok: true } | { ok: false; error: string };
export type CampRestartRequest = { force?: boolean };
export type RestartResult = Result;
type MailBoss = (subject: string, body: string) => void;

export function validateCampRestart(sender: string, godId: string | null, body: unknown):
  { ok: true; request: CampRestartRequest } | { ok: false; error: string } {
  if (!godId || sender !== godId) return { ok: false, error: 'Only the Boss may restart Camp.' };
  if (body === undefined) return { ok: true, request: {} };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a restart request object.' };
  const { force } = body as Record<string, unknown>;
  if (force !== undefined && typeof force !== 'boolean') return { ok: false, error: 'force must be a boolean.' };
  return { ok: true, request: force === undefined ? {} : { force } };
}

function restartArgument(arg: string): boolean {
  return arg === ROLLBACK_ARG || [TOKEN_ARG, OLD_SHA_ARG, EXPECTED_SHA_ARG].some((prefix) => arg.startsWith(prefix));
}

/** Chromium rewrites its browser process title into one space-joined string,
 *  so /proc/<pid>/cmdline is split on spaces as well as NULs. */
export function isCampRestartReplacement(cmdline: string, token: string): boolean {
  const words = cmdline.split(/[\0 ]/);
  return words.includes(TOKEN_ARG + token) && !words.some((word) => word.startsWith('--type='));
}

export function readCampBuildSha(appPath: string): string | undefined {
  try {
    const sha = readFileSync(join(appPath, 'out', 'camp-build-sha'), 'utf8').trim();
    if (SHA.test(sha)) return sha;
  } catch { /* legacy packages and dev builds have no embedded SHA */ }
  return undefined;
}

export function readCampRestartArgs(args: string[]): { token: string; oldSha: string; expectedSha: string; rollback: boolean } | undefined {
  const value = (prefix: string): string => args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
  const token = value(TOKEN_ARG);
  const oldSha = value(OLD_SHA_ARG);
  const expectedSha = value(EXPECTED_SHA_ARG);
  if (/^[a-f0-9-]{36}$/.test(token) && SHA.test(oldSha) && SHA.test(expectedSha)) {
    return { token, oldSha, expectedSha, rollback: args.includes(ROLLBACK_ARG) };
  }
  return undefined;
}

export interface WatchdogRequest {
  token: string;
  execPath: string;
  rollbackPath: string;
  expectedSha: string;
  args: string[];
  rollbackArgs: string[];
  rollbackSha: string;
  rollbackToken: string;
}

export interface PreparedWatchdog {
  arm(launchOnExit: boolean): void;
  cancel(): void;
}

interface RestartOptions {
  platform: string;
  packaged: boolean;
  appImage?: string;
  installDir: string;
  oldSha?: string;
  args: string[];
  getBlockers: () => string[];
  relaunch: (params: { execPath: string; args: string[] }) => unknown;
  startWatchdog: (request: WatchdogRequest) => PreparedWatchdog | Promise<PreparedWatchdog>;
  teardownAndQuit: () => void;
  beginShutdown?: (complete: () => Promise<Result>, cancel: () => void) => Result;
}

function managedImage(path: string, builds: string): { path: string; sha: string; modifiedAt: number } {
  const image = realpathSync(path);
  if (dirname(image) !== builds) throw new Error('AppImage is outside the managed builds directory.');
  const sha = PACKAGE.exec(basename(image))?.[1];
  const stat = statSync(image);
  if (!sha || !stat.isFile()) throw new Error('AppImage must be a managed build.');
  accessSync(image, constants.X_OK);
  return { path: image, sha, modifiedAt: stat.mtimeMs };
}

export class CampRestartController {
  private pending = false;

  constructor(private readonly options: RestartOptions) {}

  async request(request: CampRestartRequest): Promise<Result> {
    const opts = this.options;
    if (this.pending) return { ok: false, error: 'A Camp restart is already pending.' };
    if (!opts.packaged) return { ok: false, error: 'Cannot relaunch a dev build.' };
    if (opts.platform !== 'linux' || !opts.appImage) return { ok: false, error: 'Restart requires a Linux AppImage.' };
    const oldSha = opts.oldSha;
    if (!oldSha || !SHA.test(oldSha)) return { ok: false, error: 'The running AppImage has no embedded build SHA.' };
    const blockers = request.force ? [] : opts.getBlockers();
    if (blockers.length) return { ok: false, error: blockers.join(' ') };

    const execPath = join(opts.installDir, 'current.AppImage');
    const resolveImages = () => {
      const builds = realpathSync(join(opts.installDir, 'builds'));
      const target = managedImage(execPath, builds);
      const candidates = readdirSync(builds).filter((name) => PACKAGE.test(name)).flatMap((name) => {
        try {
          const entry = managedImage(join(builds, name), builds);
          return entry.sha === target.sha ? [] : [entry];
        } catch { return []; }
      });
      const rollback = candidates.find((entry) => entry.sha === oldSha) ??
        candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
      if (!rollback) throw new Error('No previous managed AppImage is available for rollback.');
      return { target, rollback };
    };
    try {
      resolveImages();
    } catch (error) {
      return { ok: false, error: String(error) };
    }

    this.pending = true;
    let cancelled = false;
    const cancel = () => { cancelled = true; this.pending = false; };
    const complete = async (): Promise<Result> => {
      let watchdog: PreparedWatchdog | undefined;
      try {
        const { target, rollback } = resolveImages();
        const token = randomUUID();
        const rollbackToken = randomUUID();
        const baseArgs = opts.args.filter((arg) => !restartArgument(arg) && !arg.startsWith('munderdifflin://'));
        const args = [...baseArgs, TOKEN_ARG + token, OLD_SHA_ARG + oldSha, EXPECTED_SHA_ARG + target.sha];
        const rollbackArgs = [...baseArgs, TOKEN_ARG + rollbackToken, OLD_SHA_ARG + oldSha, EXPECTED_SHA_ARG + rollback.sha, ROLLBACK_ARG];
        watchdog = await opts.startWatchdog({
          token, execPath, rollbackPath: rollback.path, expectedSha: target.sha, args, rollbackArgs,
          rollbackSha: rollback.sha, rollbackToken
        });
        if (cancelled) {
          watchdog.cancel();
          return { ok: false, error: 'Camp restart cancelled.' };
        }
        let launchOnExit = false;
        try { launchOnExit = opts.relaunch({ execPath, args }) === false; } catch { launchOnExit = true; }
        watchdog.arm(launchOnExit);
        opts.teardownAndQuit();
        return { ok: true };
      } catch (error) {
        watchdog?.cancel();
        cancel();
        return { ok: false, error: String(error) };
      }
    };

    if (!opts.beginShutdown) return complete();
    try {
      const result = opts.beginShutdown(complete, cancel);
      if (!result.ok) cancel();
      return result;
    } catch (error) {
      cancel();
      return { ok: false, error: String(error) };
    }
  }
}

export function recordCampRestartStartup(options: {
  appStart: Record<string, unknown>;
  sha?: string;
  restart?: { token: string; oldSha: string; expectedSha?: string; rollback?: boolean };
  log: (event: Record<string, unknown>) => void;
  mailBoss: MailBoss;
}): void {
  const { appStart, sha, restart, log, mailBoss } = options;
  const proved = restart && sha && (!restart.expectedSha || restart.expectedSha === sha);
  log({ ...appStart, ...(sha ? { sha } : {}), ...(proved ? { restartToken: restart.token } : {}) });
  if (proved && !restart.rollback) mailBoss('Camp restarted', `Build ${restart.oldSha.slice(0, 8)} -> ${sha.slice(0, 8)}.`);
}

interface WatchdogOptions extends Pick<WatchdogRequest, 'token' | 'execPath' | 'rollbackPath' | 'expectedSha'> {
  launchOnExit: boolean;
  timeoutMs: number;
  waitForOldExit: () => Promise<void>;
  launch: (path: string) => Promise<void>;
  tryFallback?: () => Promise<Record<string, unknown>[]>;
  stopReplacement: () => Promise<void>;
  verifyRollback?: () => Promise<boolean>;
  readStartupEvents: () => Record<string, unknown>[];
  now: () => number;
  wait: () => Promise<void>;
  mailBoss: MailBoss;
}

export async function runCampRestartWatchdog(options: WatchdogOptions): Promise<void> {
  const { token, execPath, rollbackPath, expectedSha, mailBoss } = options;
  try {
    await options.waitForOldExit();
  } catch (error) {
    mailBoss('Camp restart did not complete', String(error));
    return;
  }
  try {
    const matches = (event: Record<string, unknown>) =>
      event?.kind === 'app-start' && event.restartToken === token && event.sha === expectedSha;
    if (options.launchOnExit) await options.launch(execPath);
    else if ((await options.tryFallback?.())?.some(matches)) return;
    const deadline = options.now() + options.timeoutMs;
    while (options.now() < deadline) {
      if (options.readStartupEvents().some(matches)) return;
      await options.wait();
    }
  } catch { /* launch failure also rolls back */ }

  try {
    await options.stopReplacement();
    await options.launch(rollbackPath);
    const verified = await options.verifyRollback?.();
    const detail = verified === false ? ' Startup could not be confirmed.' : '';
    const subject = verified === false ? 'Camp rollback startup unconfirmed' : 'Camp restart rolled back';
    mailBoss(subject, `Build ${expectedSha.slice(0, 8)} did not start. Launched ${basename(rollbackPath)}.${detail}`);
  } catch (error) {
    mailBoss('Camp rollback failed', `Build ${expectedSha.slice(0, 8)} did not start. ${String(error)}`);
  }
}
