/**
 * Title-bar readout of the Claude subscription limits: "5h 22% (2h 10m) · wk 49% (3d 4h)".
 * Main reads them from the status line's per-session cache (see
 * src/main/claudeLimits.ts); hidden when nothing has been cached.
 */
import { useEffect, useState } from 'react';
import type { ClaudeLimits } from '../../../preload';
import { formatResetUseBy, usageChipStyle } from './usageChipStyle';

const POLL_MS = 30_000;

function colourFor(percent: number): string {
  if (percent >= 90) return 'var(--cth-danger)';
  if (percent >= 75) return 'var(--cth-warn)';
  return 'var(--cth-ink-500)';
}

/** Time until reset, compact: "45m", "2h 10m", "3d 4h". Empty when unknown. */
function untilReset(resetsAt: number | undefined): string {
  if (!resetsAt) return '';
  const mins = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Segment({ label, bucket }: { label: string; bucket?: { percent: number; resetsAt?: number } }) {
  if (!bucket) return null;
  const pct = Math.round(bucket.percent);
  const reset = untilReset(bucket.resetsAt);
  return (
    <span title={reset ? `resets in ${reset}` : undefined} style={{ color: colourFor(pct) }}>
      {label} {pct}%
      {reset && <span style={{ color: 'var(--cth-ink-500)' }}> ({reset})</span>}
    </span>
  );
}

export function ClaudeLimitsChip() {
  const [limits, setLimits] = useState<ClaudeLimits | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      void window.cth.claudeLimits?.()
        .then((next) => { if (alive) setLimits(next); })
        .catch(() => { /* keep the last reading */ });
    };
    pull();
    const t = setInterval(pull, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!limits || (!limits.fiveHour && !limits.sevenDay && !limits.sevenDayFable)) return null;
  const grants = limits.resetGrants ?? [];
  const resetsLeft = grants.reduce((n, g) => n + g.left, 0);
  const kinds = Array.from(new Set(grants.map((g) => g.kind ?? g.label)));
  const soonest = grants.reduce<number | undefined>((s, g) => (g.endsAt && (!s || g.endsAt < s) ? g.endsAt : s), undefined);
  const useBy = formatResetUseBy(soonest);
  const detail = [...kinds, ...(useBy ? [useBy] : [])].join(', ');
  const title = resetsLeft > 0
    ? [
        ...grants.map((g) => `${g.label}: ${g.left} left${g.endsAt ? `, use by ${new Date(g.endsAt * 1000).toLocaleDateString()}` : ''}${g.usableNow ? '' : ' (not usable now)'}`),
        'Spend one with /limit-reset in Claude Code'
      ].join('\n')
    : undefined;
  return (
    <span title={title} style={usageChipStyle}>
      <span style={{ color: 'var(--cth-ink-500)' }}>claude</span>
      <Segment label="5h" bucket={limits.fiveHour} />
      {limits.fiveHour && limits.sevenDay && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      <Segment label="wk" bucket={limits.sevenDay} />
      {limits.sevenDayFable && (limits.fiveHour || limits.sevenDay) && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      <Segment label="fable" bucket={limits.sevenDayFable} />
      {resetsLeft > 0 && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      {resetsLeft > 0 && (
        <span style={{ color: 'var(--cth-ink-500)' }}>
          {resetsLeft} {resetsLeft === 1 ? 'reset' : 'resets'}
          {detail && <span> ({detail})</span>}
        </span>
      )}
    </span>
  );
}
