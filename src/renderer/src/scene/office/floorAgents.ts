import type { Agent } from '@/store/store';

/** Live agents plus any closed to start a new card and being woken fresh (store.ts
 *  `rewaking`), drawn idle so the swap does not walk them out and back in. Every other
 *  dormant agent (not loaded this launch, a limit switch, a failed wake) is absent, and
 *  so is the Boss or prep assistant. A desktop window mirrors only `agents`. */
export function floorAgentsOf(
  s: { agents: Agent[]; restorableAgents: Agent[] },
  desktop = false
): Agent[] {
  if (desktop) return s.agents;
  const live = new Set(s.agents.map((a) => a.id));
  const rewaking = s.restorableAgents
    .filter((a) => a.rewaking && !a.isGod && !a.isAssistant && !live.has(a.id))
    .map((a) => ({ ...a, status: 'idle' as const, action: '', lastPrompt: undefined, ptyId: undefined }));
  return rewaking.length ? [...s.agents, ...rewaking] : s.agents;
}
