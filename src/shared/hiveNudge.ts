/**
 * The inbox-wake nudge — the text queued for an agent that has unread hive mail,
 * and the predicate the message queue uses to keep only one of them pending.
 *
 * The nudge is QUEUED the moment fresh mail is seen but TYPED only once the agent
 * is idle and off cooldown, and it survives a renderer reload in the persisted
 * queue. By the time it lands, the agent has often already drained that mail and
 * filed it under `inbox/.done/` — so the nudge arrives against an inbox the agent
 * itself just emptied.
 */

/** The fixed head of every nudge; the ids that follow differ per nudge. */
const NUDGE_HEAD = 'You have new hive inbox message(s)';

/** Closing time: the mail that matters is the shutdown brief, and anything else
 *  read now would start work the floor is about to close on. */
const CLOSING_MARK = 'WRAP UP is in progress.';
const WORKER_CLOSING = `${CLOSING_MARK} Read your inbox for the wrap-up brief and handle ONLY that: park or commit your work-in-progress, append your state and next steps to your memory.md, then reply to the Boss ("to":"boss") with the subject exactly "WRAP-UP-ACK". Do not start, resume or accept any other work or card; leave every other message in your inbox for after wrap-up.`;
const BOSS_CLOSING = `${CLOSING_MARK} Read your inbox and handle ONLY the shutdown protocol: collect each worker's WRAP-UP-ACK, save your own state, then send WRAP-UP-COMPLETE. Do not create or assign cards and do not start new work.`;

/** How a wake reaches one agent: as usual, with the closing-time text, or not at all
 *  (a worker that has already sent its CLOSING-TIME-ACK). */
export type WakeMode = 'normal' | 'closing' | 'skip';

/**
 * Build the nudge, naming the messages that prompted it.
 *
 * The ids are diagnostic, NOT a work list: they let an agent tell "I already
 * handled this last turn" (the id sits in `inbox/.done/`) from "the harness woke
 * me for nothing", which is the distinction it otherwise cannot make and burns a
 * round-trip guessing at. The pending inbox stays authoritative — an agent that
 * has a nudge suppressed by the one-pending rule below still finds its mail by
 * reading the directory, so the text must never invite it to stop at the ids.
 */
export function inboxNudgeText(ids: string[], recipient: 'worker' | 'boss' = 'worker', closing = false): string {
  const named = ids.length ? ` — at least: ${ids.join(', ')}` : '';
  if (closing) return `${NUDGE_HEAD}${named}. ${recipient === 'boss' ? BOSS_CLOSING : WORKER_CLOSING}`;
  // The boss IS god: telling it to "message god" told it to message itself. Its
  // escalation goes to the human instead.
  const escalate = recipient === 'boss'
    ? 'only ask the human (the ASK ME board) if you genuinely need a decision'
    : 'only message the Boss ("to":"boss") if you genuinely need a decision';
  return `${NUDGE_HEAD}${named}. Read your inbox, act on what is pending there, and move handled ones to inbox/.done/. Your inbox directory is authoritative: work everything still pending in it, and if a named id is already in inbox/.done/ you handled it on an earlier turn and can ignore that one. Act autonomously; ${escalate}.`;
}

/**
 * Is this queued text an inbox-wake nudge?
 *
 * Matches the fixed head only, since every nudge carries different ids — the
 * point is to recognise the COMMAND, not one instance of it. Mirrors
 * `isCompactionCommand`, and the queue's one-pending rule leans on it the same way.
 */
export function isInboxNudge(text: string): boolean {
  return text.trim().startsWith(NUDGE_HEAD);
}

/** Queued prompts that put an agent to work: main's next-card nudge (todoNudgeText)
 *  and the limit-resume note (limitResumeText). Closing time drops them undelivered. */
const WORK_START = [/^NEXT CARD: /, /^Your .+ usage limit has reset\. Continue the work/, /^CONTEXT COMPACTED: /];

/** Queued for the Boss when a compaction finishes. A compaction that /compact typed ends
 *  at an idle prompt, and nothing else re-engages the Boss until mail arrives. */
export function bossCompactResumeText(agentDir: string): string {
  return `CONTEXT COMPACTED: your context was just summarised. Before anything else, re-orient: read ${agentDir}/my-tasks.md, ${agentDir}/memory.md and your pending inbox, and check the live roster. Finish any task you were partway through, then check on every worker with an open card: is it working, stalled, or waiting on you for a review, an answer or a merge? Act on what you find; if everything is genuinely in hand, say so in one line and wait.`;
}

export function isWorkStartPrompt(text: string): boolean {
  const t = text.trim();
  return WORK_START.some((re) => re.test(t));
}

/** Is this nudge the closing-time variant? */
export function isClosingNudge(text: string): boolean {
  return isInboxNudge(text) && text.includes(CLOSING_MARK);
}

/**
 * The text to type for a queued message given the agent's wake mode at delivery
 * time, or null to drop it. During closing time a work-start prompt is dropped. A nudge is queued long before it is typed, so the
 * closing-time state it was built under may have changed: an ACKed worker's nudge
 * is dropped, and a nudge built for the wrong side of closing time is rebuilt from
 * the inbox ids pending now. Anything that is not an inbox nudge passes through.
 */
export function nudgeForWakeMode(text: string, mode: WakeMode, ids: string[], recipient: 'worker' | 'boss'): string | null {
  if (isWorkStartPrompt(text)) return mode === 'normal' ? text : null;
  if (!isInboxNudge(text)) return text;
  if (mode === 'skip') return null;
  const closing = mode === 'closing';
  return closing === isClosingNudge(text) ? text : inboxNudgeText(ids, recipient, closing);
}
