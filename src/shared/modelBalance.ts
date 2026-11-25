/**
 * Which model entries an agent's settings rule out, and the Boss's `agent-config`
 * message that sets an agent's camp tier (shared/modelTiers.ts) or primary engine.
 * Pure, so the Edit Agent modal shows the same reasons main applies.
 */
import { buildSpawnCommand, providerPreset, type AgentProvider } from './agentProvider';
import {
  MODEL_RE,
  VALID_PROVIDER_NAMES,
  entryLabel,
  resolveProvider,
  validateModel,
  type AgentModelEntry
} from './modelEntry';
import { AGENT_TIERS, agentTierOf, isTier, resolveAgentWalk, type ModelTiers, type Tier } from './modelTiers';

export {
  cleanModelList,
  entryLabel,
  isMaxPercent,
  parseModelEntry,
  sameEntry,
  type AgentModelEntry
} from './modelEntry';

export const AGENT_CONFIG_ACT = 'agent-config' as const;
export type AgentConfigAct = typeof AGENT_CONFIG_ACT;

export function isAgentConfigAct(act: unknown): act is AgentConfigAct {
  return act === AGENT_CONFIG_ACT;
}

/** The registry settings that decide where an agent can safely run. */
export interface AgentPlacement {
  unity: boolean;
  network: boolean;
  extraDirs: number;
  /** The stored Codex sandbox level; undefined when never set. */
  codexSandbox?: 'sandboxed' | 'full';
  isGod: boolean;
  /** Set when the agent runs in the agent sandbox: the providers that sandbox can run. */
  jailProviders?: readonly string[];
}

/**
 * Why `e` would break this agent, or null when it is safe. Settings apply only where
 * the harness can carry them:
 *  - Codex keeps every setting (sandbox level, network, extra folders, Unity broker).
 *  - Claude has its own Bash sandbox with the same writable folders, so extra folders,
 *    Unity and the sandboxed level carry over. Claude Code is not network-sandboxed by
 *    default, so a network agent loses nothing there. The full level (display, licence
 *    servers) is a Codex flag with no Claude equivalent the harness sets, so it rules
 *    Claude out.
 *  - Every other CLI (agy included) runs with no sandbox, so it loses no access (network,
 *    Unity, folders); what it loses is containment. A stored sandbox level is the only
 *    setting that asks for containment, so only that rules it out.
 *  - The Boss also needs a CLI that can drain hive mail.
 */
export function entryExclusion(e: AgentModelEntry, p: AgentPlacement): string | null {
  const preset = providerPreset(e.provider);
  if (p.jailProviders && !p.jailProviders.includes(e.provider)) return `the agent sandbox cannot run ${preset.label} yet`;
  if (p.isGod && !preset.canReceiveInbox) return `${preset.label} cannot drain hive mail, which the Boss needs`;
  if (e.provider === 'custom') return 'a custom command has no model to balance';
  if (e.provider === 'codex') return null;
  if (e.provider === 'claude') {
    if (p.codexSandbox === 'full') return 'the full sandbox level (display, licence servers) is Codex-only';
    return null;
  }
  if (p.codexSandbox !== undefined) return `${preset.label} runs without a sandbox; this agent has a sandbox level set`;
  return null;
}

export interface AgentBalancerState {
  id: string;
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
  onRoster: boolean;
  provider: AgentProvider;
  model?: string;
  /** The agent's stored camp tier; absent reads as the tier holding its current engine. */
  tier?: Tier;
  placement: AgentPlacement;
}

export interface AgentConfigInput {
  body: unknown;
  sender?: string;
  isBoss: boolean;
  godId?: string | null;
  agents: Record<string, AgentBalancerState>;
  /** The camp tier lists, for the walk each patch reports. */
  tiers?: ModelTiers;
  spawnConfig?: { defaultCommand?: string; autoMode?: boolean };
  closingTime?: boolean;
}

export interface AgentBalancerPatch {
  id: string;
  isGod: boolean;
  provider: AgentProvider;
  model?: string;
  command?: string;
  engineChanged: boolean;
  /** The agent's new camp tier; absent keeps its own. */
  tier?: Tier;
  /** A pin to store; null clears it, absent keeps it. */
  pin?: AgentModelEntry | null;
  /** The agent's normal-card walk after this patch, for fleet.json `ladder`. */
  effectiveLadder: AgentModelEntry[];
}

export type AgentConfigPlan =
  | { ok: true; ids: string[]; changes: AgentBalancerPatch[]; patches: AgentBalancerPatch[] }
  | { ok: false; id?: string; reason: string };

const ALLOWED_CONFIG_FIELDS = new Set(['id', 'ids', 'tier', 'provider', 'model']);

export const LADDER_REFUSAL = 'per-agent ladders were replaced by camp model tiers; send "tier" (strong, medium or light)';

function parseBodyObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== 'string') return null;
  try {
    const v = JSON.parse(body) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validate and plan an `agent-config` message from the Boss. Pure; touches no disk. */
export function planAgentConfigMessage(m: AgentConfigInput): AgentConfigPlan {
  const b = parseBodyObject(m.body);
  if (!b) return { ok: false, reason: 'body must be a JSON object' };

  const rawSingleId = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : undefined;
  const godId = m.godId ?? Object.values(m.agents).find((a) => a.isGod)?.id ?? 'god';
  const resolveId = (id: string): string => (id === 'boss' ? godId : id);
  const hintId = rawSingleId ? resolveId(rawSingleId) : undefined;

  if (!m.isBoss) {
    return { ok: false, id: hintId, reason: 'only the Boss changes agent balancers; ask the Boss to send agent-config' };
  }

  if (b.ladder !== undefined || b.models !== undefined) return { ok: false, id: hintId, reason: LADDER_REFUSAL };

  const extra = Object.keys(b).filter((k) => !ALLOWED_CONFIG_FIELDS.has(k));
  if (extra.length) {
    return {
      ok: false,
      id: hintId,
      reason: `field${extra.length > 1 ? 's' : ''} not allowed: ${extra.join(', ')} (allowed: ${[...ALLOWED_CONFIG_FIELDS].join(', ')})`
    };
  }

  if (b.id !== undefined && b.ids !== undefined) {
    return { ok: false, id: hintId, reason: 'send either "id" or "ids", not both' };
  }

  const targetIds: string[] = [];
  if (b.id !== undefined) {
    if (!rawSingleId) return { ok: false, reason: '"id" must be a non-empty agent id' };
    targetIds.push(resolveId(rawSingleId));
  } else if (b.ids !== undefined) {
    if (!Array.isArray(b.ids) || b.ids.length === 0 || !b.ids.every((x) => typeof x === 'string' && x.trim().length > 0)) {
      return { ok: false, reason: '"ids" must be a non-empty list of agent ids' };
    }
    for (const raw of b.ids as string[]) {
      const resolved = resolveId(raw.trim());
      if (!targetIds.includes(resolved)) targetIds.push(resolved);
    }
  } else {
    return { ok: false, reason: 'body needs "id" (or "ids" for a bulk edit)' };
  }

  const firstId = targetIds[0];
  const hasTier = b.tier !== undefined;
  const hasProvider = b.provider !== undefined;
  const hasModel = b.model !== undefined;

  if (!hasTier && !hasProvider && !hasModel) {
    return { ok: false, id: firstId, reason: 'nothing to change (send "tier", "provider", or "model")' };
  }
  if (hasTier && (!isTier(b.tier) || b.tier === 'top')) {
    return { ok: false, id: firstId, reason: `tier must be one of ${AGENT_TIERS.join(', ')} (top is reached only by escalating a hard card)` };
  }
  const parsedTier = hasTier ? (b.tier as Tier) : undefined;

  let parsedProvider: AgentProvider | undefined;
  let parsedModel: string | undefined;
  if (hasProvider) {
    const p = resolveProvider(b.provider);
    if (!p) {
      return {
        ok: false,
        id: firstId,
        reason: `unknown provider "${String(b.provider)}" (expected one of ${VALID_PROVIDER_NAMES.join(', ')}, or "agy")`
      };
    }
    parsedProvider = p;
    if (hasModel) {
      const mv = validateModel(b.model, p);
      if (!mv.ok) return { ok: false, id: firstId, reason: mv.reason };
      parsedModel = mv.model;
    }
  } else if (hasModel) {
    if (b.model !== null && b.model !== '') {
      if (typeof b.model !== 'string' || !b.model.trim() || !MODEL_RE.test(b.model.trim())) {
        return {
          ok: false,
          id: firstId,
          reason: `invalid model "${String(b.model)}" (1-80 characters: letters, digits, spaces and . _ - ( ) [ ] / : @ + only)`
        };
      }
      parsedModel = b.model.trim();
    }
  }

  const changes: AgentBalancerPatch[] = [];
  for (const targetId of targetIds) {
    const agent = m.agents[targetId];
    if (!agent) return { ok: false, id: targetId, reason: `no agent ${targetId}` };
    if (agent.archived) return { ok: false, id: targetId, reason: `agent ${targetId} is archived` };
    if (agent.isAssistant) return { ok: false, id: targetId, reason: `${targetId} is the prep assistant and does not use a balancer` };
    if (!agent.isGod && !agent.onRoster) return { ok: false, id: targetId, reason: `agent ${targetId} is not on the persistent roster` };

    const nextProvider = hasProvider ? parsedProvider! : agent.provider;
    const nextModel = hasModel ? parsedModel : hasProvider && nextProvider !== agent.provider ? undefined : agent.model;

    if (nextModel !== undefined && nextProvider !== 'custom' && !providerPreset(nextProvider).supportsModel) {
      return { ok: false, id: targetId, reason: `${providerPreset(nextProvider).label} does not take a model` };
    }

    const primaryEntry: AgentModelEntry = { provider: nextProvider, ...(nextModel ? { model: nextModel } : {}) };
    if (hasProvider || hasModel) {
      const why = entryExclusion(primaryEntry, agent.placement);
      if (why) return { ok: false, id: targetId, reason: `${entryLabel(primaryEntry)} cannot run on ${targetId}: ${why}` };
    }

    const tiers = m.tiers;
    const agentTier = parsedTier ?? (tiers ? agentTierOf(agent.tier, tiers, primaryEntry) : agent.tier);
    const walk = tiers && agentTier
      ? resolveAgentWalk({ tiers, agentTier, nowMs: 0, exclusion: (e) => entryExclusion(e, agent.placement) }).walk.map((w) => w.entry)
      : [];
    const engineChanged = hasProvider || hasModel;
    const command = engineChanged
      ? buildSpawnCommand(
          { defaultCommand: m.spawnConfig?.defaultCommand || 'claude', autoMode: m.spawnConfig?.autoMode === true },
          nextModel,
          nextProvider
        )
      : undefined;

    changes.push({
      id: targetId,
      isGod: !!agent.isGod,
      provider: nextProvider,
      model: nextModel,
      ...(engineChanged ? { command } : {}),
      engineChanged,
      ...(parsedTier ? { tier: parsedTier } : {}),
      effectiveLadder: walk.length ? walk : [primaryEntry]
    });
  }

  return { ok: true, ids: targetIds, changes, patches: changes };
}
