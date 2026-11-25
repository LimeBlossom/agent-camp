import { useEffect, useState, type CSSProperties } from 'react';
import { modelCatalogWarnings, specialityText } from '@shared/modelCatalogCheck';
import { sameEntry, type AgentModelEntry } from '@shared/modelBalance';
import { TIERS, TIER_LABEL, defaultTierFor, parseModelTiers, validateModelTiers, type ModelTiers, type Tier } from '@shared/modelTiers';
import {
  AGENT_PROVIDER_PRESETS,
  decodeProviderModel,
  encodeProviderModel,
  modelsForProvider,
  providerPreset,
  type HarnessConfig
} from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';

const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const chip: CSSProperties = {
  padding: '3px 6px 1px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none', flexShrink: 0
};

/** "Provider · catalog label", the same wording the Edit Agent modal uses. */
export function tierEntryText(e: AgentModelEntry): string {
  const m = modelsForProvider(e.provider).find((x) => (x.id ?? '') === (e.model ?? ''));
  return `${providerPreset(e.provider).label} · ${m?.label ?? e.model ?? 'CLI default'}`;
}

/** Why a tier entry is retired or missing from the model catalog, or undefined. */
function offCatalog(e: AgentModelEntry): string | undefined {
  return e.model ? modelCatalogWarnings({ modelTiers: { entry: [e] } })[0] : undefined;
}

/** Settings > Agents & Models: the camp-wide strong, medium and light model lists every
 *  agent's tier walks (shared/modelTiers.ts). Each change saves at once. */
export function ModelTiersEditor({ config }: { config: HarnessConfig }) {
  const [tiers, setTiers] = useState<ModelTiers>(() => parseModelTiers(config.modelTiers));
  const [addPick, setAddPick] = useState('');
  const [error, setError] = useState<string | undefined>();
  useEffect(() => { setTiers(parseModelTiers(config.modelTiers)); }, [config.modelTiers]);

  const save = (next: ModelTiers) => {
    const v = validateModelTiers(next);
    if (!v.ok) { setError(v.reason); return; }
    setError(undefined);
    setTiers(v.tiers);
    void window.cth.updateConfig({ modelTiers: v.tiers });
  };
  const edit = (t: Tier, fn: (list: AgentModelEntry[]) => AgentModelEntry[]) => save({ ...tiers, [t]: fn([...tiers[t]]) });
  const move = (t: Tier, i: number, d: -1 | 1) => edit(t, (l) => {
    const j = i + d;
    if (j >= 0 && j < l.length) [l[i], l[j]] = [l[j], l[i]];
    return l;
  });
  const toTier = (from: Tier, i: number, to: Tier) => {
    if (from === to) return;
    const e = tiers[from][i];
    save({ ...tiers, [from]: tiers[from].filter((_, k) => k !== i), [to]: [...tiers[to], e] });
  };
  const setCap = (t: Tier, i: number, raw: string) => edit(t, (l) => {
    const n = Number(raw.trim());
    const { maxPercent: _old, ...rest } = l[i];
    l[i] = raw.trim() && Number.isInteger(n) ? { ...rest, maxPercent: n } : rest;
    return l;
  });

  const placed = TIERS.flatMap((t) => tiers[t]);
  const choices = AGENT_PROVIDER_PRESETS
    .filter((p) => p.id !== 'custom')
    .flatMap((p) => (p.supportsModel ? modelsForProvider(p.id) : [{ id: undefined, label: 'CLI default' }])
      .map((m) => ({ entry: { provider: p.id, ...(m.id ? { model: m.id } : {}) } as AgentModelEntry, label: `${p.label} · ${m.label}`, title: m.id ? specialityText(p.id, m.id) : undefined })))
    .filter((c) => !placed.some((e) => sameEntry(e, c.entry)));
  const add = () => {
    const e = decodeProviderModel(addPick);
    if (!e) return;
    setAddPick('');
    const t = defaultTierFor(e.model);
    save({ ...tiers, [t]: [...tiers[t], e] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="model-tiers-editor">
      <div style={headStyle}>Model tiers</div>
      {TIERS.map((t) => (
        <div key={t} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ ...headStyle, color: 'var(--cth-ink-700)' }}>{TIER_LABEL[t]} ({tiers[t].length})</div>
          {tiers[t].length === 0 && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>empty</span>}
          {tiers[t].map((e, i) => (
            <div key={`${e.provider}:${e.model ?? ''}`} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <ProviderLogo provider={e.provider} size={14} />
              <span
                title={specialityText(e.provider, e.model)}
                style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}
              >
                {i + 1}. {tierEntryText(e)}
              </span>
              {offCatalog(e) && (
                <span style={{ fontSize: 11, color: 'var(--cth-coral)', flexShrink: 0 }} title={offCatalog(e)}>not in catalog</span>
              )}
              <label style={{ fontSize: 11, color: 'var(--cth-ink-500)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                cap
                <input
                  key={`${e.provider}:${e.model ?? ''}:${e.maxPercent ?? ''}`}
                  defaultValue={e.maxPercent ?? ''}
                  inputMode="numeric"
                  title="Skip this model once its meter reaches this percent (1-100); blank uses the camp cutoff"
                  onBlur={(ev) => { if (ev.target.value.trim() !== String(e.maxPercent ?? '')) setCap(t, i, ev.target.value); }}
                  style={{ width: 34, fontSize: 12, padding: '2px 3px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}
                />%
              </label>
              <button type="button" onClick={() => move(t, i, -1)} title="Prefer this one more" style={chip}>up</button>
              <button type="button" onClick={() => move(t, i, 1)} title="Prefer this one less" style={chip}>down</button>
              <select
                value={t}
                onChange={(ev) => toTier(t, i, ev.target.value as Tier)}
                title="Move to another tier"
                style={{ ...chip, padding: '2px 2px' }}
              >
                {TIERS.map((x) => <option key={x} value={x}>{TIER_LABEL[x]}</option>)}
              </select>
              <button type="button" onClick={() => edit(t, (l) => l.filter((_, k) => k !== i))} title="Remove from the tiers" style={chip}>remove</button>
            </div>
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={addPick}
          onChange={(e) => setAddPick(e.target.value)}
          style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 4px', background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}
        >
          <option value="">add a provider and model…</option>
          {choices.map((c) => <option key={encodeProviderModel(c.entry.provider, c.entry.model)} value={encodeProviderModel(c.entry.provider, c.entry.model)} title={c.title}>{c.label}</option>)}
        </select>
        <PixelButton variant="secondary" size="sm" onClick={add}>add</PixelButton>
      </div>
      {error && <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{error}</span>}
    </div>
  );
}
