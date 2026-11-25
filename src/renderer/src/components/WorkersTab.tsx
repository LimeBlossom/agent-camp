import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';

/**
 * WORKERS — live god-triggered ephemeral Slack workers (the Phase-1 spawn loop):
 * fresh isolated worktree → does a job → replies in-thread → safe teardown. This
 * tab reads main's `liveWorkers` map (via workers:list) so a human can SEE what's
 * running and stop one by hand; it also surfaces worktrees PRESERVED at teardown
 * (held until their work integrates, then auto-GC'd) so nothing silently piles up.
 */

// Types flow from main's `workers:list` handler via the typed `window.cth` global
// (declared in preload/index.d.ts) — derived here so there's no cross-package import.
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type PreservedWorktreeSnapshot = WorkersData['preserved'][number];

const POLL_MS = 2000;

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6
};
const metaRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontFamily: 'var(--cth-font-mono)',
  fontSize: 11, color: 'var(--cth-ink-700)'
};
const sectionHead: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--cth-ink-900)', margin: '2px 0'
};

function StatusBadge({ w }: { w: WorkerSnapshot }) {
  const { t } = useTranslation();
  const releasing = w.status === 'releasing';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '1px 6px',
      textTransform: 'uppercase', letterSpacing: 0.5,
      color: releasing ? 'var(--cth-paper-100)' : 'var(--cth-ink-900)',
      background: releasing ? 'var(--cth-ink-700)' : 'var(--cth-green, #2f8f4e)',
      boxShadow: releasing ? 'none' : 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {releasing ? t('workersTab.stopping') : t('workersTab.working')}
    </span>
  );
}

export function WorkersTab() {
  const { t } = useTranslation();
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name) ?? 'the orchestrator';
  const [data, setData] = useState<WorkersData | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    window.cth.listWorkers().then(setData).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const stop = useCallback((workerId: string) => {
    setStopping((s) => ({ ...s, [workerId]: true }));
    window.cth.stopWorker(workerId)
      .catch(() => { /* surfaced by the row vanishing or not */ })
      .finally(() => { refresh(); });
  }, [refresh]);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const max = data?.maxWorkers ?? 4;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px 16px', overflow: 'auto' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={sectionHead}>{t('workersTab.liveWorkers')}</span>
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' }}>
            {live.length} / {max}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
          {t('workersTab.liveIntro', { godName })}
        </p>

        {live.length === 0 ? (
          <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12 }}>
            {t('workersTab.noneRunning')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {live.map((w) => (
              <div key={w.workerId} style={card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <StatusBadge w={w} />
                    <span style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>{w.name}</span>
                    {w.hasSlack && (
                      <span title={t('workersTab.repliesToSlack')} style={{
                        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', padding: '0 5px'
                      }}>slack</span>
                    )}
                  </div>
                  <PixelButton
                    onClick={() => stop(w.workerId)}
                    disabled={w.releasing || !!stopping[w.workerId]}
                  >
                    {w.releasing || stopping[w.workerId] ? t('workersTab.stoppingEllipsis') : t('workersTab.stop')}
                  </PixelButton>
                </div>
                <div style={metaRow}>
                  <span title={t('workersTab.workerIdTitle')}>{w.workerId}</span>
                  <span title={t('workersTab.baseBranchTitle')}>{t('workersTab.base', { branch: w.baseBranch })}</span>
                  <span title={t('workersTab.upSinceTitle')}>{t('workersTab.up', { age: relAge(w.ageMs) })}</span>
                  <span title={t('workersTab.idleTitle')}>
                    {w.idleMs === null ? t('workersTab.ptyGone') : t('workersTab.idle', { age: relAge(w.idleMs) })}
                  </span>
                  <span title={t('workersTab.tokensTitle')}>
                    {t('workersTab.tokens', { value: fmtTokens(w.tokensUsed) })}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ` · ${t('workersTab.uncapped')}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <EngineLedger />

      {preserved.length > 0 && (
        <div>
          <span style={sectionHead}>{t('workersTab.preserved', { count: preserved.length })}</span>
          <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: '2px 0 8px' }}>
            {t('workersTab.preservedIntro')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {preserved.map((p) => (
              <div key={p.wtPath} style={card}>
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                  {p.workerId}
                </div>
                <div style={metaRow}>
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>{t('workersTab.base', { branch: p.baseBranch })}</span>
                  <span>{t('workersTab.keptAgo', { age: relAge(Math.max(0, Date.now() - p.preservedAt)) })}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type LedgerRow = Awaited<ReturnType<typeof window.cth.engineLedger>>['week'][number];
const LEDGER_POLL_MS = 30_000;

/** Which engine each temporary worker ran on and how it ended (engine-ledger.jsonl),
 *  so the engine order can be judged from data. Last 7 days, with all time beside it. */
function EngineLedger() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ week: LedgerRow[]; all: LedgerRow[] } | null>(null);
  const [allTime, setAllTime] = useState(false);
  useEffect(() => {
    let alive = true;
    const pull = (): void => { void window.cth.engineLedger?.().then((d) => { if (alive) setData(d); }).catch(() => { /* keep last */ }); };
    pull();
    const timer = setInterval(pull, LEDGER_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const rows = data ? (allTime ? data.all : data.week) : [];
  const cell: React.CSSProperties = { padding: '3px 6px', borderBottom: '1px solid var(--cth-ink-100)', textAlign: 'left', verticalAlign: 'top' };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={sectionHead}>{t('workersTab.engines')}</span>
        <PixelButton onClick={() => setAllTime((v) => !v)}>
          {allTime ? t('workersTab.engineLast7') : t('workersTab.engineAllTime')}
        </PixelButton>
      </div>
      {rows.length === 0 ? (
        <div style={{ ...card, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', fontSize: 12, marginTop: 6 }}>
          {allTime ? t('workersTab.engineNoneEver') : t('workersTab.engineNoneWeek')}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', marginTop: 6 }}>
          <thead>
            <tr style={{ color: 'var(--cth-ink-700)' }}>
              <th style={cell}>{t('workersTab.engineCol')}</th>
              <th style={cell}>{t('workersTab.engineRuns')}</th>
              <th style={cell}>{t('workersTab.engineEnded')}</th>
              <th style={cell}>{t('workersTab.engineMedian')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ended = Object.entries(r.outcomes).map(([k, n]) => `${k} ${n}`);
              if (r.running) ended.push(t('workersTab.engineStillRunning', { count: r.running }));
              return (
                <tr key={r.engine}>
                  <td style={cell}>{r.engine}</td>
                  <td style={cell}>{r.runs}</td>
                  <td style={cell}>{ended.join(', ') || '-'}</td>
                  <td style={cell}>{r.medianMinutes === null ? '-' : r.medianMinutes.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
