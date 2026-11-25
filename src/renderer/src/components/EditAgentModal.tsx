import { useEffect, useState, type CSSProperties } from 'react';
import { specialityText } from '@shared/modelCatalogCheck';
import { useTranslation } from 'react-i18next';
import { effortLevelsFor, isEffortLevel } from '@shared/effort';
import { CODEX_SANDBOX_LEVELS, DEFAULT_CODEX_SANDBOX, normalizeCodexSandbox } from '@shared/codexSandbox';
import { cleanExtraDirs } from '@shared/workspace';
import { agentMcpSupported } from '@shared/agentMcp';
import { entryExclusion, entryLabel, type AgentModelEntry } from '@shared/modelBalance';
import { AGENT_TIERS, TIER_LABEL, agentTierOf, parseModelTiers, resolveAgentWalk, type Tier } from '@shared/modelTiers';
import { tierEntryText } from './ModelTiersEditor';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { ProviderLogo } from './ProviderLogo';
import { useStore, type Agent } from '@/store/store';
import { useActiveCast } from '@/scene/office/activeCast';
import { type AccentColorName } from '@/design/tokens';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  decodeProviderModel,
  encodeProviderModel,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { useLiveModelCatalog } from '@/hooks/useLiveModelCatalog';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

export interface EditAgentModalProps {
  agent: Agent;
  onClose: () => void;
}

/**
 * Compact post-hire editor for Identity / Engine / Briefing. Mirrors the Add
 * Agent fields that matter after spawn; save only patches the durable roster
 * via updateAgent (engine changes apply on the next restart). For a dormant
 * agent that is its restorable entry, which the next wake or Start spawns from.
 */
export function EditAgentModal({ agent, onClose }: EditAgentModalProps) {
  useLiveModelCatalog();
  const updateAgent = useStore((s) => s.updateAgent);
  // A dormant agent has no session to restart, so the restart-now pointers below do not apply.
  const dormant = useStore((s) => !s.agents.some((a) => a.id === agent.id) && s.restorableAgents.some((a) => a.id === agent.id));
  const { t } = useTranslation();
  const [config, setConfig] = useState<HarnessConfig | null>(null);

  const [name, setName] = useState(agent.name);
  const cast = useActiveCast();
  const [character, setCharacter] = useState<string>(agent.character);
  const [accent, setAccent] = useState<AccentColorName>(agent.accent);
  const [provider, setProvider] = useState<AgentProvider>(
    inferAgentProvider(agent.command, agent.provider)
  );
  const [model, setModel] = useState<string | undefined>(agent.model);
  const [description, setDescription] = useState(agent.description);
  const [goal, setGoal] = useState(agent.goal ?? '');
  const [keepRunning, setKeepRunning] = useState(agent.keepRunning === true);
  // Effort is stored independently per provider; '' uses that CLI's configured default.
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const effort = efforts[provider] ?? '';
  const effortLevels = effortLevelsFor(provider, model);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(['claude', 'codex'].map(async (p) => [p, (await window.cth.getAgentEfforts(p as 'claude' | 'codex'))[agent.id] ?? '']))
      .then((entries) => { if (!cancelled) setEfforts(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setEfforts({}); });
    return () => { cancelled = true; };
  }, [agent.id]);
  // Codex sandbox level lives on the hive registry entry (see shared/codexSandbox.ts).
  const [sandbox, setSandbox] = useState<string>(DEFAULT_CODEX_SANDBOX);
  const [sandboxStored, setSandboxStored] = useState(false);
  useEffect(() => {
    void window.cth.getCodexSandbox(agent.id)
      .then((sb) => { setSandbox(normalizeCodexSandbox(sb?.level)); setSandboxStored(sb?.stored === true); })
      .catch(() => { setSandbox(DEFAULT_CODEX_SANDBOX); setSandboxStored(false); });
  }, [agent.id]);
  // The camp tier a fresh start walks from; undefined = the tier holding the engine above.
  // The Boss's tier and pin live in config (its boot reads config, not the roster).
  const [tier, setTier] = useState<Tier | undefined>(agent.isGod ? undefined : agent.tier);
  // Workspace: the folder comes from the roster (it is what a restart spawns into); the
  // extra folders and the Unity flag live on the hive registry entry.
  const [cwd, setCwd] = useState(agent.cwd);
  const [extraDirs, setExtraDirs] = useState('');
  const [unity, setUnity] = useState(false);
  const [network, setNetwork] = useState(false);
  const [blender, setBlender] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setCwd(agent.cwd);
    void window.cth.getWorkspace(agent.id).then((ws) => {
      setExtraDirs(ws ? ws.extraDirs.join('\n') : '');
      setUnity(ws?.unity === true);
      setNetwork(ws?.network === true);
      setBlender(ws?.mcp?.blender === true);
    }).catch(() => { setExtraDirs(''); setUnity(false); setNetwork(false); setBlender(false); });
  }, [agent.id]);

  const pickFolder = async (apply: (path: string) => void) => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) apply(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  useEffect(() => {
    void window.cth.getConfig().then((c) => {
      setConfig(c);
      if (agent.isGod) setTier(c.godTier);
    }).catch(() => setConfig(null));
    const off = window.cth.onConfigChanged?.((c) => {
      setConfig(c);
      if (agent.isGod) {
        setTier(c.godTier);
        if (c.godProvider) setProvider(c.godProvider);
        setModel(c.godModel);
      }
    });
    return () => { off?.(); };
  }, [agent.isGod]);

  // Keep form in sync when the selected agent changes while the modal is open.
  useEffect(() => {
    setName(agent.name);
    setCharacter(agent.character);
    setAccent(agent.accent);
    setProvider(inferAgentProvider(agent.command, agent.provider));
    setModel(agent.model);
    setDescription(agent.description);
    setGoal(agent.goal ?? '');
    setKeepRunning(agent.keepRunning === true);
    if (!agent.isGod) setTier(agent.tier);
  }, [agent.id]);

  // Reflect live Boss `agent-config` updates if the modal is already open on this worker.
  useEffect(() => {
    if (agent.isGod) return;
    setTier(agent.tier);
    setProvider(inferAgentProvider(agent.command, agent.provider));
    setModel(agent.model);
  }, [agent.isGod, agent.tier, agent.provider, agent.model, agent.command]);

  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    if (!config) {
      setModel(undefined);
      return;
    }
    const nextModel = isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id];
    setModel(nextModel);
  };

  const preset = providerPreset(provider);

  // What the balancer would rule out, from the form as it stands (unsaved toggles count).
  const placement = {
    unity,
    network,
    extraDirs: cleanExtraDirs(extraDirs).length,
    codexSandbox: config?.agentSandbox === true && (provider === 'codex' || sandboxStored) ? normalizeCodexSandbox(sandbox) : undefined,
    isGod: !!agent.isGod
  };
  const campTiers = parseModelTiers(config?.modelTiers);
  const shownTier = agentTierOf(tier, campTiers, { provider, model });
  const walk = resolveAgentWalk({ tiers: campTiers, agentTier: shownTier, nowMs: 0, exclusion: (e) => entryExclusion(e, placement) });
  const pin: AgentModelEntry | undefined = agent.isGod ? config?.godPin : agent.pin;
  const save = async () => {
    if (saving) return;
    setError(undefined);
    const nextCwd = cwd.trim();
    const cwdChanged = nextCwd !== agent.cwd;
    setSaving(true);
    const ws = await window.cth.setWorkspace(agent.id, {
      ...(cwdChanged ? { cwd: nextCwd } : {}),
      extraDirs: cleanExtraDirs(extraDirs),
      unity,
      ...(provider === 'codex' ? { network } : {}),
      ...(agentMcpSupported(provider) ? { mcp: { blender } } : {})
    }).catch((e: unknown) => ({ ok: false as const, error: String(e), cwd: undefined }));
    if (!ws.ok) { setSaving(false); setError(ws.error ?? 'Could not save the workspace'); return; }
    if (provider === 'claude' || provider === 'codex') {
      const ok = await window.cth.setAgentEffort(agent.id,
        isEffortLevel(effort) && effortLevels.includes(effort) ? effort : null, provider).catch(() => false);
      if (!ok) { setSaving(false); setError('Could not save reasoning effort'); return; }
    }
    const trimmedName = name.trim() || agent.name;
    const trimmedDescription = description.trim() || 'a fresh harness';
    const trimmedGoal = goal.trim();
    const command = config
      ? buildSpawnCommand(config, model, provider)
      : agent.command;
    if (agent.isGod && tier) void window.cth.updateConfig({ godTier: tier });

    updateAgent(agent.id, {
      name: trimmedName,
      character,
      accent,
      provider,
      model,
      command,
      description: trimmedDescription,
      goal: trimmedGoal || undefined,
      ...(agent.isGod ? {} : { tier, keepRunning: keepRunning || undefined }),
      // A worktree belongs to the old folder's repo; restart would prefer it over cwd.
      ...(cwdChanged ? { cwd: ws.cwd ?? nextCwd, worktreePath: undefined } : {})
    });
    if (provider === 'codex') void window.cth.setCodexSandbox(agent.id, normalizeCodexSandbox(sandbox));
    setSaving(false);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 500
      }}
    >
      {/* Same box as Add Agent (940 / 95vw / 86vh). They are the two halves of
          one job — describe an agent — and a tall narrow dialog next to a wide
          one reads as two unrelated screens. */}
      <div onClick={(e) => e.stopPropagation()} style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel variant="dialog" title="EDIT AGENT" style={{ padding: 16 }} noPadding>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 14,
            padding: 16, maxHeight: '86vh', overflowY: 'auto'
          }}>
            {/* Two columns so the extra width is used rather than padded.
                Identity and Engine are short field lists; Briefing is free
                text and takes the taller side. minHeight keeps the dialog from
                collapsing into a wide thin strip on a small form. */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 16, alignItems: 'start', minHeight: 260, flexShrink: 0
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <Section label="Identity" hint="name · character · color">
              <Row label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Stanley"
                  style={inputStyle}
                  autoFocus
                />
              </Row>

              <Row label="Character">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {cast.members.map((c) => {
                    const active = character === c.name;
                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                        title={c.blurb}
                        style={{
                          padding: 4,
                          background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                          boxShadow: active
                            ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                            : 'inset 0 0 0 1px var(--cth-ink-100)',
                          cursor: 'pointer', border: 'none', width: 52,
                          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
                        }}
                      >
                        <div style={{
                          width: 40, height: 48,
                          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                          overflow: 'hidden'
                        }}>
                          <SpritePortrait character={c.name} scale={1.5} />
                        </div>
                        <span style={{ fontSize: 10, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                      </button>
                    );
                  })}
                </div>
              </Row>

              <Row label="Color">
                <div style={{ display: 'flex', gap: 6 }}>
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAccent(a)}
                      title={a}
                      style={{
                        width: 28, height: 28,
                        background: `var(--cth-${a})`,
                        boxShadow: accent === a
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-300)',
                        cursor: 'pointer', border: 'none'
                      }}
                    />
                  ))}
                </div>
              </Row>

              {!agent.isGod && !agent.isAssistant && (
                <Row label={t('editAgent.keepRunning')}>
                  <button
                    type="button"
                    onClick={() => setKeepRunning((k) => !k)}
                    title={t('editAgent.keepRunningTitle')}
                    style={{ ...chipStyle(keepRunning, accent), alignSelf: 'flex-start' }}
                  >
                    {keepRunning ? t('editAgent.keepRunningOn') : t('editAgent.keepRunningOff')}
                  </button>
                </Row>
              )}
            </Section>

            <Section label="Engine" hint="provider · model · next restart">
              <Row label="Provider">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {AGENT_PROVIDER_PRESETS.map((p) => {
                    const active = provider === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pickProvider(p.id)}
                        title={p.label}
                        style={{
                          padding: '3px 8px 1px',
                          background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                          boxShadow: active
                            ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                            : 'inset 0 0 0 1px var(--cth-ink-100)',
                          fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                          color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                          display: 'inline-flex', alignItems: 'center', gap: 6
                        }}
                      >
                        <ProviderLogo provider={p.id} size={14} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </Row>

              {preset.supportsModel && (
                <Row label="Model">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(() => {
                      const known = modelsForProvider(provider);
                      return model && !known.some((m) => m.id === model)
                        ? [...known, { id: model, label: `${model} (current)` }]
                        : known;
                    })().map((m) => {
                      const active = (model ?? '') === (m.id ?? '');
                      return (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => setModel(m.id)}
                          title={m.id ? [m.id, specialityText(provider, m.id)].filter(Boolean).join('\n') : 'CLI default model'}
                          style={{
                            padding: '3px 8px 1px',
                            background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                            boxShadow: active
                              ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                              : 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                            color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </Row>
              )}

              {(provider === 'claude' || provider === 'codex') && (
                <Row label="Effort">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(['', ...effortLevels] as string[]).map((e) => {
                      const active = effort === e;
                      return (
                        <button
                          key={e || 'default'}
                          type="button"
                          onClick={() => setEfforts((m) => ({ ...m, [provider]: e }))}
                          title={e ? `Reasoning effort: ${e}` : 'Use this provider’s configured default effort'}
                          style={{
                            padding: '3px 8px 1px',
                            background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                            boxShadow: active
                              ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                              : 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                            color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                          }}
                        >
                          {e || 'default'}
                        </button>
                      );
                    })}
                  </div>
                </Row>
              )}

              {provider === 'codex' && (
                <Row label="Sandbox">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {CODEX_SANDBOX_LEVELS.map((lv) => {
                      const active = sandbox === lv;
                      const tip = lv === 'sandboxed'
                        ? 'workspace-write: writes to its folder, its extra folders, its agent folder and the hive root'
                        : 'danger-full-access: no OS sandbox (reaches the display and licence servers)';
                      return (
                        <button
                          key={lv}
                          type="button"
                          onClick={() => setSandbox(lv)}
                          title={tip}
                          style={chipStyle(active, accent)}
                        >
                          {lv}
                        </button>
                      );
                    })}
                  </div>
                </Row>
              )}

              {provider === 'codex' && (
                <Row label="Network">
                  <button
                    type="button"
                    onClick={() => setNetwork((n) => !n)}
                    title={sandbox === 'full'
                      ? 'The full level has no sandbox, so the network is already open'
                      : 'Let the sandboxed agent reach the internet (sandbox_workspace_write.network_access)'}
                    style={{ ...chipStyle(network, accent), alignSelf: 'flex-start' }}
                  >
                    {network ? 'on: may reach the internet' : 'off'}
                  </button>
                </Row>
              )}

              <Row label="Model tier" plain>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="agent-tier">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {AGENT_TIERS.map((t) => (
                      <button key={t} type="button" onClick={() => setTier(t)} style={chipStyle(shownTier === t, accent)}>
                        {TIER_LABEL[t]}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', lineHeight: '15px' }}>
                    {tier ? 'A normal card walks:' : 'Following the engine above. A normal card walks:'}
                  </span>
                  {walk.tiers.map((t) => {
                    const skipped = campTiers[t].map((e) => entryExclusion(e, placement));
                    const reasons = [...new Set(skipped.filter((r): r is string => !!r))];
                    return (
                      <div key={t} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{TIER_LABEL[t]}</span>
                        {campTiers[t].length === 0 && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', paddingLeft: 20 }}>empty</span>}
                        {campTiers[t].map((e, i) => (
                          <div key={`${e.provider}:${e.model ?? ''}`} title={skipped[i] ? `skipped: ${skipped[i]}` : undefined} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <ProviderLogo provider={e.provider} size={14} />
                            <span style={{ fontSize: 12, color: skipped[i] ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)', flex: 1, minWidth: 0, overflowWrap: 'anywhere', textDecoration: skipped[i] ? 'line-through' : 'none' }}>
                              {tierEntryText(e)}{e.maxPercent !== undefined ? ` (cap ${e.maxPercent}%)` : ''}
                            </span>
                            {!skipped[i] && (
                              <button type="button" onClick={() => void window.cth.pinAgentModel(agent.id, { provider: e.provider, ...(e.model ? { model: e.model } : {}) })} title={`Pin ${entryLabel(e)}: switch to it and keep it while it has room`} style={chipStyle(false, accent)}>pin</button>
                            )}
                          </div>
                        ))}
                        {reasons.map((r) => (
                          <span key={r} style={{ fontSize: 11, color: 'var(--cth-coral)', paddingLeft: 20 }}>
                            {skipped.filter((x) => x === r).length} skipped: {r}
                          </span>
                        ))}
                      </div>
                    );
                  })}
                  {walk.widened && <span style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{walk.widened}</span>}
                  {pin && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--cth-ink-900)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                        Pin: {tierEntryText(pin)}
                        {entryExclusion(pin, placement) && <span style={{ color: 'var(--cth-coral)' }}> (not used: {entryExclusion(pin, placement)})</span>}
                      </span>
                      <button type="button" onClick={() => void window.cth.clearAgentPin(agent.id)} title={`Clear the pin on ${entryLabel(pin)}`} style={chipStyle(false, accent)}>clear pin</button>
                    </div>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', lineHeight: '15px' }}>
                    A hard card starts on Strong, an easy one on Light. Inside a tier a fresh start balances by headroom and moves down only when no entry has room. Resumes keep their engine.{' '}
                    <a
                      href="#"
                      onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Agents & Models' } })); }}
                      style={{ color: 'var(--cth-ink-900)', textDecoration: 'underline' }}
                    >Edit the tier lists</a>
                  </span>
                </div>
              </Row>

              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                {dormant
                  ? t('editAgent.dormantSaved', { name: agent.name })
                  : 'Engine changes are saved for the next restart. Use Command Center → Floor to restart a live session onto a new provider/model/effort now.'}
              </span>
            </Section>

            <Section label="Workspace" hint="folder · extra folders · unity · next restart">
              <Row label="Folder">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="/absolute/path/to/project"
                    style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                  />
                  <PixelButton variant="secondary" size="md" onClick={() => void pickFolder(setCwd)}>pick</PixelButton>
                </div>
              </Row>

              <Row label="Extra folders">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <textarea
                    value={extraDirs}
                    onChange={(e) => setExtraDirs(e.target.value)}
                    placeholder={'Also writable by its sandbox, one absolute path per line'}
                    rows={3}
                    style={{
                      fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 12,
                      padding: 6, border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)', resize: 'vertical'
                    }}
                  />
                  <div>
                    <PixelButton
                      variant="secondary"
                      size="sm"
                      onClick={() => void pickFolder((p) => setExtraDirs((cur) => cleanExtraDirs(`${cur}\n${p}`).join('\n')))}
                    >
                      add folder
                    </PixelButton>
                  </div>
                </div>
              </Row>

              <Row label="Unity">
                <button
                  type="button"
                  onClick={() => setUnity((u) => !u)}
                  title="Let this agent ask the harness to run Unity in batch mode (GPU, no window) on projects inside its folders"
                  style={{ ...chipStyle(unity, accent), alignSelf: 'flex-start' }}
                >
                  {unity ? 'on: may request batch Unity runs' : 'off'}
                </button>
              </Row>

              <Row label={t('editAgent.blenderMcp')}>
                <button
                  type="button"
                  disabled={!agentMcpSupported(provider)}
                  onClick={() => setBlender((b) => !b)}
                  title={agentMcpSupported(provider)
                    ? t('editAgent.blenderMcpTitle')
                    : provider === 'antigravity' ? t('editAgent.blenderMcpAgy') : t('editAgent.blenderMcpUnsupported')}
                  style={{
                    ...chipStyle(blender && agentMcpSupported(provider), accent),
                    alignSelf: 'flex-start',
                    ...(agentMcpSupported(provider) ? {} : { opacity: 0.5, cursor: 'not-allowed' })
                  }}
                >
                  {!agentMcpSupported(provider)
                    ? (provider === 'antigravity' ? t('editAgent.blenderMcpAgy') : t('editAgent.blenderMcpUnsupported'))
                    : blender ? t('editAgent.blenderMcpOn') : t('editAgent.blenderMcpOff')}
                </button>
              </Row>

              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                {dormant
                  ? t('editAgent.dormantSaved', { name: agent.name })
                  : 'Workspace changes are saved for the next restart. Use Command Center → Floor to restart a live session into the new folder now.'}
              </span>
            </Section>

              </div>
              <div style={{ minWidth: 0 }}>
            <Section label="Briefing" hint="description · goal">
              <Row label="Description">
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="what is this agent for"
                  style={inputStyle}
                />
              </Row>

              <Row label="Goal (optional)">
                <textarea
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="long-running directive injected on every prompt"
                  rows={4}
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'vertical', minHeight: 200 }}
                />
              </Row>
            </Section>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 4 }}>
              <PixelButton variant="ghost" size="md" onClick={onClose}>cancel</PixelButton>
              <div style={{ flex: 1 }} />
              {error && <span style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{error}</span>}
              <PixelButton variant="primary" size="md" onClick={() => void save()}>{saving ? 'saving…' : 'save changes'}</PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function chipStyle(active: boolean, accent: AccentColorName): CSSProperties {
  return {
    padding: '3px 8px 1px',
    background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
    boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
  };
}

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};

function Section({
  label,
  hint,
  children
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-900)',
          textTransform: 'uppercase'
        }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{hint}</span>
      </div>
      {children}
    </div>
  );
}

/** `plain` renders a div: a <label> forwards clicks on its text to its first control,
 *  which in a list of buttons means "move up". */
function Row({ label, children, plain }: { label: string; children: React.ReactNode; plain?: boolean }) {
  const Tag = plain ? 'div' : 'label';
  return (
    <Tag style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </Tag>
  );
}
