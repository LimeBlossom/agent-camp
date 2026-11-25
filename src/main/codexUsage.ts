/**
 * Activity for Codex agents, which leave no Claude transcript for the telemetry
 * collector: the roster showed them at 0 tokens and "no activity yet", and the
 * no-model-progress watchdog fired on agents that were committing.
 *
 * Codex appends every event to a rollout file named `rollout-<local time>-<sessionId>.jsonl`.
 * The registry's sessionId is that id. The tail of the file gives the cumulative
 * `token_count.total_token_usage`, the newest event time, and the last tool call.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentUsageSample } from './usage';
import { recentDateDirs, sessionRoots } from './codexLimits';

export interface CodexActivity { input: number; output: number; cacheRead: number; ts: number; lastTool: string | null }

const TAIL_BYTES = 512 * 1024;
const SESSION_ID = /^[0-9a-f-]{36}$/i;

/** The rollout file for one session, searched over the recent date folders of every root. */
export function codexRolloutPath(sessionId: string, roots: string[], nowMs = Date.now()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const suffix = `-${sessionId}.jsonl`;
  for (const root of roots) {
    for (const day of recentDateDirs(nowMs, 3)) {
      let names: string[];
      try { names = readdirSync(join(root, day)); } catch { continue; }
      const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
      if (hit) return join(root, day, hit);
    }
  }
  return null;
}

/** Fold a file tail (first line may be cut) into the newest activity it shows, or null. */
export function codexActivityFromTail(text: string, fallbackTs: number): CodexActivity | null {
  interface Total { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
  let total = null as Total | null;
  let ts = 0;
  let lastTool: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: { timestamp?: string; type?: string; payload?: { type?: string; name?: string; info?: { total_token_usage?: Total } | null } };
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(t) && t > ts) ts = t;
    const p = o.payload;
    if (o.type === 'event_msg' && p?.type === 'token_count' && p.info?.total_token_usage) total = p.info.total_token_usage;
    else if (o.type === 'response_item' && (p?.type === 'custom_tool_call' || p?.type === 'function_call') && p.name) lastTool = p.name;
  }
  if (!ts && !total) return null;
  const cached = total?.cached_input_tokens ?? 0;
  return {
    // Codex counts cached tokens inside input_tokens; Claude's sample keeps them apart.
    input: Math.max(0, (total?.input_tokens ?? 0) - cached), output: total?.output_tokens ?? 0, cacheRead: cached,
    ts: ts || fallbackTs, lastTool,
  };
}

function readTail(path: string): { text: string; mtime: number } | null {
  try {
    const size = statSync(path).size, mtime = statSync(path).mtimeMs;
    const len = Math.min(size, TAIL_BYTES);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      return { text: buf.toString('utf8'), mtime };
    } finally { closeSync(fd); }
  } catch { return null; }
}

export function codexActivity(sessionId: string | undefined, roots: string[], nowMs = Date.now()): CodexActivity | null {
  if (!sessionId) return null;
  const path = codexRolloutPath(sessionId, roots, nowMs);
  const tail = path ? readTail(path) : null;
  return tail ? codexActivityFromTail(tail.text, tail.mtime) : null;
}

/** A usage sample for a Codex agent, or undefined when its rollout is unreadable. `usd` is 0:
 *  Codex runs on a subscription, so there is no per-token price to report. */
export function codexUsageSample(
  agentId: string, provider: string | undefined, sessionId: string | undefined,
  hiveRoot: string | null, nowMs = Date.now(), codexHome = join(homedir(), '.codex'),
): (AgentUsageSample & { lastTool: string | null }) | undefined {
  if (provider !== 'codex' || !sessionId) return undefined;
  const a = codexActivity(sessionId, sessionRoots(codexHome, hiveRoot), nowMs);
  if (!a) return undefined;
  return { agentId, sessionId, ts: a.ts, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheCreation: 0, model: null, usd: 0, lastTool: a.lastTool };
}
