import { getUnmetDependencies } from '../shared/taskDeps';
import { priorityLevel } from '../shared/taskPriority';
import { sortOpenCards, type NudgeCard } from './todoNudge';

export interface TaskViewCard extends NudgeCard {
  project?: string;
  sendBacks?: number;
  needs?: unknown;
}

const OPEN = new Set(['todo', 'doing', 'blocked']);
const NOTES_MAX = 400;
const ANSWER_MAX = 200;

/** The body of one agent's my-tasks.md: its open cards in work order (the Boss's lists
 *  every open card on the floor), each with priority and any undone dependency. */
export function renderTaskView(o: { tasks: readonly TaskViewCard[]; agentId: string; isBoss: boolean; tasksPath: string }): string {
  const { tasks, isBoss } = o;
  const open = tasks.filter((t) => OPEN.has(String(t.status)) && (isBoss || t.assignee === o.agentId));
  const one = (t: TaskViewCard): string => {
    const asks = Array.isArray(t.humanQA) ? (t.humanQA as Array<{ a?: unknown }>) : [];
    const lastAsk = asks.length ? asks[asks.length - 1] : null;
    const rawNotes = typeof t.notes === 'string' ? t.notes : t.description ?? '';
    const notes = rawNotes.replace(/\s+/g, ' ').trim();
    const waiting = t.status === 'blocked' ? [] : getUnmetDependencies(t, tasks);
    return [
      `- \`${t.id}\` ${t.status}${t.project ? ` [${t.project}]` : ''}${isBoss ? ` @${t.assignee ?? 'unassigned'}` : ''}: ${t.title ?? ''} [${priorityLevel(t.priority)}; ${t.difficulty ?? 'normal'}${t.kind ? `; ${t.kind}` : ''}${Array.isArray(t.needs) && t.needs.length ? `; needs ${t.needs.join(', ')}` : ''}; send-backs ${t.sendBacks ?? 0}]${waiting.length ? ` waiting on ${waiting.map((d) => `\`${d}\``).join(', ')}` : ''}`,
      !isBoss && notes ? `  notes: ${notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX - 1)}…` : notes}` : '',
      !isBoss && lastAsk ? `  last ask: ${lastAsk.a ? 'answered' : 'open'}${lastAsk.a ? `: ${String(lastAsk.a).replace(/\s+/g, ' ').slice(0, ANSWER_MAX)}` : ''}` : ''
    ].filter(Boolean).join('\n');
  };
  const head = `# Open cards\n\n_Written by the harness from tasks.json whenever it changes; do not edit. Listed in the order you work them (doing, then todo by priority and age, then todo waiting on a dependency, then blocked). Read one card in full with \`jq '.tasks[] | select(.id=="<id>")' "${o.tasksPath}"\`. tasks.json is read-only for agents: change a card with a \`task-patch\` message to \`harness\` (PROTOCOL.md, "Changing a card")._\n\n`;
  const done = isBoss ? 0 : tasks.filter((t) => t.assignee === o.agentId && t.status === 'done').length;
  return head + (open.length ? sortOpenCards(open, tasks).map(one).join('\n') : '_None open._')
    + (done ? `\n\n${done} done card(s) not listed.` : '') + '\n';
}
