/**
 * Tests-to-implementation checkpoint. A senior that wrote the failing tests and will
 * implement the same card declares `testsReady` with then:"implement" (taskPatch.ts).
 * The harness writes the agent's handoff and restarts it fresh on the card, on its
 * current model. Nothing asks the human: an engine switch happens only when its tier walk finds
 * the current engine out of quota. Pure over `CheckpointDeps`.
 */
import type { AgentModelEntry } from '../shared/modelBalance';
import type { SwitchResult } from './modelSwitch';

export interface TestsReady { branch: string; worktree: string; head: string; then: string }

export interface CheckpointAgentView {
  id: string;
  name: string;
  isGod: boolean;
  role?: string;
  current: AgentModelEntry;
  walk: AgentModelEntry[];
  live: boolean;
}

export interface CheckpointDeps {
  agent(id: string): CheckpointAgentView | null;
  card(id: string): { id: string; assignee?: string; testsCheckpoint?: unknown } | null;
  /** Write agents/<id>/handoff.md from the session that is ending. */
  writeHandoff(agentId: string, ready: TestsReady): Promise<void>;
  /** Mark the card's checkpoint done, record `note` on it and tell its assignee to implement. */
  settle(cardId: string, note: string): void;
  switcher: {
    freshRestart(agentId: string, reason: string): Promise<SwitchResult>;
  };
  ledger(event: Record<string, unknown>): void;
}

export function createTestsCheckpoint(deps: CheckpointDeps) {
  /** Whether a testsReady declaration from `agentId` on `cardId` starts the checkpoint. */
  function eligible(agentId: string, cardId: string, ready: TestsReady): CheckpointAgentView | null {
    if (ready.then !== 'implement') return null;
    const a = deps.agent(agentId);
    if (!a || a.isGod || !a.live || /unit test/i.test(a.role ?? '')) return null;
    const card = deps.card(cardId);
    if (!card || card.assignee !== agentId || card.testsCheckpoint !== undefined) return null;
    return a;
  }

  async function onSignal(agentId: string, cardId: string, ready: TestsReady): Promise<{ fired: boolean }> {
    const a = eligible(agentId, cardId, ready);
    if (!a) return { fired: false };
    try { await deps.writeHandoff(agentId, ready); } catch { /* a missing note must not stop the checkpoint */ }
    const note = `Checkpoint: failing tests committed; implementing on ${a.name}'s current model in a fresh session.`;
    deps.settle(cardId, note);
    await deps.switcher.freshRestart(agentId, 'checkpoint');
    deps.ledger({ kind: 'tests-checkpoint', phase: 'restarted', agentId, cardId, branch: ready.branch, head: ready.head });
    return { fired: true };
  }

  return { onSignal };
}

export type TestsCheckpoint = ReturnType<typeof createTestsCheckpoint>;
