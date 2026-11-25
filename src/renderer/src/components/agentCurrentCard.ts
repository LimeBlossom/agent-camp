/**
 * The card an agent is on, for the side panel's "working on" strip. Pure, so
 * test/agent-current-card.test.cjs can pin it.
 */

import { cardNickname } from '@shared/cardNickname';
import { priorityRank } from '@shared/taskPriority';

interface CardLike {
  id?: unknown;
  title?: unknown;
  nickname?: unknown;
  status?: unknown;
  assignee?: unknown;
  priority?: unknown;
}

export interface CurrentCard {
  id: string;
  title: string;
  nickname: string;
  /** Other `doing` cards the agent also holds. */
  more: number;
}

/** The agent's highest-priority `doing` card, or null. */
export function currentCard(tasks: ReadonlyArray<CardLike>, agentId: string): CurrentCard | null {
  const doing = tasks
    .filter((t) => t.assignee === agentId && t.status === 'doing' && typeof t.id === 'string')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  if (!doing.length) return null;
  const top = doing[0];
  const title = typeof top.title === 'string' && top.title.trim() ? top.title : (top.id as string);
  const nickname = cardNickname(top);
  return { id: top.id as string, title, nickname, more: doing.length - 1 };
}

export interface TileInfoInput {
  status: string;
  action?: string;
  /** Condensed name of the card the agent is doing, when it holds one. */
  cardName?: string;
  description?: string;
  project?: string;
}

/** The tile's one context line: the card while working, else the live action, else where the agent lives. */
export function tileInfoLine({ status, action, cardName, description, project }: TileInfoInput): string {
  if (status !== 'idle') {
    if (cardName) return cardName;
    if (action) return action;
  }
  return description?.trim() || project || '';
}
