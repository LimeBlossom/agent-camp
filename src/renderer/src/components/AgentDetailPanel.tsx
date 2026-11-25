import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { CommandCenterPanel } from './CommandCenterPanel';
import { disposeTerminal } from './terminalPool';
import { SidebarTabs } from './SidebarTabs';
import { ThreadsPanel } from './ThreadsPanel';
import { ToolWaterfall } from './ToolWaterfall';
import { AgentControlStrip } from './AgentControlStrip';
import { EditAgentModal } from './EditAgentModal';
import { GitTab } from './GitTab';
import { Icon } from './Icon';
import { AgentNameEditor } from './AgentNameEditor';
import { useStore, type Agent } from '@/store/store';
import { inferAgentProvider, providerPreset, type HarnessConfig } from '@/store/config';
import { agentModelLabel } from '@shared/modelLabel';
import { currentCard, type CurrentCard } from './agentCurrentCard';
import { usePtyParser } from '@/hooks/usePtyParser';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useRetireAgent } from '@/hooks/useRetireAgent';
import { useRtl } from '@/i18n/useDirection';

export interface AgentDetailPanelProps {
  agent: Agent;
}

export function AgentDetailPanel({ agent }: AgentDetailPanelProps) {
  const { t } = useTranslation();
  const [openTerminalState, setOpenTerminalState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');
  const [openTerminalError, setOpenTerminalError] = useState<string | undefined>();
  const [editOpen, setEditOpen] = useState(false);

  /**
   * THE HEADER STRIP HAS TO GIVE SOMETHING UP WHEN THE SIDEBAR IS DRAGGED IN.
   *
   * Four buttons with icon+label need about 246px on their own, and the
   * portrait and gaps take another 72. The sidebar can be dragged down to
   * 320px total (SidebarSplitter's `min`), so past a point there is simply
   * not enough room for the labels AND the agent's name.
   *
   * Something has to yield, and the name is the one thing in this row that
   * cannot: it is how you know WHICH agent you are looking at. So below the
   * threshold the buttons drop their words and keep their icons — the tooltip
   * and aria-label on each already carry the full explanation, so nothing is
   * actually lost, and the ~110px that frees goes back to the name.
   *
   * Measured on the strip itself rather than on `sidebarWidth`, because the
   * strip's width is set by its container and NOT by what is inside it. That
   * is what makes a single threshold safe here: swapping labels for icons
   * cannot change the number being compared, so the row cannot oscillate.
   *
   * WHERE 440 COMES FROM. Everything that is not the name costs ~318px: the
   * four buttons measure ~246 at Inter 13px, the portrait 32, and the five
   * 8px gaps another 40. The name is set in Press Start 2P, which is a
   * fixed-advance pixel font — at fontSize 10 that is a flat 10px per
   * character, plus 17 for the rename pencil beside it. Ten readable
   * characters therefore need 117, and 318 + 117 rounds to 440.
   *
   * That threshold deliberately puts the DEFAULT 420px sidebar in compact
   * mode. It has to: at 420 the labelled row leaves the name about 67px,
   * which is six pixel-font characters — the "DWIGHT S." truncation this was
   * reported as. Icons at the default width is the fix, not a side effect.
   *
   * Recompute the number if a fifth button lands in this row or a label grows.
   */
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [compactHeader, setCompactHeader] = useState(false);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompactHeader(w < 440);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);
  const renameAgent = useStore(s => s.renameAgent);
  const setFullscreen = useStore(s => s.setFullscreen);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const sidebarTab = useStore(s => s.sidebarTab);
  const setSidebarTab = useStore(s => s.setSidebarTab);
  const isReal = !!agent.ptyId;
  // While this agent is shown in the fullscreen overlay, the fullscreen view
  // owns the pty (it sizes it to fill the screen). Keeping the embedded terminal
  // mounted too means two xterms fight over the pty's cols/rows — which corrupts
  // the display and breaks scrolling. So we unmount the embedded one here; it
  // re-mounts and re-fits when fullscreen closes.
  const isFullscreenedHere = fullscreenAgentId === agent.id;

  const onPtyStream = usePtyParser(agent.id);

  // Michael gets the full command-center dashboard instead of the plain panel.
  if (agent.isGod) return <CommandCenterPanel agent={agent} />;

  const openTerminal = async () => {
    setOpenTerminalState('opening');
    setOpenTerminalError(undefined);
    try {
      const result = await window.cth.openTerminalAt(agent.cwd);
      if (result.ok) {
        setOpenTerminalState('ok');
        setTimeout(() => setOpenTerminalState('idle'), 1500);
      } else {
        setOpenTerminalState('error');
        setOpenTerminalError(result.error ?? 'unknown error');
        setTimeout(() => setOpenTerminalState('idle'), 4000);
      }
    } catch (e) {
      setOpenTerminalState('error');
      setOpenTerminalError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setOpenTerminalState('idle'), 4000);
    }
  };

  const modelLabel = agentModelLabel(inferAgentProvider(agent.command, agent.provider), agent.liveModel ?? agent.model);

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(t('agentDetail.killConfirm', { name: agent.name }))) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  return (
    <PixelPanel
      variant="default"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 0,
        overflow: 'hidden'
      }}
      noPadding
    >
      {/* Thin header strip */}
      <div ref={headerRef} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)',
        flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
          flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', minWidth: 0, lineHeight: '14px' }}>
            <AgentNameEditor
              name={agent.name}
              onCommit={(name) => renameAgent(agent.id, name)}
              uppercase
              fontSize={10}
            />
          </div>
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 1,
            minWidth: 0, overflow: 'hidden'
          }}>
            <PixelBadge status={agent.status} />
            {isReal && (
              <span
                title={modelLabel}
                style={{
                  flex: '0 1 auto', minWidth: 0, fontSize: 12, color: 'var(--cth-ink-700)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}
              >{modelLabel}</span>
            )}
            <span style={{
              flex: '0 100 auto', minWidth: 0,
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{agent.project}</span>
          </div>
        </div>
        <PixelButton variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={`Edit ${agent.name}: their name and face, which engine they run on, and the briefing that tells them what they are for.`}
            aria-label="Edit this agent"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="edit" />{!compactHeader && ' edit'}
          </span>
        </PixelButton>
        {/* v0.3.4: the IDE lives at agent level (replaces the old files tab) —
            opens the full-window Monaco editor rooted at this agent's workspace. */}
        <PixelButton variant="secondary" size="sm" onClick={() => useStore.getState().setIdeOpen(true, agent.id)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.ideTip', { project: agent.project })}
            aria-label={t('agentDetail.openIde')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="code" />{!compactHeader && t('agentDetail.ide')}
          </span>
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openTerminalState === 'opening'}>
          {/* "open" said nothing about WHAT opens, sitting in a row where IDE
              and Talk both also open something. The label names the thing you
              get; the tip names the folder you get it in. */}
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.terminalTip', { cwd: agent.cwd })}
            aria-label={t('agentDetail.openTerminalAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="terminal" />
            {/* The transient states survive compact mode: they are feedback on
                a click you just made, and they are two characters wide. Only
                the resting word "terminal" is worth its space. */}
            {openTerminalState === 'opening' ? t('agentDetail.opening')
              : openTerminalState === 'ok' ? t('agentDetail.ok')
              : openTerminalState === 'error' ? t('agentDetail.err')
              : compactHeader ? '' : t('agentDetail.open')}
          </span>
        </PixelButton>
        {isReal && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <Icon name="x" />
          </PixelButton>
        )}
      </div>

      {openTerminalError && (
        <div style={{
          fontSize: 12, color: 'var(--cth-coral)',
          padding: '2px 8px',
          background: 'var(--cth-coral-light)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{openTerminalError}</div>
      )}

      {/* #7C — operator control (pause / halt / steer) for live agents */}
      {isReal && <AgentControlStrip agentId={agent.id} />}

      <CurrentCardStrip agentId={agent.id} />

      {/* Tabs */}
      <SidebarTabs current={sidebarTab} accent={agent.accent} onChange={setSidebarTab} />

      {/* Active tab body — fills remaining space */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {sidebarTab === 'terminal' && (
          isReal && agent.ptyId ? (
            isFullscreenedHere ? (
              <EmptyTab title={t('agentDetail.inFullscreen')}>
                {t('agentDetail.fullscreenDesc')}
              </EmptyTab>
            ) : (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                <PtyTerminalView
                  key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                  ptyId={agent.ptyId}
                  onStreamData={onPtyStream}
                  onUserPrompt={(t) => {
                    updateAgent(agent.id, { lastPrompt: t });
                    if (t.trim().toLowerCase() === '/clear') {
                      updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                    }
                    void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text: t });
                  }}
                  onToggleFullscreen={() => setFullscreen(agent.id)}
                  fullscreen={false}
                  embedded
                />
              </div>
              <MessageQueueComposer agent={agent} />
            </div>
            )
          ) : (
            <EmptyTab title={t('agentDetail.noPty')}>
              {t('agentDetail.noPtyDesc')}
            </EmptyTab>
          )
        )}

        {sidebarTab === 'git' && (
          <GitTab cwd={agent.cwd} />
        )}

        {sidebarTab === 'messages' && (
          <ThreadsPanel agentId={agent.id} />
        )}

        {sidebarTab === 'traces' && (
          <ToolWaterfall agentId={agent.id} />
        )}
      </div>

      {editOpen && (
        <EditAgentModal agent={agent} onClose={() => setEditOpen(false)} />
      )}
    </PixelPanel>
  );
}

/** Side panel for a selected dormant agent. It has no PTY, so there is no
 *  terminal, control strip or tabs. Edit and the note write to its restorable
 *  entry and never start it; Start runs the same single-agent restore as
 *  Command Center's "not started" list. Once started it moves to `agents` under
 *  the same id, so the selection carries over to AgentDetailPanel. */
export function DormantAgentPanel({ agent, config }: { agent: Agent; config?: HarnessConfig | null }) {
  const { t } = useTranslation();
  const renameAgent = useStore(s => s.renameAgent);
  const setAgentNote = useStore(s => s.setAgentNote);
  const rtl = useRtl();
  const [editOpen, setEditOpen] = useState(false);
  const { restoring, restoreTeam } = useRestoreTeam(config);
  const { retire } = useRetireAgent();
  const engine = `${providerPreset(inferAgentProvider(agent.command, agent.provider)).label} · ${agent.model ?? t('agentDetail.defaultModel')}`;

  return (
    <PixelPanel
      variant="default"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0, overflow: 'hidden' }}
      noPadding
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)',
        flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
          flexShrink: 0, opacity: 0.7
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', minWidth: 0, lineHeight: '14px' }}>
            <AgentNameEditor
              name={agent.name}
              onCommit={(name) => renameAgent(agent.id, name)}
              uppercase
              fontSize={10}
            />
          </div>
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 1,
            minWidth: 0, overflow: 'hidden'
          }}>
            <PixelBadge status="dormant" />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{agent.project}</span>
          </div>
        </div>
        <PixelButton variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.editDormantTip', { name: agent.name })}
            aria-label={t('agentDetail.editAria')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="edit" />{t('agentDetail.edit')}
          </span>
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => { void retire(agent); }}>
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('commandCenter.retireTitle', { name: agent.name })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {t('commandCenter.retire')}
          </span>
        </PixelButton>
        <PixelButton
          variant="primary"
          size="sm"
          onClick={() => { void restoreTeam(agent.id); }}
          disabled={restoring}
        >
          <span
            className="cth-tip cth-tip-wrap"
            data-tip={t('agentDetail.startTip', { name: agent.name })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="play" />{restoring ? t('agentDetail.starting') : t('agentDetail.start')}
          </span>
        </PixelButton>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
        background: 'var(--cth-paper-200)'
      }}>
        <div>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
            color: 'var(--cth-ink-500)'
          }}>{t('agentDetail.dormantTitle').toUpperCase()}</div>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--cth-ink-700)' }}>
            {t('agentDetail.dormantDesc', { name: agent.name })}
          </p>
        </div>
        <DormantField label={t('agentDetail.engine')}>{engine}</DormantField>
        {agent.description && (
          <DormantField label={t('agentDetail.role')}>{agent.description}</DormantField>
        )}
        <DormantField label={t('agentDetail.note')}>
          <textarea
            dir={rtl ? 'auto' : undefined}
            rows={3}
            value={agent.note ?? ''}
            onChange={(e) => setAgentNote(agent.id, e.target.value)}
            placeholder={t('agentStrip.notePlaceholder')}
            aria-label={t('agentCard.noteAria', { name: agent.name })}
            style={{
              width: '100%', padding: '6px 8px',
              border: 'none', outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-mono)', fontSize: 12,
              lineHeight: '18px', color: 'var(--cth-ink-900)'
            }}
          />
          <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
            {t('agentStrip.oneLineOneBullet')}
          </span>
        </DormantField>
      </div>

      {editOpen && (
        <EditAgentModal agent={agent} onClose={() => setEditOpen(false)} />
      )}
    </PixelPanel>
  );
}

function DormantField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)'
      }}>{label.toUpperCase()}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: 'var(--cth-ink-900)', overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

const CARD_POLL_MS = 5000;

/** The card this agent is on; nothing when it holds no `doing` card. Click opens the card. */
function CurrentCardStrip({ agentId }: { agentId: string }) {
  const [card, setCard] = useState<CurrentCard | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: unknown } | null;
        const tasks = Array.isArray(raw?.tasks) ? raw.tasks as Array<Record<string, unknown>> : [];
        if (alive) setCard(currentCard(tasks, agentId));
      } catch { /* keep last good */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, CARD_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [agentId]);
  if (!card) return null;
  return (
    <button
      type="button"
      onClick={() => useStore.getState().openTaskDetail(card.id)}
      title={card.title}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
        border: 'none', cursor: 'pointer', padding: '3px 8px', flexShrink: 0,
        background: 'var(--cth-paper-200)', borderBottom: '1px solid var(--cth-ink-100)',
        fontSize: 12, color: 'var(--cth-ink-900)', minWidth: 0
      }}
    >
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flexShrink: 0 }}>ON</span>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.nickname || card.title}</span>
      {card.more > 0 && <span style={{ color: 'var(--cth-ink-500)', flexShrink: 0 }}>+{card.more}</span>}
    </button>
  );
}

function EmptyTab({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 16, gap: 8,
      background: 'var(--cth-paper-200)'
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)'
      }}>{title.toUpperCase()}</div>
      <p style={{
        margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)',
        maxWidth: 280
      }}>{children}</p>
    </div>
  );
}
