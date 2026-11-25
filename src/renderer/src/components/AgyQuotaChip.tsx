/**
 * Title-bar readout of agy's quota pools, beside the Claude and Codex chips:
 * "agy gem 5h 0% · wk 19% (39h 47m) | claude 5h 100% (4h 18m) · wk 39% (6d 14h) | argon wk 100% (2d 2h)".
 * Percent USED of each window, like the other chips (agy itself reports remaining);
 * a pool is out when EITHER of its windows is full. Main reads it from a hidden
 * throwaway agy every 5 minutes (src/main/agyQuota.ts); hovering asks for a fresh
 * reading, at most once a minute. Hidden when there is no reading.
 */
import { useEffect, useState } from 'react';
import type { AgyQuota } from '../../../preload';
import { refreshInMs } from '../../../shared/agyRefresh';
import { usageChipStyle } from './usageChipStyle';

const POLL_MS = 60_000;
type Window = NonNullable<AgyQuota['pools'][number]['weekly']>;

function colourFor(used: number): string {
  if (used >= 90) return 'var(--cth-danger)';
  if (used >= 75) return 'var(--cth-warn)';
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

function usedOf(remaining: number): number {
  return Math.max(0, 100 - remaining);
}

/** Time left until the window refreshes, from the note agy printed when it was read. */
function untilRefresh(w: Window, readAt: number): string {
  const ms = refreshInMs(w.note);
  return ms ? span(readAt + ms - Date.now()) : '';
}

function windowLine(name: string, w?: Window): string {
  return w ? `  ${name}: ${usedOf(w.remaining).toFixed(2)}% used${w.note ? `, ${w.note}` : ''}` : `  ${name}: no reading`;
}

function Segment({ label, w, readAt }: { label: string; w?: Window; readAt: number }) {
  if (!w) return <span style={{ color: 'var(--cth-ink-500)' }}>{label} ?</span>;
  const used = usedOf(w.remaining);
  const reset = untilRefresh(w, readAt);
  return (
    <span style={{ color: colourFor(used) }}>
      {label} {Math.round(used)}%
      {reset && <span style={{ color: 'var(--cth-ink-500)' }}> ({reset})</span>}
    </span>
  );
}

export function AgyQuotaChip() {
  const [quota, setQuota] = useState<AgyQuota | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      void window.cth.agyQuota?.()
        .then((next) => { if (alive && next) setQuota(next); })
        .catch(() => { /* keep the last reading */ });
    };
    pull();
    const t = setInterval(pull, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const refresh = (): void => {
    void window.cth.agyQuotaRefresh?.().then((next) => { if (next) setQuota(next); }).catch(() => { /* keep */ });
  };

  if (!quota || quota.pools.length === 0) return null;
  const title = [
    'agy (Antigravity) quota, percent used',
    ...quota.pools.flatMap((p) => [p.name, ...(p.label === 'argon' ? [] : [windowLine('5-hour', p.fiveHour)]), windowLine('Weekly', p.weekly)]),
    `Read ${span(Date.now() - quota.at)} ago; hover again for a fresh reading (at most once a minute)`
  ].join('\n');
  const dim = { color: 'var(--cth-ink-500)' };
  return (
    <span
      title={title}
      onMouseEnter={refresh}
      style={usageChipStyle}
    >
      <span style={dim}>agy</span>
      {quota.pools.map((p, i) => (
        <span key={p.name} style={{ display: 'inline-flex', gap: 6 }}>
          {i > 0 && <span style={dim}>|</span>}
          <span style={dim}>{p.label}</span>
          {/* Argon's pool has a weekly limit only. */}
          {p.label !== 'argon' && <Segment label="5h" w={p.fiveHour} readAt={quota.at} />}
          {p.label !== 'argon' && <span style={dim}>·</span>}
          <Segment label="wk" w={p.weekly} readAt={quota.at} />
        </span>
      ))}
    </span>
  );
}
