/**
 * Summaries of HIVE_ROOT/engine-ledger.jsonl, the per-worker record of which engine a
 * temporary worker ran on and how it ended. Pure, so test/engine-ledger.test.cjs can pin
 * it; index.ts writes the result to engine-ledger-summary.md and the workers tab shows it.
 */

export interface EngineLedgerRow {
  /** Engine label: provider, model when set, whether the ladder or a name picked it, and
   *  the request's difficulty when it had one. */
  engine: string;
  /** Effort level the worker launched at; "-" for rows written before the ledger recorded it. */
  effort: string;
  runs: number;
  running: number;
  outcomes: Record<string, number>;
  medianMinutes: number | null;
}

interface Start { ts: number; workerId: string; provider?: string; model?: string; chosenBy?: string; difficulty?: string; effort?: string }
interface End { workerId: string; outcome?: string; durationMs?: number }

/** Per-engine rows for workers started at or after `sinceMs`, most-used engine first. */
export function summarizeLedger(text: string, sinceMs = 0): EngineLedgerRow[] {
  const starts = new Map<string, Start>();
  const ends = new Map<string, End>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: { kind?: string } & Start & End;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 'start' && typeof e.ts === 'number' && e.ts >= sinceMs) starts.set(e.workerId, e);
    else if (e.kind === 'end') ends.set(e.workerId, e);
  }
  const rows = new Map<string, EngineLedgerRow & { minutes: number[] }>();
  for (const [id, s] of starts) {
    const engine = `${s.provider ?? 'unknown'}${s.model ? ` (${s.model})` : ''} [${s.chosenBy ?? 'named'}${s.difficulty ? `, ${s.difficulty}` : ''}]`;
    const effort = s.effort ?? '-';
    const key = `${engine}\u0000${effort}`;
    const r = rows.get(key) ?? { engine, effort, runs: 0, running: 0, outcomes: {}, medianMinutes: null, minutes: [] };
    r.runs++;
    const end = ends.get(id);
    if (!end) r.running++;
    else {
      const o = end.outcome ?? 'exited';
      r.outcomes[o] = (r.outcomes[o] ?? 0) + 1;
      if (typeof end.durationMs === 'number') r.minutes.push(end.durationMs / 60_000);
    }
    rows.set(key, r);
  }
  return [...rows.values()]
    .map(({ minutes, ...r }) => ({ ...r, medianMinutes: median(minutes) }))
    .sort((a, b) => b.runs - a.runs);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** One markdown table, or a line saying there were no workers. */
export function ledgerTable(rows: readonly EngineLedgerRow[]): string {
  if (!rows.length) return 'No temporary workers.';
  const lines = ['| Engine | Effort | Runs | How they ended | Median minutes |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const ended = Object.entries(r.outcomes).map(([k, n]) => `${k} ${n}`).join(', ');
    const outs = [ended, r.running ? `${r.running} still running` : ''].filter(Boolean).join(', ') || '-';
    lines.push(`| ${r.engine} | ${r.effort} | ${r.runs} | ${outs} | ${r.medianMinutes === null ? '-' : r.medianMinutes.toFixed(1)} |`);
  }
  return lines.join('\n');
}

/** The whole engine-ledger-summary.md: the last week, then all time. */
export function ledgerSummaryMarkdown(text: string, nowMs: number): string {
  const week = summarizeLedger(text, nowMs - 7 * 86_400_000);
  const all = summarizeLedger(text);
  return [
    '# Engine ledger summary',
    '',
    `Written ${new Date(nowMs).toISOString()} from engine-ledger.jsonl. "ladder" means the engines list picked it; "named" means the request named its engine.`,
    '',
    '## Last 7 days',
    '',
    ledgerTable(week),
    '',
    '## All time',
    '',
    ledgerTable(all),
    ''
  ].join('\n');
}
