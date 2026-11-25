/**
 * Codex (ChatGPT plan) limits for the title bar, beside the Claude chip.
 *
 * Codex rate limits can be queried on demand via `codex app-server` (JSON-RPC over
 * stdio). When available, this provides real-time limits including earned-reset credits
 * and plan type. As fallback (e.g. if the CLI cannot be spawned or times out), main
 * tails recent session rollouts for `token_count` events: `rate_limits: { limit_id:
 * "codex", primary: {used_percent, window_minutes, resets_at}, secondary: {...} }`.
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_TIMINGS } from './timings';
import { userShellPath } from './shellEnv';

export interface CodexResetCredit {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: number;
  expiresAt?: number;
  title?: string;
  description?: string;
}

export interface CodexResetCredits {
  availableCount: number;
  credits: CodexResetCredit[];
}

export interface CodexLimitBucket {
  percent: number;
  /** Unix seconds; absent once the window has reset since the reading. */
  resetsAt?: number;
  windowMinutes: number;
  /** The window's reset time passed after the reading, so the usage shown is 0. */
  reset?: boolean;
}

export interface CodexLimits {
  fiveHour?: CodexLimitBucket;
  weekly?: CodexLimitBucket;
  /** When Codex recorded the reading, ms since epoch. */
  updatedAt: number;
  credits?: CodexResetCredits;
  planType?: string;
  ordinaryUsageAllowed?: boolean;
  /** Why the last `codex app-server` query failed; the reading then comes from rollouts,
   *  which never carry reset credits. */
  appServerError?: string;
  /** Set when `credits` were carried over from an earlier app-server reading (ms). */
  creditsAt?: number;
}

export const CODEX_APP_SERVER_METHODS: readonly string[] = ['initialize', 'account/rateLimits/read'];

export function isAllowedAppServerMethod(method: string): boolean {
  return (CODEX_APP_SERVER_METHODS as readonly string[]).includes(method);
}

export const CODEX_APP_SERVER_ARGS: readonly string[] = [
  'app-server',
  '--stdio',
  '-c',
  'mcp_servers={}',
  '-c',
  'analytics.enabled=false'
];

export interface QueryCodexAppServerOptions {
  timeoutMs?: number;
  spawnFn?: (cmd: string, args: string[], options?: any) => any;
  codexBin?: string;
  /** Spawn env. A packaged app's PATH lacks the user's npm/nvm bin dirs, so `codex`
   *  (and the `node` its shim runs under) would ENOENT without the login-shell PATH. */
  env?: NodeJS.ProcessEnv;
  onError?: (reason: string) => void;
}

export interface CodexReaderOptions extends QueryCodexAppServerOptions {
  /** Called once per distinct app-server failure reason (again after a recovery). */
  onFailure?: (reason: string) => void;
}

/** The login-shell PATH for the app-server child. Node looks a bare command up in
 *  options.env.PATH, so this alone finds `codex` and the `node` its shim needs. */
export function codexLaunchOptions(deps: {
  shellPath: () => string;
  env?: NodeJS.ProcessEnv;
}): { codexBin: string; env: NodeJS.ProcessEnv } {
  const base = deps.env ?? process.env;
  const path = deps.shellPath() || base.PATH || '';
  return { codexBin: base.CODEX_BIN || 'codex', env: { ...base, PATH: path } };
}

const FIVE_HOUR = 300;
const WEEK = 10080;
const TAIL_BYTES = 256 * 1024;
const DAYS_BACK = 8;

function bucket(raw: unknown): CodexLimitBucket | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  if (typeof r.used_percent !== 'number' || !Number.isFinite(r.used_percent)) return undefined;
  if (typeof r.window_minutes !== 'number') return undefined;
  return {
    percent: r.used_percent,
    windowMinutes: r.window_minutes,
    ...(typeof r.resets_at === 'number' ? { resetsAt: r.resets_at } : {})
  };
}

/** The reading in one rollout line, or null. Windows are told apart by their length, not
 *  by primary/secondary position. Records for another limit_id are ignored. */
export function parseRateLimitLine(line: string): CodexLimits | null {
  if (!line.includes('"rate_limits"')) return null;
  let d: { timestamp?: unknown; payload?: { rate_limits?: unknown } };
  try { d = JSON.parse(line); } catch { return null; }
  const rl = d?.payload?.rate_limits as { limit_id?: unknown; primary?: unknown; secondary?: unknown } | null | undefined;
  if (!rl || typeof rl !== 'object') return null;
  if (rl.limit_id !== undefined && rl.limit_id !== null && rl.limit_id !== 'codex') return null;
  const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const out: CodexLimits = { updatedAt: at };
  for (const b of [bucket(rl.primary), bucket(rl.secondary)]) {
    if (!b) continue;
    if (b.windowMinutes === FIVE_HOUR) out.fiveHour = b;
    else if (b.windowMinutes === WEEK) out.weekly = b;
  }
  return out.fiveHour || out.weekly ? out : null;
}

/** Parse an app-server JSON-RPC response (or result object) into CodexLimits. */
export function parseAppServerRateLimits(payload: unknown, nowMs?: number): CodexLimits | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  if (raw.error) return null;
  const res = (raw.result && typeof raw.result === 'object')
    ? (raw.result as Record<string, unknown>)
    : raw;
  if (res.error) return null;

  const byLimitId = (res.rateLimitsByLimitId && typeof res.rateLimitsByLimitId === 'object')
    ? (res.rateLimitsByLimitId as Record<string, unknown>)
    : undefined;
  const rateLimitsObj = (byLimitId && ((byLimitId.codex as Record<string, unknown> | undefined) || (Object.values(byLimitId)[0] as Record<string, unknown> | undefined)))
    || (res.rateLimits && typeof res.rateLimits === 'object' ? (res.rateLimits as Record<string, unknown>) : undefined);

  if (!rateLimitsObj || typeof rateLimitsObj !== 'object') return null;

  const appBucket = (bucketRaw: unknown, defaultDuration: number): CodexLimitBucket | undefined => {
    if (!bucketRaw || typeof bucketRaw !== 'object') return undefined;
    const b = bucketRaw as Record<string, unknown>;
    const used = typeof b.usedPercent === 'number' && Number.isFinite(b.usedPercent)
      ? b.usedPercent
      : (typeof b.used_percent === 'number' && Number.isFinite(b.used_percent) ? b.used_percent : undefined);
    if (used === undefined) return undefined;

    const duration = typeof b.windowDurationMins === 'number'
      ? b.windowDurationMins
      : (typeof b.window_minutes === 'number' ? b.window_minutes : defaultDuration);

    const resetsAt = typeof b.resetsAt === 'number'
      ? b.resetsAt
      : (typeof b.resets_at === 'number' ? b.resets_at : undefined);

    return {
      percent: used,
      windowMinutes: duration,
      ...(resetsAt !== undefined ? { resetsAt } : {})
    };
  };

  const bPrimary = appBucket(rateLimitsObj.primary, FIVE_HOUR);
  const bSecondary = appBucket(rateLimitsObj.secondary, WEEK);

  const out: CodexLimits = {
    updatedAt: typeof nowMs === 'number' ? nowMs : Date.now()
  };

  for (const b of [bPrimary, bSecondary]) {
    if (!b) continue;
    if (b.windowMinutes === FIVE_HOUR) out.fiveHour = b;
    else if (b.windowMinutes === WEEK) out.weekly = b;
  }
  if (!out.fiveHour && bPrimary && bPrimary !== out.weekly) out.fiveHour = bPrimary;
  if (!out.weekly && bSecondary && bSecondary !== out.fiveHour) out.weekly = bSecondary;

  if (!out.fiveHour && !out.weekly) return null;

  const planType = (typeof rateLimitsObj.planType === 'string' ? rateLimitsObj.planType : undefined)
    ?? (typeof res.planType === 'string' ? (res.planType as string) : undefined);
  if (planType) out.planType = planType;

  if (typeof res.ordinaryUsageAllowed === 'boolean') {
    out.ordinaryUsageAllowed = res.ordinaryUsageAllowed;
  } else if (typeof rateLimitsObj.ordinaryUsageAllowed === 'boolean') {
    out.ordinaryUsageAllowed = rateLimitsObj.ordinaryUsageAllowed as boolean;
  }

  const rrc = res.rateLimitResetCredits;
  if (rrc && typeof rrc === 'object') {
    const rawRrc = rrc as Record<string, unknown>;
    const creditsList: CodexResetCredit[] = Array.isArray(rawRrc.credits)
      ? rawRrc.credits.map((c: any) => ({
          id: String(c.id ?? ''),
          ...(c.resetType ? { resetType: String(c.resetType) } : {}),
          ...(c.status ? { status: String(c.status) } : {}),
          ...(typeof c.grantedAt === 'number' ? { grantedAt: c.grantedAt } : {}),
          ...(typeof c.expiresAt === 'number' ? { expiresAt: c.expiresAt } : {}),
          ...(c.title ? { title: String(c.title) } : {}),
          ...(c.description ? { description: String(c.description) } : {})
        }))
      : [];
    out.credits = {
      availableCount: typeof rawRrc.availableCount === 'number' ? rawRrc.availableCount : creditsList.length,
      credits: creditsList
    };
  }

  return out;
}

/** Streaming client querying `codex app-server` via JSON-RPC over stdio. */
export async function queryCodexAppServer(
  options: QueryCodexAppServerOptions = {}
): Promise<CodexLimits | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const spawnFn = options.spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));

  if (!isAllowedAppServerMethod('initialize') || !isAllowedAppServerMethod('account/rateLimits/read')) {
    return null;
  }

  return new Promise<CodexLimits | null>((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let child: any = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const done = (result: CodexLimits | null, reason?: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (!result) options.onError?.(reason ?? 'no reading');
      resolve(result);
    };

    try {
      child = spawnFn(codexBin, [...CODEX_APP_SERVER_ARGS], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.env ? { env: options.env } : {})
      });
    } catch (e) {
      done(null, `spawn ${codexBin} failed: ${(e as Error)?.message ?? e}`);
      return;
    }

    if (!child || !child.stdin || !child.stdout) {
      done(null, `spawn ${codexBin} gave no stdio`);
      return;
    }

    timer = setTimeout(() => {
      if (!resolved) {
        try {
          if (typeof child.kill === 'function') {
            child.kill('SIGTERM');
          }
        } catch {}
        done(null, `timed out after ${timeoutMs} ms`);
      }
    }, timeoutMs);

    child.on('error', (e: Error) => {
      done(null, e?.message ?? 'child error');
    });

    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', () => {});
    }
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('error', () => {});
    }
    let stderrTail = '';
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('error', () => {});
      child.stderr.on('data', (chunk: Buffer | string) => { stderrTail = (stderrTail + chunk.toString()).slice(-300); });
    }

    const exited = (code: unknown, signal: unknown) =>
      done(null, `exited before replying (code ${code ?? '?'}${signal ? `, ${signal}` : ''})${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`);
    child.on('exit', exited);
    child.on('close', exited);

    let buffer = '';
    let sentRead = false;

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (resolved) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (msg.id === 1) {
          if (msg.error) {
            done(null, `initialize failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
            return;
          }
          if (!sentRead) {
            sentRead = true;
            try {
              const req = JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {}
              }) + '\n';
              child.stdin.write(req);
            } catch (e) {
              done(null, `write failed: ${(e as Error)?.message ?? e}`);
              return;
            }
          }
        } else if (msg.id === 2) {
          if (msg.error) {
            done(null, `account/rateLimits/read failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
            return;
          }
          const limits = parseAppServerRateLimits(msg);
          done(limits, 'rate limits reply had no usable windows');
          try {
            if (typeof child.stdin.end === 'function') {
              child.stdin.end();
            }
          } catch {}
          return;
        }
      }
    });

    try {
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'Camp',
            version: '1.0.0'
          }
        }
      }) + '\n';
      child.stdin.write(initReq);
    } catch (e) {
      done(null, `write failed: ${(e as Error)?.message ?? e}`);
    }
  });
}

export const readCodexAppServerLimits = queryCodexAppServer;

/** The newest reading in a chunk of rollout text (a file tail; its first line may be cut). */
export function newestInText(text: string): CodexLimits | null {
  let best: CodexLimits | null = null;
  for (const line of text.split('\n')) {
    const r = parseRateLimitLine(line);
    if (r && (!best || r.updatedAt > best.updatedAt)) best = r;
  }
  return best;
}

/** Newest wins across all files. */
export function newestOf(readings: Array<CodexLimits | null>): CodexLimits | null {
  let best: CodexLimits | null = null;
  for (const r of readings) if (r && (!best || r.updatedAt > best.updatedAt)) best = r;
  return best;
}

/** A window whose reset time has passed since the reading shows 0%, not the stale number. */
export function withResets(r: CodexLimits, nowMs: number): CodexLimits {
  const fix = (b?: CodexLimitBucket): CodexLimitBucket | undefined =>
    b && b.resetsAt !== undefined && b.resetsAt * 1000 <= nowMs
      ? { percent: 0, windowMinutes: b.windowMinutes, reset: true }
      : b;
  return { ...r, fiveHour: fix(r.fiveHour), weekly: fix(r.weekly) };
}

/** YYYY/MM/DD folder names for the last few days, local and UTC (rollouts use local time). */
export function recentDateDirs(nowMs: number, days = DAYS_BACK): string[] {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const out = new Set<string>();
  for (let i = 0; i < days; i++) {
    const d = new Date(nowMs - i * 86_400_000);
    out.add(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
    out.add(join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
  }
  return [...out];
}

function subdirs(dir: string): string[] {
  try { return readdirSync(dir).map((n) => join(dir, n)); } catch { return []; }
}

/** Session roots: the user's ~/.codex/sessions, the per-agent trees Munder Difflin links
 *  under it, and each hive agent's own CODEX_HOME (the same files, de-duplicated later). */
export function sessionRoots(userCodexHome: string, hiveRoot: string | null): string[] {
  const user = join(userCodexHome, 'sessions');
  const roots = [user];
  for (const hive of subdirs(join(user, 'munder-difflin'))) roots.push(...subdirs(hive));
  if (hiveRoot) for (const agent of subdirs(join(hiveRoot, 'agents'))) roots.push(join(agent, '.codex', 'sessions'));
  return roots;
}

function readTail(path: string, size: number): string {
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export class CodexLimitsReader {
  private readonly seen = new Map<string, { size: number; mtime: number; reading: CodexLimits | null }>();
  private lastCredits: { credits: CodexResetCredits; at: number } | null = null;
  private lastFailure: string | null = null;

  constructor(
    private readonly userCodexHome: string,
    private readonly hiveRoot: () => string | null,
    private readonly options: CodexReaderOptions = {}
  ) {}

  /** The app-server reading; else the rollout reading with the last known reset credits
   *  (rollouts never carry them) and the failure reason, so the chip can say so. */
  async readWithAppServer(nowMs = Date.now()): Promise<CodexLimits | null> {
    let reason = 'no reading';
    try {
      const appLimits = await queryCodexAppServer({ ...this.options, onError: (r) => { reason = r; } });
      if (appLimits) {
        this.lastFailure = null;
        if (appLimits.credits) this.lastCredits = { credits: appLimits.credits, at: appLimits.updatedAt };
        return appLimits;
      }
    } catch (e) {
      reason = (e as Error)?.message ?? String(e);
    }
    if (reason !== this.lastFailure) {
      this.lastFailure = reason;
      try { this.options.onFailure?.(reason); } catch { /* logging is best-effort */ }
    }
    const rollout = this.read(nowMs);
    if (!rollout) return null;
    return {
      ...rollout,
      appServerError: reason,
      ...(this.lastCredits ? { credits: this.lastCredits.credits, creditsAt: this.lastCredits.at } : {})
    };
  }

  read(nowMs = Date.now()): CodexLimits | null {
    const dates = recentDateDirs(nowMs);
    const visited = new Set<string>();
    const readings: Array<CodexLimits | null> = [];
    for (const root of sessionRoots(this.userCodexHome, this.hiveRoot())) {
      for (const date of dates) {
        let names: string[];
        try { names = readdirSync(join(root, date)); } catch { continue; }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const path = join(root, date, name);
          let real: string;
          let st: ReturnType<typeof statSync>;
          try { real = realpathSync(path); st = statSync(real); } catch { continue; }
          if (visited.has(real)) continue;
          visited.add(real);
          const prev = this.seen.get(real);
          if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) { readings.push(prev.reading); continue; }
          let reading: CodexLimits | null = null;
          try { reading = newestInText(readTail(real, st.size)); } catch { /* unreadable; skip */ }
          this.seen.set(real, { size: st.size, mtime: st.mtimeMs, reading });
          readings.push(reading);
        }
      }
    }
    for (const k of this.seen.keys()) if (!visited.has(k)) this.seen.delete(k);
    const best = newestOf(readings);
    return best ? withResets(best, nowMs) : null;
  }
}

export function initCodexLimits(
  hiveRoot: () => string | null,
  log?: (event: Record<string, unknown>) => void
): () => CodexLimits | null {
  const reader = new CodexLimitsReader(process.env.CODEX_HOME || join(homedir(), '.codex'), hiveRoot, {
    ...codexLaunchOptions({ shellPath: userShellPath }),
    onFailure: (reason) => log?.({ kind: 'codex-appserver-failed', reason })
  });
  let latestLimits: CodexLimits | null = null;
  void reader.readWithAppServer().then((limits) => {
    if (limits) latestLimits = limits;
  }).catch(() => { /* best-effort */ });
  ipcMain.handle('codexLimits:get', async () => {
    const limits = await reader.readWithAppServer();
    if (limits) latestLimits = limits;
    return limits;
  });
  return () => (latestLimits ? withResets(latestLimits, Date.now()) : reader.read());
}

/**
 * Alerts the user once within codexResetCreditAlertLeadMs before an earned Codex
 * reset credit expires, deduplicated by credit id. Respects ordinaryUsageAllowed=false
 * so alerts do not fire when usage/resets are blocked.
 */
export class CodexResetCreditNotices {
  private readonly seen = new Set<string>();

  constructor(
    private readonly enabled: () => boolean,
    private readonly show: (title: string, body: string) => void,
    private readonly getLeadMs: () => number = () => DEFAULT_TIMINGS.codexResetCreditAlertLeadMs
  ) {}

  check(limits: CodexLimits | null | undefined, nowMs: number = Date.now()): void {
    if (!limits?.credits || limits.ordinaryUsageAllowed === false) return;
    const available = limits.credits.availableCount ?? limits.credits.credits?.length ?? 0;
    if (available <= 0) return;

    const creditsList = limits.credits.credits ?? [];
    const unexpired: Array<{ id: string; expMs: number }> = [];

    for (const c of creditsList) {
      if (!c) continue;
      const expSec = c.expiresAt ?? (c as { expiry?: number }).expiry;
      if (typeof expSec !== 'number' || !Number.isFinite(expSec)) continue;
      const expMs = expSec < 1e11 ? expSec * 1000 : expSec;
      if (expMs > nowMs) {
        unexpired.push({ id: c.id, expMs });
      }
    }

    if (unexpired.length === 0) return;
    unexpired.sort((a, b) => a.expMs - b.expMs);

    const soonest = unexpired[0];
    const leadMs = this.getLeadMs();
    if (soonest.expMs - nowMs > leadMs) return;

    if (this.seen.has(soonest.id)) return;
    this.seen.add(soonest.id);

    if (this.enabled()) {
      const expDateStr = new Date(soonest.expMs).toLocaleDateString();
      const expTimeStr = new Date(soonest.expMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const title = 'Codex reset credit expiring soon';
      const body = `An earned Codex reset credit expires ${expDateStr} at ${expTimeStr}. Use it before it expires.`;
      this.show(title, body);
    }
  }
}
