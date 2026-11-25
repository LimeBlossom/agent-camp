import { useCallback, useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';
import type { FeedbackReport } from '@shared/feedbackBoard';

const POLL_MS = 5000;
const BOSS = 'boss';

type Item = FeedbackReport & { thumb?: string };

/** Game feedback from F8 reports, beside the ASK ME cards: pick an agent (or the Boss) and send, or dismiss. */
export function FeedbackPanel() {
  const live = useStore((s) => s.agents);
  const dormant = useStore((s) => s.restorableAgents);
  const floor = [...live, ...dormant.filter((d) => !live.some((a) => a.id === d.id))].filter((a) => !a.isGod);
  const [items, setItems] = useState<Item[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    void window.cth.feedbackList().then((l) => setItems(l as Item[])).catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const noteFor = (r: Item): string => notes[r.id] ?? r.note ?? '';

  const act = async (id: string, run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    const r = await run().catch(() => ({ ok: false, error: 'Not sent' }));
    setError((e) => ({ ...e, [id]: r.ok ? '' : (r.error ?? 'Not sent') }));
    if (r.ok) load();
  };

  return (
    <div data-testid="feedback-panel" style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'var(--cth-font-mono)' }}>
      {!items.length && <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>No unhandled game feedback.</div>}
      {items.map((r) => (
        <div key={r.id} style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <div style={{ fontSize: 15, color: 'var(--cth-ink-900)' }}>{r.title || r.id}</div>
          <div style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{[r.game, r.version, r.time].filter(Boolean).join(' - ')}</div>
          {r.text && <div style={{ fontSize: 14, lineHeight: '18px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>{r.text}</div>}
          {r.thumb && <img src={r.thumb} alt="" style={{ maxWidth: 320, width: '100%', alignSelf: 'flex-start' }} />}
          <textarea
            value={noteFor(r)}
            placeholder="Your thoughts / what to do about this"
            rows={3}
            onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
            onBlur={() => { if (notes[r.id] !== undefined) void window.cth.feedbackSaveNote(r.id, notes[r.id]); }}
            style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 14, padding: 4, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select
              value={picks[r.id] ?? BOSS}
              onChange={(e) => setPicks((p) => ({ ...p, [r.id]: e.target.value }))}
              style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, padding: '3px 4px' }}
            >
              <option value={BOSS}>Boss decides</option>
              {floor.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.id}</option>)}
            </select>
            <PixelButton variant="primary" size="sm" onClick={() => void act(r.id, () => window.cth.feedbackSend(r.id, picks[r.id] ?? BOSS, noteFor(r)))}>Send to agent</PixelButton>
            <PixelButton size="sm" onClick={() => void act(r.id, () => window.cth.feedbackDismiss(r.id))}>Dismiss</PixelButton>
          </div>
          {error[r.id] && <div style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{error[r.id]}</div>}
        </div>
      ))}
    </div>
  );
}
