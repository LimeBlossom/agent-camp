import { buildSpawnCommand, type AgentProvider, type HarnessConfig } from '@/store/config';
import { sameEntry, type AgentModelEntry } from '@shared/modelBalance';

export interface SpawnEngine {
  provider: AgentProvider;
  model?: string;
  command: string;
  /** Set when the balancer moved the agent: what it picked and why, for the card. */
  note?: string;
}

/**
 * The engine a FRESH start should use: main walks the agent's camp tiers (its stored tier,
 * the card's difficulty and kind, reservations, refusals) and picks. Call it only where the
 * spawn passes `resume: false`; a resumed session must stay on the CLI that recorded it.
 * A failed call, or a pick that needs a command when there is no config to build one,
 * returns `current` untouched, so the saved command (custom flags included) is reused.
 * A wait (every walked entry capped, spent or refused) throws with main's reason.
 */
export async function freshEngine(
  agentId: string,
  isGod: boolean,
  current: SpawnEngine,
  config: HarnessConfig | null | undefined
): Promise<SpawnEngine> {
  const res = await window.cth.chooseAgentModel({
    agentId, isGod, current: { provider: current.provider, model: current.model }
  }).catch(() => null);
  if (res?.quotaBlocked) throw new Error(res.reason);
  const entry = res?.entry;
  if (!entry || sameEntry(entry, current) || !config) return current;
  return {
    provider: entry.provider,
    model: entry.model,
    command: buildSpawnCommand(config, entry.model, entry.provider),
    note: `balanced to ${entry.provider}/${entry.model ?? 'default'}: ${res.reason}`
  };
}
