/** Words that mean an answer redirects the work rather than settling the question:
 *  a scope change (add, drop, stop, instead, backlog, reassign) or a model or provider
 *  pick. A match sends the answer to the Boss as well as the assignee. */
export const SCOPE_OR_MODEL = /\b(?:scope|instead|also|add|drop|cancel|stop|don'?t|do not|backlog|shelve|park|reassign|another agent|priority|split|merge|model|provider|opus|sonnet|haiku|fable|codex|gemini|gpt|agy|antigravity)\b/i;

/** An answer this long is a brief, not a pick, so the Boss reads it too. */
export const LONG_ANSWER_CHARS = 400;

export function answerNeedsBoss(a: string): boolean {
  return a.length > LONG_ANSWER_CHARS || SCOPE_OR_MODEL.test(a);
}

/** The assignee's mail for an answered ASK on its card. */
export function assigneeAnswerBody(task: { id: string; title?: string }, q: string, a: string, unblocked: boolean): string {
  return [
    `The human answered the open question on your card ${task.id} ("${task.title ?? ''}"):`,
    `Q: ${q}`,
    `A: ${a}`,
    unblocked
      ? 'The harness moved the card to todo. Pick it up from the answer; the Q&A is also in the card\'s humanQA.'
      : 'The answer is also in the card\'s humanQA. Carry on from it.'
  ].join('\n');
}

/** The Boss's note when the harness already routed an answer that looks like it moves scope or model. */
export function bossAnswerNote(task: { id: string; assignee?: string }, unblocked: boolean): string {
  return `The harness already ${unblocked ? 'moved the card to todo and ' : ''}mailed ${task.assignee} this answer. It reads like a scope or model change, so check the card's brief, assignee and model.`;
}
