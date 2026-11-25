/**
 * Formatting utilities for multi-engine token usage across Camp floor views (phone and desktop).
 */

import type { UsageLedgerRow } from '../main/usageLedger';

export interface AgentEngineTokens {
  engine: string;
  totalTokens: number;
}

/**
 * Format an agent's 7-day token usage per engine into a concise line for floor views,
 * e.g. "1.5M agy · 250k codex".
 *
 * Engines are sorted by token count descending and formatted with compact token notation.
 * Returns an empty string if no tokens were used or the input is empty.
 */
export function formatAgentUsage7d(
  entries: readonly (UsageLedgerRow | AgentEngineTokens)[] | undefined | null
): string {
  const byEngine = new Map<string, number>();
  for (const e of entries ?? []) {
    if (e.totalTokens > 0) byEngine.set(e.engine, (byEngine.get(e.engine) ?? 0) + e.totalTokens);
  }
  return [...byEngine]
    .sort((a, b) => b[1] - a[1])
    .map(([engine, tokens]) => `${compactTokens(tokens)} ${engine}`)
    .join(' · ');
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

const trim = (v: number) => v.toFixed(1).replace(/\.0$/, '');
