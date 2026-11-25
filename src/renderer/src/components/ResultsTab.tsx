import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { resultsFeed, type ResultFeedItem } from '@shared/resultsFeed';
import { askedWhen, parse, useCardFiles } from './AskMeTab';
import { siblingRoots } from '@/markdown/mdLinks';
import type { HiveTask } from './TasksKanban';
import { AnswerBox } from './AnswerBox';

const POLL_MS = 5000;

/**
 * RESULTS: what the human should see but never has to answer (answers to their own
 * questions, final checks that passed), newest first. Opening the tab marks
 * everything listed as seen; entries that arrive while it is open stay marked
 * new until the next open.
 */
export function ResultsTab() {
  const { t } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const { rootsFor, openFile } = useCardFiles();
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const feed: ResultFeedItem[] = resultsFeed(tasks);
  // Drafts share the ASK ME store so a half-typed reply survives a tab switch.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      try { await window.cth.hiveMarkResultsSeen(); } catch { /* badge clears on the next open */ }
    })();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const filesFor = (r: ResultFeedItem) => {
    const task = tasks.find((x) => x.id === r.cardId);
    if (!task) return {};
    const roots = rootsFor(task);
    return { roots: [...roots, ...siblingRoots(roots, r.text)], onOpenFile: openFile };
  };

  const keyOf = (r: ResultFeedItem) => `result:${r.cardId}|${r.at}`;
  const toggle = (k: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const sendReply = async (r: ResultFeedItem) => {
    const k = keyOf(r);
    const text = (drafts[k] ?? '').trim();
    if (!text || busy) return;
    setBusy(k);
    try {
      const res = await window.cth.hiveResultReply(r.cardId, r.at, text);
      if (!res.ok) throw new Error(res.error ?? 'reply failed');
      setAnswerDraft(k, '');
      setStatus((s) => ({ ...s, [k]: t('results.sent') }));
      setOpen((prev) => { const next = new Set(prev); next.delete(k); return next; });
      await refresh();
    } catch (e) { setStatus((s) => ({ ...s, [k]: e instanceof Error ? e.message : String(e) })); }
    setBusy(null);
  };

  const followUp = async (r: ResultFeedItem) => {
    const k = keyOf(r);
    if (busy) return;
    setBusy(k);
    try {
      const res = await window.cth.hiveResultFollowUp(r.cardId, r.at, drafts[k] ?? '');
      if (!res.ok || !res.cardId) throw new Error(res.error ?? 'follow-up failed');
      setAnswerDraft(k, '');
      setStatus((s) => ({ ...s, [k]: t('results.followUpFiled', { id: res.cardId }) }));
      await refresh();
    } catch (e) { setStatus((s) => ({ ...s, [k]: e instanceof Error ? e.message : String(e) })); }
    setBusy(null);
  };

  const linkButton = { border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)', textDecoration: 'underline' } as const;

  if (!feed.length) {
    return <div style={{ padding: 12, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>{t('results.empty')}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, overflowY: 'auto', height: '100%' }}>
      {feed.map((r) => (
        <div key={`${r.cardId}|${r.at}|${r.text.slice(0, 40)}`} style={{ boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-cream-100)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px',
            background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 13
          }}>
            <span style={{
              padding: '0 6px', fontSize: 11, color: 'var(--cth-on-accent)',
              background: r.label === 'check' ? 'var(--cth-mint, #6fbf8a)' : 'var(--cth-sky, #7fb2e5)'
            }}>{t(`results.label.${r.label}`)}</span>
            {!r.seen && <span style={{ padding: '0 6px', fontSize: 11, background: 'var(--cth-coral)', color: 'var(--cth-on-accent)' }}>{t('results.new')}</span>}
            <button
              onClick={() => openTaskDetail(r.cardId)}
              title={r.cardId}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', fontSize: 'inherit', color: 'var(--cth-ink-900)', textAlign: 'start', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >{r.title || r.cardId}</button>
            <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>{askedWhen(r.at)}</span>
          </div>
          <div style={{ padding: '6px 9px' }}><MarkdownPreview source={r.text} variant="card" {...filesFor(r)} /></div>
          <div style={{ padding: '0 9px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {open.has(keyOf(r)) ? (
              <AnswerBox
                value={drafts[keyOf(r)] ?? ''}
                onChange={(text) => setAnswerDraft(keyOf(r), text)}
                onSend={() => void sendReply(r)}
                busy={busy === keyOf(r)}
                placeholder={t('results.replyPlaceholder')}
                sendLabel={t('results.send')}
                busyLabel={t('results.sending')}
                autoFocus
              >
                <button onClick={() => void followUp(r)} disabled={!!busy} title={t('results.followUpTitle')} style={linkButton}>{t('results.followUp')}</button>
                {status[keyOf(r)] && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{status[keyOf(r)]}</span>}
              </AnswerBox>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={() => toggle(keyOf(r))} title={t('results.replyTitle')} style={linkButton}>{t('results.reply')}</button>
                <button onClick={() => void followUp(r)} disabled={!!busy} title={t('results.followUpTitle')} style={linkButton}>{t('results.followUp')}</button>
                {status[keyOf(r)] && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{status[keyOf(r)]}</span>}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
