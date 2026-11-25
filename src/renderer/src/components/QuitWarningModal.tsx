import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { ClosingTimeWorker } from '../../../preload';

/** Renderer-side closing-time view state. Mirrors the main process's
 *  ClosingTimeEvent phases, plus a local 'error' for a failed start. */
export interface ClosingTimeState {
  phase: 'started' | 'progress' | 'complete' | 'timeout' | 'error';
  acked: number;
  total: number;
  missing?: ClosingTimeWorker[];
  excused?: ClosingTimeWorker[];
  error?: string;
}

function silentLabel(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.round(sec / 60);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} hr`;
}

/** "Name (silent 60 min, frozen)". */
function workerLine(w: ClosingTimeWorker): string {
  const parts: string[] = [];
  if (typeof w.silentSecAgo === 'number') parts.push(`silent ${silentLabel(w.silentSecAgo)}`);
  if (w.reason) parts.push(w.reason);
  return parts.length ? `${w.name} (${parts.join(', ')})` : w.name;
}

export interface QuitWarningModalProps {
  ptyCount: number;
  /** Non-null while the closing-time protocol runs — switches the dialog into
   *  the "wrapping up the floor" progress view. */
  closing?: ClosingTimeState | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Start the graceful shutdown (the third button). */
  onClosingTime?: () => void;
  /** Park the named workers' cards and close without waiting for their ACKs. */
  onCloseWithout?: (ids: string[]) => void;
}

export function QuitWarningModal({ ptyCount, closing, onCancel, onConfirm, onClosingTime, onCloseWithout }: QuitWarningModalProps) {
  const missing = closing?.missing ?? [];
  const excused = closing?.excused ?? [];
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    await onConfirm();
    // No need to clear busy — the app is quitting.
  };

  const inClosingTime = !!closing && closing.phase !== 'error';

  return (
    <div
      onClick={inClosingTime ? undefined : onCancel}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Above EVERY modal, not just most of them. Modals in this app sit at
        // 500 (add agent, edit agent, the release drop) and overlays below that.
        // At 300 this dialog opened BEHIND the release drop, so clicking quit
        // with a drop on screen looked like quit did nothing — while a hidden
        // dialog held the app open. This is the last thing the user is asked
        // before the process dies; it outranks whatever it interrupts.
        zIndex: 1000
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: '92vw' }}
      >
        <PixelPanel variant="dialog" title={inClosingTime ? 'WRAP UP' : 'QUITTING NOW?'} noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {inClosingTime ? (
              <>
                {/* ── Graceful shutdown in progress ──────────────────────── */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 32, height: 32,
                    background: closing!.phase === 'complete' ? 'var(--cth-mint-light, #cdeccd)' : 'var(--cth-lemon-light, #f6ecc4)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <Icon name="bell" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '20px',
                      color: 'var(--cth-ink-900)',
                      marginBottom: 4
                    }}>
                      {closing!.phase === 'complete'
                        ? 'CLOSING CAMP'
                        : closing!.phase === 'timeout'
                          ? 'WRAP-UP DEADLINE REACHED'
                          : 'WRAPPING UP THE FLOOR'}
                    </div>
                    <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                      {closing!.phase === 'complete' ? (
                        <>Camp closes in a moment. Missing confirmations are recorded in the activity log.</>
                      ) : (
                        <>Workers save their state and report to the orchestrator. Camp closes after confirmation or when the wrap-up deadline expires.</>
                      )}
                    </div>
                  </div>
                </div>

                {/* ACK progress */}
                <div style={{
                  padding: 8,
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontSize: 12, lineHeight: '18px',
                  color: 'var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-display)'
                }}>
                  {closing!.total > 0
                    ? `${closing!.acked} / ${closing!.total} WORKERS CONFIRMED${closing!.acked >= closing!.total ? ' — WAITING FOR THE ORCHESTRATOR' : ''}`
                    : 'NO WORKERS ON THE FLOOR — WAITING FOR THE ORCHESTRATOR'}
                  {missing.length > 0 && (
                    <div style={{ marginTop: 6, fontFamily: 'var(--cth-font-body, inherit)' }}>
                      {closing!.phase === 'started' || closing!.phase === 'progress' ? 'Waiting on' : 'No confirmation from'}: {missing.map(workerLine).join(', ')}
                    </div>
                  )}
                  {excused.length > 0 && (
                    <div style={{ marginTop: 6, fontFamily: 'var(--cth-font-body, inherit)' }}>
                      Excused from wrap-up: {excused.map(workerLine).join(', ')}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  {closing!.phase !== 'complete' && (
                    <>
                      <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                        cancel — back to work
                      </PixelButton>
                      {missing.length > 0 && onCloseWithout && (
                        <PixelButton variant="secondary" size="md" onClick={() => onCloseWithout(missing.map((worker) => worker.id))} disabled={busy}>
                          close without {missing.map((worker) => worker.name).join(', ')}
                        </PixelButton>
                      )}
                      <PixelButton variant="destructive" size="md" onClick={confirm} disabled={busy}>
                        {busy ? 'killing...' : 'force quit now'}
                      </PixelButton>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* ── The classic quit warning ────────────────────────────── */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 32, height: 32,
                    background: 'var(--cth-coral-light)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <Icon name="bell" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '20px',
                      color: 'var(--cth-ink-900)',
                      marginBottom: 4
                    }}>
                      {ptyCount} {ptyCount === 1 ? 'AGENT' : 'AGENTS'} STILL RUNNING
                    </div>
                    <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                      Closing the harness will terminate{' '}
                      {ptyCount === 1 ? 'the running claude session' : `all ${ptyCount} running claude sessions`}{' '}
                      and discard any unsaved progress they were holding in memory. The conversation
                      history inside each session is lost when the PTY exits.
                    </div>
                  </div>
                </div>

                <div style={{
                  padding: 8,
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  fontSize: 12, lineHeight: '18px',
                  color: 'var(--cth-ink-700)'
                }}>
                  Tip: <strong>wrap-up</strong> is the safe way out — the orchestrator has
                  every agent commit its work and save its memory, and the app closes itself
                  once the whole floor has confirmed. No data loss.
                </div>

                {closing?.phase === 'error' && (
                  <div style={{
                    padding: 8,
                    background: 'var(--cth-coral-light)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontSize: 12, lineHeight: '18px',
                    color: 'var(--cth-ink-900)'
                  }}>
                    {closing.error ?? 'Wrap-up could not start.'}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                    keep them running
                  </PixelButton>
                  {onClosingTime && (
                    <PixelButton variant="primary" size="md" onClick={onClosingTime} disabled={busy}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="clock" /> wrap up
                      </span>
                    </PixelButton>
                  )}
                  <PixelButton variant="destructive" size="md" onClick={confirm} disabled={busy}>
                    {busy ? 'killing...' : `kill ${ptyCount === 1 ? 'it' : 'all'} & quit`}
                  </PixelButton>
                </div>
              </>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
