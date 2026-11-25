/**
 * Claude subscription limits (5h and 7d) for the title bar.
 *
 * Two sources, both written by the user's own Claude Code status line script under
 * `$XDG_RUNTIME_DIR/cc-usage/`, and the newer reading wins:
 *  - `limits.json`, the claude.ai usage endpoint's body, refreshed every couple of
 *    minutes by whichever session is running.
 *  - `<session>.json`, each session's status-line `rate_limits` block. Claude Code
 *    passes `null` there for some sessions and omits `five_hour` when no window is
 *    open, so these alone left the chip hours stale.
 * A third source needs no script: the `rate_limits` block of the Status payloads that
 * hive agents' own status line forwards to the harness (`noteLiveRateLimits`), held in
 * memory because hive sessions never run the user's status line.
 * When cached readings are stale or missing, `readClaudeLimitsWithFallback` queries
 * `claude /usage` on demand as a fallback.
 * The limits are account-wide. With none of these sources the chip stays hidden.
 */
import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TIMINGS } from './timings';

export interface ClaudeLimits {
  fiveHour?: { percent: number; resetsAt?: number };
  sevenDay?: { percent: number; resetsAt?: number };
  /** The weekly Fable meter; absent when the reading has no such line, never 0. */
  sevenDayFable?: { percent: number; resetsAt?: number };
  /** Banked limit resets still unspent, soonest expiry first; absent when unknown. */
  resetGrants?: ClaudeResetGrant[];
  /** When the reading was written, ms since epoch. */
  updatedAt: number;
}

export interface ClaudeResetGrant {
  id: string;
  label: string;
  /** Short name for the chip ('full', 'fable', '5h', 'wk'); the label is a sentence. */
  kind: string;
  left: number;
  /** Seconds since epoch. */
  endsAt?: number;
  usableNow: boolean;
}

/** What a grant resets, from its `clears` windows; Fable resets clear the overage window. */
export function grantKind(label: string, clears: unknown): string {
  const c = Array.isArray(clears) ? clears.filter((x): x is string => typeof x === 'string') : [];
  if (c.includes('seven_day')) return c.includes('five_hour') ? 'full' : 'wk';
  if (c.includes('seven_day_overage_included') || /fable/i.test(label)) return 'fable';
  if (c.includes('five_hour')) return '5h';
  return 'reset';
}

/** Older than this, a cached grant may already have been spent with /limit-reset. */
export const RESET_GRANTS_STALE_MS = 60 * 60 * 1000;

export const CLAUDE_USAGE_CMD = 'claude';
export const CLAUDE_USAGE_ARGS = ['/usage'];
export const CLAUDE_LIMITS_STALE_MS = 15 * 60 * 1000;

export function isClaudeLimitsStale(
  limits: ClaudeLimits | null,
  now = Date.now(),
  maxAgeMs = CLAUDE_LIMITS_STALE_MS
): boolean {
  if (!limits) return true;
  return now - limits.updatedAt >= maxAgeMs;
}

function parseResetTimestamp(resetStr: string | undefined): number | undefined {
  if (!resetStr) return undefined;
  const trimmed = resetStr.trim();
  const isoMatch = trimmed.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (!isoMatch) return undefined;
  const ms = Date.parse(isoMatch[0]);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function parseUsageSection(
  text: string,
  headerPattern: RegExp
): { percent: number; resetsAt?: number } | undefined {
  const match = text.match(headerPattern);
  if (!match) return undefined;
  // A section ends at a blank line or the next header, so a missing reset never borrows a neighbour's.
  const content = match[1].split(/\r?\n[ \t]*(?:\r?\n|Current )/)[0];
  const pctMatch = content.match(/(\S+?)%\s*used/i);
  if (!pctMatch) {
    throw new Error(`Unrecognized claude /usage output: malformed percentage in "${match[0]}"`);
  }
  const pct = Number(pctMatch[1]);
  if (!Number.isFinite(pct)) {
    throw new Error(`Unrecognized claude /usage output: invalid percentage "${pctMatch[1]}" in "${match[0]}"`);
  }
  const resetMatch = content.match(/(?:·\s*)?\bresets\s+([^\r\n]+)/i);
  const resetsAt = resetMatch ? parseResetTimestamp(resetMatch[1]) : undefined;
  return { percent: pct, resetsAt };
}

export function parseClaudeUsageOutput(raw: string, now = Date.now()): ClaudeLimits {
  const clean = (raw || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  if (!clean.trim()) {
    throw new Error('Unrecognized claude /usage output: empty output');
  }
  // Claude Code 2.1.3xx prints the header alone, then the meter line, then the reset line.
  const body = '[ \t]*((?:[^\r\n]*\r?\n){0,2}[^\r\n]*)';
  const fiveHour = parseUsageSection(clean, new RegExp(`^[ \\t]*Current session:?${body}`, 'im'));
  const sevenDay = parseUsageSection(clean, new RegExp(`^[ \\t]*Current week(?:\\s*\\(all models\\))?(?![ \\t]*\\(Fable\\)):?${body}`, 'im'));
  const sevenDayFable = parseUsageSection(clean, new RegExp(`^[ \\t]*Current week[ \\t]*\\(Fable\\):?${body}`, 'im'));
  if (!fiveHour && !sevenDay && !sevenDayFable) {
    throw new Error('Unrecognized claude /usage output: no usage metrics found');
  }
  return { fiveHour, sevenDay, ...(sevenDayFable ? { sevenDayFable } : {}), updatedAt: now };
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; env?: NodeJS.ProcessEnv }
) => any;

export interface QueryClaudeUsageOptions {
  spawnFn?: SpawnFn;
  timeoutMs?: number;
  now?: number;
}

export function queryClaudeUsage(options: QueryClaudeUsageOptions = {}): Promise<ClaudeLimits> {
  const spawnFn = options.spawnFn ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now();

  const promise = new Promise<ClaudeLimits>((resolve, reject) => {
    let proc: any;
    let timer: NodeJS.Timeout | null = null;
    let stdoutData = '';
    let stderrData = '';
    let finished = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    try {
      proc = spawnFn(CLAUDE_USAGE_CMD, CLAUDE_USAGE_ARGS, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      return reject(err);
    }

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer | string) => {
        stdoutData += chunk.toString();
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer | string) => {
        stderrData += chunk.toString();
      });
    }

    timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        cleanup();
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore kill errors
        }
        reject(new Error(`queryClaudeUsage timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    proc.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    });

    proc.on('close', (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (code !== 0) {
        return reject(
          new Error(
            `claude /usage failed with exit code ${code}${signal ? ` (signal ${signal})` : ''}: ${stderrData || stdoutData}`
          )
        );
      }
      try {
        const limits = parseClaudeUsageOutput(stdoutData, now);
        resolve(limits);
      } catch (err) {
        reject(err);
      }
    });
  });

  // Attach a no-op handler to avoid unhandled rejection warnings in test harnesses
  // when an assertion attaches its handler asynchronously after a delay.
  promise.catch(() => {});
  return promise;
}

function cacheDir(): string {
  return join(process.env.XDG_RUNTIME_DIR || '/tmp', 'cc-usage');
}

function bucket(raw: unknown): { percent: number; resetsAt?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { used_percentage?: unknown; resets_at?: unknown };
  if (typeof r.used_percentage !== 'number') return undefined;
  return { percent: r.used_percentage, resetsAt: typeof r.resets_at === 'number' ? r.resets_at : undefined };
}

function endpointBucket(raw: unknown): { percent: number; resetsAt?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof r.utilization !== 'number') return undefined;
  const ms = typeof r.resets_at === 'string' ? Date.parse(r.resets_at) : NaN;
  return { percent: r.utilization, resetsAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined };
}

function readEndpoint(dir: string): ClaudeLimits | null {
  const path = join(dir, 'limits.json');
  try {
    const mtime = statSync(path).mtimeMs;
    const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const fiveHour = endpointBucket(body.five_hour);
    const sevenDay = endpointBucket(body.seven_day);
    if (fiveHour || sevenDay) return { fiveHour, sevenDay, updatedAt: mtime };
  } catch {
    // Missing, or mid-write; the session files stand in.
  }
  return null;
}

/**
 * The `cedar_ember` block of limits.json, which fetch-usage-limits.sh only gets with
 * Claude Code's User-Agent; without it the server answers eligible:false, reason
 * "surface", and an empty list. Undefined means no data, never zero resets.
 */
export function readClaudeResetGrants(now = Date.now()): ClaudeResetGrant[] | undefined {
  const path = join(cacheDir(), 'limits.json');
  try {
    if (now - statSync(path).mtimeMs > RESET_GRANTS_STALE_MS) return undefined;
    const ce = (JSON.parse(readFileSync(path, 'utf8')) as { cedar_ember?: unknown }).cedar_ember as
      | { grants?: unknown; ineligible_reason?: unknown }
      | null
      | undefined;
    if (!ce || typeof ce !== 'object' || !Array.isArray(ce.grants)) return undefined;
    if (ce.ineligible_reason === 'surface') return undefined;
    const nowSec = now / 1000;
    return ce.grants
      .map((raw): ClaudeResetGrant | null => {
        const g = raw as Record<string, unknown>;
        if (!g || typeof g.id !== 'string' || typeof g.resets_left !== 'number') return null;
        const ms = typeof g.ends_at === 'string' ? Date.parse(g.ends_at) : NaN;
        const label = typeof g.label === 'string' ? g.label : g.id;
        return {
          id: g.id,
          label,
          kind: grantKind(label, g.clears),
          left: g.resets_left,
          endsAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined,
          usableNow: g.usable_now === true
        };
      })
      .filter((g): g is ClaudeResetGrant => g !== null && g.left > 0 && (g.endsAt === undefined || g.endsAt > nowSec))
      .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  } catch {
    return undefined;
  }
}

/**
 * Two toasts per grant: a warning inside the lead time and a reminder inside the final
 * lead time. A grant first seen inside the final window gets only the reminder.
 * Seen stages live for the app's run.
 */
export class ClaudeResetGrantNotices {
  private readonly seen = new Set<string>();

  constructor(
    private readonly enabled: () => boolean,
    private readonly show: (title: string, body: string) => void,
    private readonly getLeadMs: () => number = () => DEFAULT_TIMINGS.claudeResetGrantAlertLeadMs,
    private readonly getFinalLeadMs: () => number = () => DEFAULT_TIMINGS.claudeResetGrantFinalAlertLeadMs
  ) {}

  check(limits: Pick<ClaudeLimits, 'resetGrants'> | null | undefined, nowMs: number = Date.now()): void {
    for (const g of limits?.resetGrants ?? []) {
      if (g.left <= 0 || typeof g.endsAt !== 'number') continue;
      const leftMs = g.endsAt * 1000 - nowMs;
      if (leftMs <= 0) continue;
      const final = leftMs <= this.getFinalLeadMs();
      if (!final && leftMs > this.getLeadMs()) continue;
      const key = `${g.id}:${final ? 'final' : 'warn'}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (final) this.seen.add(`${g.id}:warn`);
      if (!this.enabled()) continue;
      const at = new Date(g.endsAt * 1000);
      const when = `${at.toLocaleDateString()} at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      this.show(
        final ? 'Claude limit reset expires within a day' : 'Claude limit reset expiring soon',
        `${g.label} expires ${when}. Spend it with /limit-reset in Claude Code.`
      );
    }
  }
}

function withResetGrants(limits: ClaudeLimits | null): ClaudeLimits | null {
  if (!limits) return limits;
  const resetGrants = readClaudeResetGrants();
  return resetGrants ? { ...limits, resetGrants } : limits;
}

function readSessions(dir: string): ClaudeLimits | null {
  let files: { path: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      // limits.json is the raw usage-endpoint body, a different shape.
      .filter((f) => f.endsWith('.json') && f !== 'limits.json')
      .map((f) => {
        const path = join(dir, f);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const rl = (JSON.parse(readFileSync(f.path, 'utf8')) as { rate_limits?: Record<string, unknown> }).rate_limits;
      if (!rl) continue;
      const fiveHour = bucket(rl.five_hour);
      const sevenDay = bucket(rl.seven_day);
      if (fiveHour || sevenDay) return { fiveHour, sevenDay, updatedAt: f.mtime };
    } catch {
      // A file mid-write parses as garbage; the next newest one will do.
    }
  }
  return null;
}

let live: { dir: string; limits: ClaudeLimits } | null = null;
let fableAttempt: { dir: string; at: number } | null = null;
let fallbackCache: { dir: string; limits: ClaudeLimits } | null = null;
let inflightQuery: Promise<ClaudeLimits> | null = null;

/** Keep the newest `rate_limits` seen on a Status payload. A null or bucketless
 *  block (Claude Code sends those) never replaces a good reading. */
export function noteLiveRateLimits(raw: unknown, now = Date.now()): void {
  if (!raw || typeof raw !== 'object') return;
  const rl = raw as Record<string, unknown>;
  const fiveHour = bucket(rl.five_hour);
  const sevenDay = bucket(rl.seven_day);
  if (fiveHour || sevenDay) {
    live = { dir: cacheDir(), limits: { fiveHour, sevenDay, updatedAt: now } };
  }
}

export function readClaudeLimits(now = Date.now(), maxAgeMs = CLAUDE_LIMITS_STALE_MS): ClaudeLimits | null {
  const dir = cacheDir();
  const files = [readEndpoint(dir), readSessions(dir)].filter((l): l is ClaudeLimits => l !== null);
  if (live && live.dir === dir) files.push(live.limits);
  const best = files.reduce<ClaudeLimits | null>((best, l) => (!best || l.updatedAt > best.updatedAt ? l : best), null);
  if (!best) return null;
  return best.sevenDayFable ? best : withFableFromUsage(best, dir, now, maxAgeMs);
}

export interface ReadClaudeLimitsWithFallbackOptions {
  spawnFn?: SpawnFn;
  now?: number;
  maxAgeMs?: number;
  timeoutMs?: number;
}

/** A fresh cc-usage reading never carries the Fable meter, so borrow it from the last `claude /usage` run when that is still fresh. Never spawns. */
function withFableFromUsage(cached: ClaudeLimits, dir: string, now: number, maxAgeMs: number): ClaudeLimits {
  const usage = fallbackCache && fallbackCache.dir === dir && !isClaudeLimitsStale(fallbackCache.limits, now, maxAgeMs) ? fallbackCache.limits : null;
  return usage?.sevenDayFable ? { ...cached, sevenDayFable: usage.sevenDayFable } : cached;
}

export async function readClaudeLimitsWithFallback(
  options: ReadClaudeLimitsWithFallbackOptions = {}
): Promise<ClaudeLimits | null> {
  const dir = cacheDir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? CLAUDE_LIMITS_STALE_MS;
  const cached = readClaudeLimits(now, maxAgeMs);

  if (cached && !isClaudeLimitsStale(cached, now, maxAgeMs)) {
    const attemptedRecently = fableAttempt && fableAttempt.dir === dir && now - fableAttempt.at < maxAgeMs;
    if (cached.sevenDayFable || attemptedRecently || (inflightQuery && !options.spawnFn)) return cached;
    // Only /usage reports Fable, so a fresh cc-usage cache still needs one run per window.
    fableAttempt = { dir, at: now };
    const query = queryClaudeUsage({ spawnFn: options.spawnFn, timeoutMs: options.timeoutMs, now });
    if (!options.spawnFn) inflightQuery = query;
    try {
      const usage = await query;
      fallbackCache = { dir, limits: usage };
      return usage.sevenDayFable ? { ...cached, sevenDayFable: usage.sevenDayFable } : cached;
    } catch {
      return cached;
    } finally {
      if (!options.spawnFn) inflightQuery = null;
    }
  }

  if (
    fallbackCache &&
    fallbackCache.dir === dir &&
    !isClaudeLimitsStale(fallbackCache.limits, now, maxAgeMs) &&
    (!cached || fallbackCache.limits.updatedAt >= cached.updatedAt)
  ) {
    return fallbackCache.limits;
  }

  if (inflightQuery && !options.spawnFn) {
    try {
      return await inflightQuery;
    } catch {
      return cached;
    }
  }

  const queryPromise = queryClaudeUsage({
    spawnFn: options.spawnFn,
    timeoutMs: options.timeoutMs,
    now,
  });

  if (!options.spawnFn) {
    inflightQuery = queryPromise;
  }

  try {
    const fresh = await queryPromise;
    fallbackCache = { dir, limits: fresh };
    return fresh;
  } catch {
    return cached;
  } finally {
    if (!options.spawnFn) {
      inflightQuery = null;
    }
  }
}

export function initClaudeLimits(): void {
  ipcMain.handle('claudeLimits:get', async () => withResetGrants(await readClaudeLimitsWithFallback()));
}
