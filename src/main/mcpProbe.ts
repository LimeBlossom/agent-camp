import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveCommand, userShellPath } from './shellEnv';
import type { McpStdioSpec } from '../shared/mcpCatalog';

export interface McpProbeResult {
  ok: boolean;
  /** Why it failed: spawn error, exit before answering, or timeout. */
  reason?: string;
  tools?: number;
}

export type McpProbe = (spec: McpStdioSpec) => Promise<McpProbeResult>;

/** Start the server, send `initialize` then `tools/list`, and kill it (its whole process
 *  group: npx and uvx each leave the real server as a grandchild) on the first answer,
 *  exit or timeout. A server that cannot answer here would sit in the agent's startup. */
export function probeMcpServer(spec: McpStdioSpec, timeoutMs = 20_000): Promise<McpProbeResult> {
  // npx and uvx are .cmd shims there, which need a shell and leave no process group to
  // kill, so Windows keeps every server and lets the CLI report a failed one.
  if (process.platform === 'win32') return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveCommand(spec.command), spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PATH: userShellPath(), ...(spec.env ?? {}) }
      });
    } catch (e) {
      resolve({ ok: false, reason: `spawn failed: ${(e as Error).message}` });
      return;
    }
    let done = false;
    let out = '';
    let errTail = '';
    const finish = (r: McpProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `no tools/list answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, reason: `spawn failed: ${e.message}` }));
    child.on('exit', (code) => {
      const last = errTail.trim().split('\n').pop()?.slice(0, 200);
      finish({ ok: false, reason: `exited ${code} before answering${last ? `: ${last}` : ''}` });
    });
    child.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000); });
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      let i: number;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { finish({ ok: false, reason: `initialize failed: ${msg.error.message ?? ''}` }); return; }
          child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        } else if (msg.id === 2) {
          finish(msg.error ? { ok: false, reason: `tools/list failed: ${msg.error.message ?? ''}` } : { ok: true, tools: msg.result?.tools?.length ?? 0 });
        }
      }
    });
    child.stdin?.on('error', () => { /* exit or error reports it */ });
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'munder-difflin-probe', version: '1' } }
    })}\n`);
  });
}

/** A pass is trusted for a day and re-checked in the background after that; a failure
 *  is retried after ten minutes. */
const OK_TTL_MS = 24 * 3_600_000;
const FAIL_TTL_MS = 10 * 60_000;

interface CacheEntry extends McpProbeResult { at: number }

/** Probe results keyed by the launch spec (so a cwd-scoped server is checked per cwd),
 *  persisted to `file` so a restart does not hold the first spawn on a fresh round of
 *  handshakes. Concurrent spawns share one probe per spec. */
export class McpProbeCache {
  private entries: Record<string, CacheEntry> | null = null;
  private inflight = new Map<string, Promise<McpProbeResult>>();

  constructor(private file: () => string | null, private probe: McpProbe = (s) => probeMcpServer(s)) {}

  setProbe(probe: McpProbe): void { this.probe = probe; this.inflight.clear(); }

  async check(spec: McpStdioSpec, now = Date.now()): Promise<McpProbeResult> {
    const key = createHash('sha1').update(JSON.stringify([spec.command, spec.args])).digest('hex').slice(0, 16);
    const hit = this.load()[key];
    if (hit && now - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) return hit;
    const run = this.run(key, spec);
    // A stale pass keeps the server for this spawn while the re-check runs.
    if (hit?.ok) return hit;
    return run;
  }

  private run(key: string, spec: McpStdioSpec): Promise<McpProbeResult> {
    let p = this.inflight.get(key);
    if (!p) {
      p = this.probe(spec).catch((e: Error) => ({ ok: false, reason: `probe failed: ${e.message}` })).then((r) => {
        this.load()[key] = { ...r, at: Date.now() };
        this.inflight.delete(key);
        this.save();
        return r;
      });
      this.inflight.set(key, p);
    }
    return p;
  }

  private load(): Record<string, CacheEntry> {
    if (this.entries) return this.entries;
    this.entries = {};
    const f = this.file();
    try { if (f && existsSync(f)) this.entries = JSON.parse(readFileSync(f, 'utf8')) ?? {}; } catch { /* rebuilt by the next probe */ }
    return this.entries!;
  }

  private save(): void {
    const f = this.file();
    if (!f) return;
    try { writeFileSync(f, JSON.stringify(this.entries, null, 2), 'utf8'); } catch { /* the in-memory copy still serves */ }
  }
}
