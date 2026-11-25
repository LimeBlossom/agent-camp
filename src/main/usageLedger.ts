/**
 * Per-agent, per-engine usage ledger.
 *
 * Ingests:
 *   1. Codex session rollouts (JSONL with token_count events and turn_context/thread_settings model)
 *   2. Antigravity (agy) conversation totals (input, output, cacheRead from protobuf gen_metadata)
 *   3. Claude cost-ledger.jsonl records (snake_case cumulative samples)
 * and aggregates them into per-agent, per-engine token rows and formatted markdown tables.
 */

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { engineFor, type EngineId } from './engineChoice';
import { readAgyTotals } from './agyUsage';

export interface UsageRecord {
  agentId: string;
  sessionId?: string | null;
  engine: EngineId | string;
  model?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  usd: number | null;
}

export interface UsageLedgerRow {
  agentId: string;
  engine: EngineId | string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  totalTokens: number;
  usd: number | null;
}

export interface AgyConversationInput {
  agentId: string;
  sessionId?: string;
  totals: { input: number; output: number; cacheRead: number };
  model?: string;
}

export interface CodexRolloutInput {
  agentId: string;
  sessionId?: string;
  text: string;
  model?: string;
}

export interface UsageLedgerInputs {
  codexRollouts?: CodexRolloutInput[];
  agyConversations?: AgyConversationInput[];
  costLedgerText?: string;
  records?: UsageRecord[];
}

export interface GatherUsageOptions {
  /** Root directory of the hive containing cost-ledger.jsonl, agents/, log.jsonl. */
  hiveRoot?: string;
  /** User Codex home directory containing sessions/. Required so a test cannot fall back to the real home; production passes userUsageHomes(). */
  userCodexHome: string;
  /** Antigravity home directory containing conversations/. Required for the same reason. */
  agyHome: string;
  /** Reference timestamp for calculating the recent window. Defaults to Date.now(). */
  nowMs?: number;
  /** Number of days back to include. Defaults to 7. */
  days?: number;
  /** Totals reader for agy conversation SQLite files. Defaults to readAgyTotals from agyUsage.ts. */
  readAgyTotals?: (dbPath: string) => { input: number; output: number; cacheRead: number } | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseLines(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // A torn or foreign line must not lose the rest of the file.
    }
  }
  return out;
}

/** Parse a Codex JSONL rollout into a cumulative session UsageRecord. */
export function parseCodexRollout(text: string, agentId?: string): UsageRecord | null {
  let model: string | null = null;
  let sessionId: string | null = null;
  let usage: Record<string, any> | null = null;
  for (const line of parseLines(text)) {
    const p = line.payload ?? {};
    if (line.type === 'session_meta') sessionId = p.session_id ?? p.id ?? sessionId;
    else if (line.type === 'turn_context' && typeof p.model === 'string') model = p.model;
    else if (line.type === 'event_msg') {
      if (p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') {
        model = p.thread_settings.model;
      } else if (p.type === 'token_count' && p.info?.total_token_usage) {
        usage = p.info.total_token_usage;
      }
    }
  }
  if (!usage) return null;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cached_input_tokens);
  const cacheCreation = num(usage.cache_write_input_tokens);
  return {
    agentId: agentId ?? '',
    sessionId,
    engine: 'codex',
    model,
    input,
    output,
    cacheRead,
    cacheCreation,
    totalTokens: num(usage.total_tokens) || input + output,
    usd: null
  };
}

/** Convert agy conversation totals into a UsageRecord. */
export function ingestAgyUsage(
  agentId: string,
  totals: { input: number; output: number; cacheRead: number },
  opts?: { sessionId?: string; model?: string }
): UsageRecord {
  return {
    agentId,
    sessionId: opts?.sessionId ?? null,
    engine: engineFor('antigravity', opts?.model) ?? 'agy',
    model: opts?.model ?? null,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheCreation: 0,
    totalTokens: totals.input + totals.output + totals.cacheRead,
    usd: null
  };
}

/** Parse Claude cost-ledger.jsonl text into UsageRecords. */
export function parseCostLedger(text: string): UsageRecord[] {
  // Lines are cumulative samples, so the last one per session wins.
  const latest = new Map<string, UsageRecord>();
  for (const l of parseLines(text)) {
    if (typeof l.agent_id !== 'string') continue;
    const input = num(l.input);
    const output = num(l.output);
    const cacheRead = num(l.cache_read);
    const cacheCreation = num(l.cache_creation);
    const sessionId = typeof l.session_id === 'string' ? l.session_id : null;
    latest.set(`${l.agent_id}\0${sessionId ?? ''}`, {
      agentId: l.agent_id,
      sessionId,
      engine: 'claude',
      model: typeof l.model === 'string' ? l.model : null,
      input,
      output,
      cacheRead,
      cacheCreation,
      totalTokens: input + output + cacheRead + cacheCreation,
      usd: typeof l.usd === 'number' ? l.usd : null
    });
  }
  return [...latest.values()];
}

/** Aggregate usage records into per-agent, per-engine rows. */
export function summarizeUsageLedger(inputs: UsageLedgerInputs): UsageLedgerRow[] {
  const records: UsageRecord[] = [...(inputs.records ?? [])];
  for (const c of inputs.codexRollouts ?? []) {
    const r = parseCodexRollout(c.text, c.agentId);
    if (r) records.push({ ...r, sessionId: c.sessionId ?? r.sessionId, model: c.model ?? r.model });
  }
  for (const a of inputs.agyConversations ?? []) {
    records.push(ingestAgyUsage(a.agentId, a.totals, { sessionId: a.sessionId, model: a.model }));
  }
  if (inputs.costLedgerText) records.push(...parseCostLedger(inputs.costLedgerText));

  const rows = new Map<string, UsageLedgerRow>();
  for (const r of records) {
    const key = `${r.agentId}\0${r.engine}`;
    const row =
      rows.get(key) ??
      { agentId: r.agentId, engine: r.engine, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, totalTokens: 0, usd: null };
    row.input += r.input;
    row.output += r.output;
    row.cacheRead += r.cacheRead;
    row.cacheCreation += r.cacheCreation;
    row.totalTokens += r.totalTokens;
    if (r.usd !== null) row.usd = (row.usd ?? 0) + r.usd;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Format rows into a markdown table. */
export function usageLedgerTable(rows: readonly UsageLedgerRow[]): string {
  if (rows.length === 0) return 'No usage recorded.';
  const n = (v: number) => v.toLocaleString('en-US');
  const lines = [
    '| Agent | Engine | Input | Output | Cache Read | Cache Write | Total Tokens | Cost (USD) |',
    '|---|---|---|---|---|---|---|---|'
  ];
  for (const r of rows) {
    const cost = r.usd === null ? '-' : `$${r.usd.toFixed(2)}`;
    lines.push(
      `| ${r.agentId} | ${r.engine} | ${n(r.input)} | ${n(r.output)} | ${n(r.cacheRead)} | ${n(r.cacheCreation)} | ${n(r.totalTokens)} | ${cost} |`
    );
  }
  return lines.join('\n');
}

/**
 * Gather real usage files (Claude cost-ledger.jsonl, Codex session rollouts, and Antigravity SQLite dbs)
 * for the last N days (default 7), aggregating into per-agent, per-engine UsageLedgerRow entries.
 */
/** The real per-user engine homes; only the production caller should use these. */
export function userUsageHomes(): Pick<GatherUsageOptions, 'userCodexHome' | 'agyHome'> {
  return { userCodexHome: join(homedir(), '.codex'), agyHome: join(homedir(), '.gemini', 'antigravity-cli') };
}

export async function gatherUsageLedger(opts: GatherUsageOptions): Promise<UsageLedgerRow[]> {
  if (!opts?.userCodexHome || !opts?.agyHome) throw new TypeError('gatherUsageLedger needs userCodexHome and agyHome');
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - (opts.days ?? 7) * 86_400_000;
  const hiveRoot = opts.hiveRoot;
  const { agyHome, userCodexHome } = opts;
  const readTotals = opts.readAgyTotals ?? readAgyTotals;

  const readText = (p: string) => fsp.readFile(p, 'utf8').catch(() => '');
  const inWindow = async (p: string) => {
    const st = await fsp.stat(p).catch(() => null);
    return st !== null && st.mtimeMs >= cutoff;
  };
  const inputs: UsageLedgerInputs = { codexRollouts: [], agyConversations: [] };

  if (hiveRoot) {
    // Claude: only samples inside the window; the last per session still wins.
    const ledger = await readText(join(hiveRoot, 'cost-ledger.jsonl'));
    inputs.costLedgerText = parseLines(ledger)
      .filter((l) => num(l.ts) >= cutoff)
      .map((l) => JSON.stringify(l))
      .join('\n');

    for (const id of await fsp.readdir(join(hiveRoot, 'agents')).catch(() => [] as string[])) {
      for (const file of await listRollouts(join(hiveRoot, 'agents', id, '.codex', 'sessions'))) {
        if (!(await inWindow(file))) continue;
        inputs.codexRollouts!.push({ agentId: id, text: await readText(file) });
      }
    }
  }

  // The user's own Codex home holds rollouts for agents run with the default home;
  // the session cwd names the agent's workspace.
  for (const file of await listRollouts(join(userCodexHome, 'sessions'))) {
    if (!(await inWindow(file))) continue;
    // Read only the head to find the cwd; most rollouts here belong to no hive agent.
    const fh = await fsp.open(file, 'r').catch(() => null);
    if (!fh) continue;
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0).catch(() => ({ bytesRead: 0 }));
    await fh.close();
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const cwd = parseLines(head.slice(0, head.lastIndexOf('\n') + 1)).find((l) => l.type === 'session_meta')?.payload?.cwd;
    const m = typeof cwd === 'string' && hiveRoot ? /[\\/]agents[\\/]([^\\/]+)/.exec(cwd) : null;
    const text = m ? await readText(file) : '';
    if (m) inputs.codexRollouts!.push({ agentId: m[1], text });
  }

  if (hiveRoot) {
    // agy conversations carry no agent name; log.jsonl session events map them.
    const agentBySession = new Map<string, string>();
    for (const l of parseLines(await readText(join(hiveRoot, 'log.jsonl')))) {
      if (l.kind === 'session' && typeof l.agentId === 'string' && typeof l.sessionId === 'string') {
        agentBySession.set(l.sessionId, l.agentId);
      }
    }
    for (const [sessionId, agentId] of agentBySession) {
      const db = join(agyHome, 'conversations', `${sessionId}.db`);
      if (!(await inWindow(db))) continue;
      const totals = readTotals(db);
      if (totals) inputs.agyConversations!.push({ agentId, sessionId, totals });
    }
  }
  return summarizeUsageLedger(inputs);
}

async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listRollouts(p)));
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export const gatherWeeklyUsageLedger = gatherUsageLedger;
export const gather7DayUsage = gatherUsageLedger;
