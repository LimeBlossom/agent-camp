/**
 * Title-bar readout of the Codex (ChatGPT plan) limits, beside the Claude chip:
 * "codex 5h 4% (1h 10m) · wk 2% (6d 4h)". Main takes the newest `rate_limits` record
 * across every Codex rollout (src/main/codexLimits.ts); hidden when there is none.
 */
import { useEffect, useState } from 'react';
import type { CodexLimits } from '../../../preload';
import { formatResetUseBy, usageChipStyle } from './usageChipStyle';

const POLL_MS = 30_000;
type Bucket = NonNullable<CodexLimits['fiveHour']>;

function colourFor(percent: number): string {
  if (percent >= 90) return 'var(--cth-danger)';
  if (percent >= 75) return 'var(--cth-warn)';
  return 'var(--cth-ink-500)';
}

/** "45m", "2h 10m", "3d 4h". */
function span(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function untilReset(b: Bucket): string {
  return b.resetsAt ? span(b.resetsAt * 1000 - Date.now()) : '';
}

function tipLine(name: string, b?: Bucket): string {
  if (!b) return `${name}: no reading`;
  if (b.reset) return `${name}: reset since the last reading (0%)`;
  const at = b.resetsAt ? new Date(b.resetsAt * 1000).toLocaleString() : 'unknown';
  return `${name}: ${Math.round(b.percent)}% used, resets ${at}${b.resetsAt ? ` (in ${untilReset(b)})` : ''}`;
}

function Segment({ label, bucket }: { label: string; bucket?: Bucket }) {
  if (!bucket) return null;
  const pct = Math.round(bucket.percent);
  const reset = untilReset(bucket);
  return (
    <span style={{ color: colourFor(pct) }}>
      {label} {pct}%
      {reset && <span style={{ color: 'var(--cth-ink-500)' }}> ({reset})</span>}
    </span>
  );
}

export function CodexLimitsChip() {
  const [limits, setLimits] = useState<CodexLimits | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      void window.cth.codexLimits?.()
        .then((next) => { if (alive) setLimits(next); })
        .catch(() => { /* keep the last reading */ });
    };
    pull();
    const t = setInterval(pull, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!limits || (!limits.fiveHour && !limits.weekly)) return null;
  const isBlocked = limits.ordinaryUsageAllowed === false;
  const titleLines = [
    'Codex (ChatGPT plan), newest reading across all Codex sessions',
    tipLine('5-hour', limits.fiveHour),
    tipLine('Weekly', limits.weekly)
  ];
  if (isBlocked) {
    titleLines.push('Ordinary usage is blocked (resets unavailable)');
  }
  const creditsList = limits.credits?.credits ?? [];
  for (const c of creditsList) {
    const expSec = c.expiresAt ?? (c as { expiry?: number }).expiry;
    const expStr = typeof expSec === 'number'
      ? new Date(expSec * 1000).toLocaleDateString()
      : 'unknown';
    titleLines.push(`Reset credit expires ${expStr}`);
  }
  if (limits.appServerError) {
    titleLines.push(limits.creditsAt
      ? `Codex app-server unreachable (${limits.appServerError}); reset count is from ${span(Date.now() - limits.creditsAt)} ago`
      : `Codex app-server unreachable (${limits.appServerError}); reset count unknown`);
  }
  titleLines.push(`Reading is ${span(Date.now() - limits.updatedAt)} old`);
  const title = titleLines.join('\n');

  const availableCount = limits.credits?.availableCount ?? 0;
  const showCredits = availableCount > 0;
  const soonestCreditExpiry = creditsList.reduce<number | undefined>((soonest, credit) => {
    if (credit.status && credit.status !== 'available') return soonest;
    const expiry = credit.expiresAt ?? (credit as { expiry?: number }).expiry;
    return typeof expiry === 'number' && (!soonest || expiry < soonest) ? expiry : soonest;
  }, undefined);
  const useBy = formatResetUseBy(soonestCreditExpiry);
  const creditsUnknown = !limits.credits && !!limits.appServerError;
  const hasBuckets = !!(limits.fiveHour || limits.weekly);

  return (
    <span title={title} style={usageChipStyle}>
      <span style={{ color: 'var(--cth-ink-500)' }}>codex</span>
      <Segment label="5h" bucket={limits.fiveHour} />
      {limits.fiveHour && limits.weekly && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      <Segment label="wk" bucket={limits.weekly} />
      {showCredits && hasBuckets && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      {showCredits && (
        <span style={{ color: isBlocked ? 'var(--cth-warn)' : 'var(--cth-ink-500)' }}>
          {availableCount} {availableCount === 1 ? 'reset' : 'resets'}
          {useBy && <span>, {useBy}</span>}
        </span>
      )}
      {creditsUnknown && hasBuckets && <span style={{ color: 'var(--cth-ink-500)' }}>·</span>}
      {creditsUnknown && <span style={{ color: 'var(--cth-ink-500)' }}>resets unknown</span>}
    </span>
  );
}
