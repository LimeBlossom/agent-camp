/**
 * agy quota for the title bar. agy has no non-interactive quota command, so every few
 * minutes the harness starts its OWN throwaway `agy` in a hidden pty (never an agent's),
 * types the /quota slash command, reads the panel through a headless terminal and exits
 * agy with /exit. No prompt text is ever sent, so no model quota is spent. Any screen it
 * does not recognise (trust, update, onboarding) ends the probe without a keypress.
 */
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { resolveCommand, userShellPath } from './shellEnv';
import { inAgentScope } from './agentScope';
import { ensureKilled } from './procKill';
import { AGY_PROBE_EVERY_MS, agyProbeLogEvent, agyQuotaForEngines, classifyAgyScreen, parseAgyQuota, type AgyQuota, type AgyScreen } from './agyQuotaParse';

const COLS = 120;
const ROWS = 60;
const MIN_ON_DEMAND_GAP_MS = 60_000;

/** A folder agy already trusts, so the probe never meets (or answers) the trust screen.
 *  The hive's parent first, then any trusted folder that still exists. */
export function trustedAgyWorkspace(preferred: Array<string | null | undefined>): string | null {
  let trusted: string[] = [];
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')) as { trustedWorkspaces?: unknown };
    if (Array.isArray(s.trustedWorkspaces)) trusted = s.trustedWorkspaces.filter((d): d is string => typeof d === 'string');
  } catch { return null; }
  const isDir = (d: string): boolean => { try { return statSync(d).isDirectory(); } catch { return false; } };
  for (const p of preferred) if (p && trusted.includes(p) && isDir(p)) return p;
  return trusted.find(isDir) ?? null;
}

/** One probe: spawn, /quota, read, /exit. Resolves with the reading or a short reason
 *  (never screen text, which carries the account email). */
export function probeAgyQuota(cwd: string, timeoutMs = 60_000): Promise<{ quota: AgyQuota } | { error: string }> {
  const bin = resolveCommand('agy');
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    // Not a hive agent: the agy hook shim must stay a no-op for this session.
    for (const k of Object.keys(env)) if (k === 'AGENT_ID' || k === 'AGENT_NAME' || k.startsWith('HIVE_')) delete env[k];
    env.PATH = userShellPath();
    env.TERM = 'xterm-256color';
    let p: pty.IPty;
    try {
      const run = inAgentScope(bin, []);
      p = pty.spawn(run.file, run.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env });
    } catch (e) {
      resolve({ error: `could not start agy (${e instanceof Error ? e.message : String(e)})` });
      return;
    }
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    // Terminal queries (cursor position, colours) are answered by the emulator.
    term.onData((d) => { try { p.write(d); } catch { /* exited */ } });
    let exited = false;
    p.onData((d) => term.write(d));
    p.onExit(() => { exited = true; });
    const screen = (): string => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = b.baseY; i < b.baseY + ROWS; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
      return out.join('\n');
    };
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + timeoutMs;
    const waitFor = async (want: AgyScreen[], ms: number): Promise<AgyScreen> => {
      const end = Math.min(Date.now() + ms, deadline);
      let kind: AgyScreen = 'unknown';
      while (Date.now() < end && !exited) {
        kind = classifyAgyScreen(screen());
        if (want.includes(kind)) return kind;
        await sleep(200);
      }
      return kind;
    };
    const finish = async (result: { quota: AgyQuota } | { error: string }, polite: boolean): Promise<void> => {
      if (polite && !exited) {
        try {
          p.write('\x1b');
          if ((await waitFor(['ready'], 5000)) === 'ready') {
            p.write('/exit');
            if ((await waitFor(['menu-exit'], 3000)) === 'menu-exit') p.write('\r');
          }
          const end = Date.now() + 5000;
          while (!exited && Date.now() < end) await sleep(100);
        } catch { /* fall through to the kill */ }
      }
      if (!exited) {
        const pid = p.pid;
        try { p.kill(); } catch { /* gone */ }
        ensureKilled(pid);
      }
      term.dispose();
      resolve(result);
    };
    void (async () => {
      const first = await waitFor(['ready', 'trust'], 30_000);
      if (first !== 'ready') return finish({ error: first === 'trust' ? 'agy asked to trust its folder' : `agy did not reach its prompt (${first})` }, false);
      p.write('/quota');
      if ((await waitFor(['menu-quota'], 5000)) !== 'menu-quota') return finish({ error: 'the /quota menu entry did not appear' }, false);
      p.write('\r');
      const end = Math.min(Date.now() + 20_000, deadline);
      while (Date.now() < end && !exited) {
        const q = parseAgyQuota(screen(), Date.now());
        if (q) return finish({ quota: q }, true);
        await sleep(250);
      }
      return finish({ error: 'the quota panel did not show both pools' }, true);
    })();
  });
}

/** Cached reading, refreshed every 5 minutes and on demand (at most once a minute). */
export class AgyQuotaGauge {
  private last: AgyQuota | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private lastAttempt = 0;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly workspace: () => string | null,
    private readonly log: (event: Record<string, unknown>) => void = () => {}
  ) {}

  get(): { quota: AgyQuota | null; error: string | null } {
    return { quota: this.last, error: this.lastError };
  }

  refresh(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastAttempt < MIN_ON_DEMAND_GAP_MS) return Promise.resolve();
    const cwd = this.workspace();
    if (!cwd) { this.settle('no folder agy already trusts'); return Promise.resolve(); }
    this.lastAttempt = Date.now();
    this.running = probeAgyQuota(cwd).then((r) => {
      if ('quota' in r) { this.last = r.quota; this.settle(null); }
      else { this.settle(r.error); console.warn('[agy-quota]', r.error); }
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private settle(error: string | null): void {
    this.failures = error === null ? 0 : this.failures + 1;
    const event = agyProbeLogEvent(this.lastError, error, this.failures, this.last?.at);
    this.lastError = error;
    if (event) this.log(event);
  }

  start(): void {
    if (this.timer) return;
    setTimeout(() => { void this.refresh(true); }, 20_000).unref?.();
    this.timer = setInterval(() => { void this.refresh(true); }, AGY_PROBE_EVERY_MS);
  }
}

let lastGauge: AgyQuotaGauge | null = null;

export function readLastAgyQuota(): AgyQuota | null {
  return lastGauge ? lastGauge.get().quota : null;
}

/** Starts the gauge only when agy is installed. The returned reader is for engine choice,
 *  so it drops a stale reading; the title bar still shows the last one. */
export function initAgyQuota(
  preferredWorkspaces: () => Array<string | null | undefined>,
  log: (event: Record<string, unknown>) => void
): () => AgyQuota | null {
  const gauge = new AgyQuotaGauge(() => trustedAgyWorkspace(preferredWorkspaces()), log);
  lastGauge = gauge;
  ipcMain.handle('agyQuota:get', () => gauge.get().quota);
  ipcMain.handle('agyQuota:refresh', async () => { await gauge.refresh(false); return gauge.get().quota; });
  const read = (): AgyQuota | null => agyQuotaForEngines(gauge.get().quota, Date.now());
  const bin = resolveCommand('agy');
  if (bin === 'agy' && !existsSync(bin)) return read;
  gauge.start();
  return read;
}
