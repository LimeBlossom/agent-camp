/**
 * Token usage for Antigravity (`agy`) agents, which leave no Claude transcript for
 * the telemetry collector to read.
 *
 * agy keeps each conversation as SQLite at
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`, and the hook
 * payload's `conversationId` is what the hive records as the agent's session. Each
 * `gen_metadata` row is one model call, a protobuf whose field 1.4 holds its usage:
 * 1.4.2 input, 1.4.3 output, 1.4.5 cache read. The mapping is reverse-engineered,
 * and was checked against three `agy -p --output-format json` runs, where
 * input + cache read and output matched the CLI's own totals exactly.
 */
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentUsageSample } from './usage';

export interface AgyTotals { input: number; output: number; cacheRead: number; ts: number }

function varint(b: Uint8Array, i: number): [number, number] {
  let r = 0, mul = 1;
  for (;;) {
    if (i >= b.length) throw new Error('truncated');
    const x = b[i++];
    r += (x & 0x7f) * mul;
    if (!(x & 0x80)) return [r, i];
    mul *= 128;
    if (mul > 2 ** 63) throw new Error('varint too long');
  }
}

/** Visit each field of one message: (fieldNo, varint value | sub-bytes). */
function fields(b: Uint8Array, visit: (f: number, v: number | Uint8Array) => void): void {
  let i = 0;
  while (i < b.length) {
    const [key, j] = varint(b, i); i = j;
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { const [v, k] = varint(b, i); i = k; visit(f, v); }
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      const [n, k] = varint(b, i); i = k;
      if (i + n > b.length) throw new Error('truncated');
      visit(f, b.subarray(i, i + n)); i += n;
    } else throw new Error(`wire type ${wt}`);
  }
}

/** Sum 1.4.{2,3,5} over one gen_metadata blob; rows that fail to parse add nothing. */
export function usageFromGenMetadata(blob: Uint8Array): { input: number; output: number; cacheRead: number } {
  const out = { input: 0, output: 0, cacheRead: 0 };
  try {
    fields(blob, (f1, v1) => {
      if (f1 !== 1 || typeof v1 === 'number') return;
      fields(v1, (f2, v2) => {
        if (f2 !== 4 || typeof v2 === 'number') return;
        fields(v2, (f3, v3) => {
          if (typeof v3 !== 'number') return;
          if (f3 === 2) out.input += v3;
          else if (f3 === 3) out.output += v3;
          else if (f3 === 5) out.cacheRead += v3;
        });
      });
    });
  } catch {
    return { input: 0, output: 0, cacheRead: 0 };
  }
  return out;
}

export function agyConversationDb(conversationId: string, root = join(homedir(), '.gemini', 'antigravity-cli')): string | null {
  return /^[0-9a-f-]{36}$/i.test(conversationId) ? join(root, 'conversations', `${conversationId}.db`) : null;
}

const cache = new Map<string, { mtime: number; totals: AgyTotals }>();

/** Totals for one conversation db, re-read only when the file changes. */
export function readAgyTotals(dbPath: string): AgyTotals | null {
  let mtime: number;
  try { mtime = statSync(dbPath).mtimeMs; } catch { return null; }
  const hit = cache.get(dbPath);
  if (hit && hit.mtime === mtime) return hit.totals;
  let db: Database.Database | null = null;
  try {
    // agy holds the file open while it runs; a read-only handle does not block it.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const totals: AgyTotals = { input: 0, output: 0, cacheRead: 0, ts: mtime };
    for (const row of db.prepare('SELECT data FROM gen_metadata').iterate() as Iterable<{ data: Buffer | null }>) {
      if (!row.data) continue;
      const u = usageFromGenMetadata(row.data);
      totals.input += u.input; totals.output += u.output; totals.cacheRead += u.cacheRead;
    }
    cache.set(dbPath, { mtime, totals });
    return totals;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** A usage sample for an Antigravity agent, or undefined when it has no readable conversation.
 *  `usd` is 0: agy runs on a flat subscription, so there is no per-token price to report. */
export function agyUsageSample(agentId: string, provider: string | undefined, sessionId: string | undefined): AgentUsageSample | undefined {
  if (provider !== 'antigravity' || !sessionId) return undefined;
  const path = agyConversationDb(sessionId);
  const t = path ? readAgyTotals(path) : null;
  if (!t) return undefined;
  return { agentId, sessionId, ts: t.ts, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: 0, model: null, usd: 0 };
}
