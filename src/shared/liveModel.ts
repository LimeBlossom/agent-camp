import type { AgentModelEntry } from './modelBalance';

/**
 * The model a session is actually running, read from its session log (or its tail),
 * or null when the log does not say.
 *
 * The roster's `model` is only what the session was LAUNCHED with. A session can move
 * off it without the harness: Codex's own "switch to a cheaper model" prompt, or a
 * `/model` typed into the terminal. The log is the only record of that.
 *  - Codex: the latest `turn_context.model` or `thread_settings_applied` model.
 *  - Claude: the latest assistant message's `message.model`.
 */
export function liveModelFromLog(text: string, provider: string): string | null {
  let model: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"model"')) continue;
    let d: { type?: unknown; payload?: Record<string, unknown>; message?: Record<string, unknown> };
    try { d = JSON.parse(line); } catch { continue; }
    let m: unknown;
    if (provider === 'codex') {
      const p = d.payload;
      if (d.type === 'turn_context') m = p?.model;
      else if (d.type === 'event_msg' && p?.type === 'thread_settings_applied') {
        m = (p.thread_settings as { model?: unknown } | undefined)?.model;
      }
    } else if (d.type === 'assistant') {
      m = d.message?.model;
    }
    // Claude Code writes "<synthetic>" on messages it made itself, not the API.
    if (typeof m === 'string' && m && !m.startsWith('<')) model = m;
  }
  return model;
}

/** The model a live session runs: its log's, else the one the harness launched it on
 *  (agy keeps no log; a fresh session has not logged a turn yet). */
export function sessionModel(fromLog: string | null, launched: string | undefined): string | null {
  return fromLog ?? (launched?.trim() || null);
}

/** A model id without its context-window suffix: `claude-opus-5-5[1m]` → `claude-opus-5-5`.
 *  The roster carries the suffix, a transcript does not. */
function baseModel(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
}

export function sameModel(a: string, b: string): boolean {
  return baseModel(a) === baseModel(b);
}

/**
 * May a session of `provider` run `live`, given the agent's allowed entries? Only
 * entries on the session's own provider can match. An entry with no model means the
 * CLI default, which the log cannot be checked against, so it allows anything.
 */
export function liveModelAllowed(live: string, provider: string, allowed: readonly AgentModelEntry[]): boolean {
  const own = allowed.filter((e) => e.provider === provider);
  if (!own.length) return false;
  return own.some((e) => !e.model || sameModel(e.model, live));
}
