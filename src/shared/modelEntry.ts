/** One entry of a model list (a camp tier, a pin, a spawn's engine): which CLI and
 *  which model, with an optional usage cap. Pure helpers shared by modelBalance and
 *  modelTiers. */
import { AGENT_PROVIDER_PRESETS, isAgentProvider, providerPreset, type AgentProvider } from './agentProvider';

export interface AgentModelEntry {
  provider: AgentProvider;
  /** Undefined = the CLI's default model. */
  model?: string;
  /** Skip this entry once its meter reaches this percent (1-100), in place of the global cutoff. */
  maxPercent?: number;
}

/** A per-entry cap is a whole percent from 1 to 100. */
export function isMaxPercent(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
}

export function sameEntry(a: AgentModelEntry, b: AgentModelEntry): boolean {
  return a.provider === b.provider && (a.model ?? '') === (b.model ?? '');
}

export function entryLabel(e: AgentModelEntry): string {
  return `${e.provider}/${e.model ?? 'default'}`;
}

/** A stored list as known entries, without repeats; anything malformed is dropped. */
export function cleanModelList(raw: unknown): AgentModelEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentModelEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { provider, model, maxPercent } = r as { provider?: unknown; model?: unknown; maxPercent?: unknown };
    if (typeof provider !== 'string' || providerPreset(provider as AgentProvider).id !== provider) continue;
    const e: AgentModelEntry = { provider: provider as AgentProvider, ...(typeof model === 'string' && model ? { model } : {}), ...(isMaxPercent(maxPercent) ? { maxPercent } : {}) };
    if (!out.some((o) => sameEntry(o, e))) out.push(e);
  }
  return out;
}

/** Allowed characters in a model id/label (same shell-safe character set as hire.ts). */
export const MODEL_RE = /^[A-Za-z0-9 ._()[\]\/:@+-]{1,80}$/;

export const VALID_PROVIDER_NAMES = AGENT_PROVIDER_PRESETS.filter((p) => p.id !== 'custom').map((p) => p.id);

export function resolveProvider(raw: unknown): AgentProvider | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const normalized = trimmed === 'agy' ? 'antigravity' : trimmed;
  return isAgentProvider(normalized) ? normalized : null;
}

export function validateModel(raw: unknown, provider: AgentProvider): { ok: true; model?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, model: undefined };
  if (typeof raw !== 'string') return { ok: false, reason: 'model must be text or null for the CLI default' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, model: undefined };
  if (!MODEL_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `invalid model "${trimmed}" (1-80 characters: letters, digits, spaces and . _ - ( ) [ ] / : @ + only)`
    };
  }
  const preset = providerPreset(provider);
  if (provider !== 'custom' && !preset.supportsModel) {
    return { ok: false, reason: `${preset.label} does not take a model` };
  }
  return { ok: true, model: trimmed };
}

/** Parse and validate one balancer ladder entry (`{ provider, model? }` or `"<provider>/<model>"`). */
export function parseModelEntry(raw: unknown): { ok: true; entry: AgentModelEntry } | { ok: false; reason: string } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: 'ladder entry cannot be empty' };
    const slash = trimmed.indexOf('/');
    const provRaw = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
    const modelRaw = slash >= 0 ? trimmed.slice(slash + 1).trim() : undefined;
    const provider = resolveProvider(provRaw);
    if (!provider) {
      return { ok: false, reason: `unknown provider "${provRaw}" (expected one of ${VALID_PROVIDER_NAMES.join(', ')}, or "agy")` };
    }
    const modelVal = modelRaw === 'default' || modelRaw === '' ? undefined : modelRaw;
    const m = validateModel(modelVal, provider);
    if (!m.ok) return m;
    return { ok: true, entry: { provider, ...(m.model ? { model: m.model } : {}) } };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'each ladder entry must be {"provider": "...", "model"?: "..."} or "<provider>/<model>"' };
  }
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => k !== 'provider' && k !== 'model' && k !== 'maxPercent');
  if (extra.length) {
    return { ok: false, reason: `ladder entry field${extra.length > 1 ? 's' : ''} not allowed: ${extra.join(', ')} (allowed: provider, model, maxPercent)` };
  }
  const provider = resolveProvider(obj.provider);
  if (!provider) {
    return {
      ok: false,
      reason: `unknown provider "${String(obj.provider ?? '')}" (expected one of ${VALID_PROVIDER_NAMES.join(', ')}, or "agy")`
    };
  }
  const m = validateModel(obj.model, provider);
  if (!m.ok) return m;
  if (obj.maxPercent !== undefined && !isMaxPercent(obj.maxPercent)) {
    return { ok: false, reason: 'ladder entry maxPercent must be a whole number from 1 to 100' };
  }
  return { ok: true, entry: { provider, ...(m.model ? { model: m.model } : {}), ...(obj.maxPercent !== undefined ? { maxPercent: obj.maxPercent as number } : {}) } };
}
