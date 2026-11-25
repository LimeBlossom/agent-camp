import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ReplyLike {
  in_reply_to?: unknown;
  conversation?: unknown;
  /** Who the reply goes to, already resolved to an agent id (boss/god to the Boss's id). */
  to: string;
  /** When the agent wrote the reply (its outbox file's mtime). */
  atMs: number;
}

export interface InboxEntry {
  file: string;
  id?: unknown;
  conversation?: unknown;
  from?: unknown;
  mtimeMs?: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Inbox files an outgoing reply has handled: the message it names in `in_reply_to`
 *  (by id or file name), and mail from the same peer in the same conversation that was
 *  already there when the reply was written; a later follow-up stays pending. A
 *  conversation only counts when the reply set it, since the harness invents one for a
 *  message that has none. */
export function handledInboxFiles(reply: ReplyLike, inbox: readonly InboxEntry[]): string[] {
  const replyTo = str(reply.in_reply_to);
  const conv = str(reply.conversation);
  if (!replyTo && !conv) return [];
  if (replyTo) {
    return inbox
      .filter((m) => m.id === replyTo || m.file === replyTo || m.file === `${replyTo}.json`)
      .map((m) => m.file);
  }
  return inbox
    .filter((m) => m.conversation === conv && m.from === reply.to && typeof m.mtimeMs === 'number' && m.mtimeMs <= reply.atMs)
    .map((m) => m.file);
}

/** Move the inbox files `reply` handled into inbox/.done. Returns the files moved. */
export function fileHandledInbox(agentDir: string, reply: ReplyLike): string[] {
  if (!str(reply.in_reply_to) && !str(reply.conversation)) return [];
  const inbox = join(agentDir, 'inbox');
  if (!existsSync(inbox)) return [];
  const entries: InboxEntry[] = [];
  for (const file of readdirSync(inbox)) {
    if (!file.endsWith('.json')) continue;
    try {
      const full = join(inbox, file);
      const m = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
      entries.push({ file, id: m.id, conversation: m.conversation, from: m.from, mtimeMs: statSync(full).mtimeMs });
    } catch { entries.push({ file }); }
  }
  const moved: string[] = [];
  const done = join(inbox, '.done');
  for (const file of handledInboxFiles(reply, entries)) {
    try {
      mkdirSync(done, { recursive: true });
      renameSync(join(inbox, file), join(done, file));
      moved.push(file);
    } catch { /* the agent filed it first */ }
  }
  return moved;
}
