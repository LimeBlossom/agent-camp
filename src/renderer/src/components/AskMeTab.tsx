import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelBadge } from './PixelBadge';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { type HiveTask, type HumanQA, openQuestion, waitsOnHuman } from './TasksKanban';
import { compareByNewestAsk } from './askMeOrder';
import { projectCounts, projectOf } from '@shared/askMeProject';
import { backlogMailBody, backlogPatch, dependentsTree } from '@shared/backlog';
import { cardNickname } from '@shared/cardNickname';
import { siblingRoots } from '@/markdown/mdLinks';
import { useRtl } from '@/i18n/useDirection';
import { useCardFiles } from './cardFiles';
import { AnswerBox } from './AnswerBox';

export { useCardFiles };

/**
 * ASK ME — first-class human feedback through the task system.
 *
 * Tasks the god can only move with the human's input sit here. An entry isn't
 * necessarily a question — it can be a TO-DO only the human can perform
 * (create an account, approve a purchase, provide credentials, test on a real
 * device). Each card shows the open ask, a place to respond (an answer, or a
 * "done, here's the result" confirmation), and the CASCADE of downstream
 * tasks stuck waiting on this one — so "why isn't X done?" reads as "ah,
 * because I still owe something here."
 *
 * Sending an answer does two things:
 *   1. writes it into the card's humanQA entry in hive/tasks.json (the
 *      decision is documented ON the task, forever), and
 *   2. mails the god so it picks the answer up, unblocks the card, and the
 *      work continues — no separate HumanQuestion.md side-channel anymore.
 */

const POLL_MS = 5000;

export function parse(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: HiveTask[] }).tasks
    : [];
  return list.filter((t) => !!t && typeof t === 'object');
}

export { dependentsTree };

/** Local time plus how long ago, e.g. "11/20/2026, 2:15:00 AM (2h ago)". Empty when askedAt is missing or unparseable. */
export function askedWhen(askedAt: string | undefined, now: number = Date.now()): string {
  const ms = Date.parse(askedAt ?? '');
  if (isNaN(ms)) return '';
  const m = Math.floor(Math.max(0, now - ms) / 60000);
  const since = m < 1 ? 'under 1m' : m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
  return `${new Date(ms).toLocaleString()} (${since} ago)`;
}

/** Every open ask on a card, in the order asked (openQuestion is the newest of these). */
export function openAsks(t: HiveTask): HumanQA[] {
  return (t.humanQA ?? []).filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);
}

const PROJECT_KEY = 'cth.askMeProject';

export function ProjectChip({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      border: 'none', cursor: 'pointer', padding: '2px 8px 1px',
      fontFamily: 'var(--cth-font-ui)', fontSize: 12,
      background: on ? 'var(--cth-ink-900)' : 'var(--cth-cream-200)',
      color: on ? 'var(--cth-cream-100)' : 'var(--cth-ink-900)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>{label} {count}</button>
  );
}

/** Roots and opener for the file paths a card's markdown links to. Shared with the Backlog. */
/** The project filter shared by ASK ME and the Backlog, so one project's cards can be
 *  worked without the rest. Kept per viewer across restarts under `storageKey`; null
 *  shows every project. */
export function useProjectFilter(storageKey: string, cards: HiveTask[]) {
  const [project, setProjectState] = useState<string | null>(() => {
    try { return window.localStorage.getItem(storageKey) || null; } catch { return null; }
  });
  const setProject = (p: string | null): void => {
    setProjectState(p);
    try { if (p) window.localStorage.setItem(storageKey, p); else window.localStorage.removeItem(storageKey); } catch { /* per-viewer nicety only */ }
  };
  const projects = projectCounts(cards);
  const shown = project ? cards.filter((t) => projectOf(t) === project) : cards;
  return { project, setProject, projects, shown };
}

export function ProjectFilter({ filter, total }: { filter: ReturnType<typeof useProjectFilter>; total: number }) {
  const { t: translate } = useTranslation();
  const { project, setProject, projects } = filter;
  if (projects.length <= 1 && !project) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <ProjectChip label={translate('askMe.allProjects')} count={total} on={!project} onClick={() => setProject(null)} />
      {projects.map((p) => (
        <ProjectChip key={p.project} label={p.project} count={p.count} on={project === p.project} onClick={() => setProject(p.project)} />
      ))}
      {project && !projects.some((p) => p.project === project) && (
        <ProjectChip label={project} count={0} on onClick={() => setProject(project)} />
      )}
    </div>
  );
}

/** The card header: title (opens the task detail), then the assignee badge, then `children` (actions). */
export function CardHeader({ task, assignee, children }: { task: HiveTask; assignee?: string; children?: React.ReactNode }) {
  const { t: translate } = useTranslation();
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const nickname = cardNickname(task);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
      background: 'var(--cth-lilac-light, #ece2f5)', boxShadow: 'inset 0 -1px 0 var(--cth-ink-700)'
    }}>
      <button
        onClick={() => openTaskDetail(task.id)}
        title={task.title}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textAlign: 'left',
          fontFamily: 'var(--cth-font-mono)', fontSize: 15, color: 'var(--cth-ink-900)',
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}
      >
        {nickname || task.title}
      </button>
      {assignee && <PixelBadge status="blocked" label={assignee} />}
      {children}
    </div>
  );
}

/** The cascade: what's stuck behind this card. */
export function StuckList({ stuck, nameFor }: { stuck: HiveTask[]; nameFor: (id?: string) => string | undefined }) {
  const { t: translate } = useTranslation();
  if (stuck.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-coral)' }}>
        {stuck.length === 1
          ? translate('askMe.blockingDownstream', { count: stuck.length })
          : translate('askMe.blockingDownstreamPlural', { count: stuck.length })}
      </div>
      {stuck.slice(0, 6).map((d, i) => {
        const nick = cardNickname(d);
        return (
          <div key={d.id} title={d.title} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            paddingLeft: 8 + Math.min(i, 3) * 8,
            fontSize: 12, color: 'var(--cth-ink-700)'
          }}>
            <span style={{ color: 'var(--cth-ink-300)' }}>└</span>
            <span style={{ width: 7, height: 7, flexShrink: 0, background: d.status === 'blocked' ? 'var(--cth-coral)' : 'var(--cth-sky)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || d.title}</span>
            {nameFor(d.assignee) && <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>({nameFor(d.assignee)})</span>}
          </div>
        );
      })}
      {stuck.length > 6 && (
        <div style={{ paddingLeft: 14, fontSize: 11, color: 'var(--cth-ink-300)' }}>{translate('askMe.more', { count: stuck.length - 6 })}</div>
      )}
    </div>
  );
}

export function AskMeTab() {
  const { t: translate } = useTranslation();
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Drafts live in the STORE (keyed by task id): switching tabs unmounts this
  // view, and a half-typed answer must survive the round trip.
  const drafts = useStore((s) => s.answerDrafts);
  const setAnswerDraft = useStore((s) => s.setAnswerDraft);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const { rootsFor, openFile } = useCardFiles();
  const [sending, setSending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // Newest ask at the top, oldest at the bottom. Before this the board had no
  // comparator at all, so a question's position was an accident of where its
  // card sat in tasks.json. `filter` already returns a fresh array, so sorting
  // in place never touches the store's own ordering. The ask each card is
  // ranked by comes from openQuestion() — the same predicate waitsOnHuman uses
  // — and only this OUTER list is sorted; a card's humanQA history stays
  // chronological (see askMeOrder.ts).
  const allWaiting = tasks
    .filter(waitsOnHuman)
    .sort((a, b) => compareByNewestAsk(openQuestion(a), openQuestion(b)));
  const filter = useProjectFilter(PROJECT_KEY, allWaiting);
  const { project, shown: waiting } = filter;

  /**
   * Apply `patch` to the OPEN humanQA entry of one card, on the RAW ledger.
   * Returns whether it landed.
   *
   * Re-reads tasks.json first rather than writing this view's 5s-old snapshot,
   * because `hive:writeTasks` treats the incoming array as the card MEMBERSHIP:
   * writing our snapshot back would delete any card the god added since the last
   * poll. Re-locating the open question by its text also means an answer can
   * never land on a different question the god swapped in underneath us — in
   * that case nothing is written and the draft is kept.
   */

  const sendAnswer = async (task: HiveTask) => {
    const text = (drafts[task.id] ?? '').trim();
    const open = openQuestion(task);
    if (!text || !open || sending) return;
    setSending(task.id);
    try {
      // 1) Document the answer ON the card.
      const next = tasks.map((t) => {
        if (t.id !== task.id) return t;
        const qa = (t.humanQA ?? []).map((e) =>
          e === open || (e.q === open.q && !e.a)
            ? { ...e, a: text, answeredAt: new Date().toISOString() }
            : e
        );
        return { ...t, humanQA: qa };
      });
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('task changed before answer could be saved');
      setTasks(next);
      // 2) The harness unblocks the card and mails the assignee (or the Boss).
      await window.cth.hiveHumanAnswer(task.id, open.q, text);
      setAnswerDraft(task.id, '');
    } catch { /* leave the draft so the user can retry */ }
    setSending(null);
  };

  // Dismiss the open ask off the ASK ME board WITHOUT answering it. We mark the
  // open humanQA entry `dismissedAt` (no fabricated answer) so openQuestion()
  // stops returning it and the card leaves this view — the question itself stays
  // on the card, so the Q&A history is never dropped (protocol). The task stays
  // blocked on the kanban; the god can re-ask by appending a fresh humanQA entry.
  const dismiss = async (task: HiveTask) => {
    const open = openQuestion(task);
    if (!open || sending === task.id) return;
    const next = tasks.map((t) => {
      if (t.id !== task.id) return t;
      const qa = (t.humanQA ?? []).map((e) =>
        e === open || (e.q === open.q && !e.a && !e.dismissedAt)
          ? { ...e, dismissedAt: new Date().toISOString() }
          : e
      );
      return { ...t, humanQA: qa };
    });
    setTasks(next); // optimistic — the card disappears immediately
    try {
      const updated = next.find((candidate) => candidate.id === task.id);
      const result = updated
        ? await window.cth.hivePatchTask(task.id, { humanQA: updated.humanQA })
        : { ok: false };
      if (!result.ok) throw new Error('task changed before ask could be dismissed');
    } catch {
      setTasks(tasks); // restore on failure so the user can retry
    }
  };

  // Shelve the card in the Backlog. The open question stays on the card and
  // returns to this board when the human brings the card back.
  const sendToBacklog = async (task: HiveTask) => {
    if (sending === task.id) return;
    setSending(task.id);
    try {
      const result = await window.cth.hivePatchTask(task.id, backlogPatch(new Date().toISOString()));
      if (!result.ok) throw new Error('backlog patch failed');
      await refresh();
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `BACKLOG: "${task.title}"`,
        body: backlogMailBody(task.title, task.id)
      }, 'human');
    } catch { /* the card stays on the board, so the user can retry */ }
    setSending(null);
  };

  return (
    // Body text is set in the mono face (VT323) — the same readable font the
    // memory viewer uses. Pixelify Sans (font-ui) is too chunky for prose like
    // questions and answers. Display/badge bits keep their explicit faces.
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      <ProjectFilter filter={filter} total={allWaiting.length} />
      {waiting.length === 0 && project && allWaiting.length > 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          {translate('askMe.emptyProject', { project })}
        </div>
      )}
      {allWaiting.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          {translate('askMe.emptyTitle')}<br />
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>
            {translate('askMe.emptySub')}
          </span>
        </div>
      )}
      {waiting.map((t) => {
        const asks = openAsks(t);
        const stuck = dependentsTree(t.id, tasks);
        return (
          <div key={t.id} style={{
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            display: 'flex', flexDirection: 'column'
          }}>
            <CardHeader task={t} assignee={nameFor(t.assignee)}>
              <button
                onClick={() => void sendToBacklog(t)}
                disabled={sending === t.id}
                title={translate('askMe.backlogTitle')}
                style={{
                  flexShrink: 0, padding: '1px 6px 0', border: 'none',
                  cursor: sending === t.id ? 'default' : 'pointer',
                  background: 'var(--cth-cream-200)', color: 'var(--cth-ink-900)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11
                }}
              >{translate('askMe.backlog')}</button>
              {/* Dismiss — clears this ask off the board without answering it.
                  The card's Q&A history is preserved (the question stays on the
                  card, just marked dismissed). */}
              <button
                onClick={() => void dismiss(t)}
                disabled={sending === t.id}
                title={translate('askMe.dismissTitle')}
                aria-label={translate('askMe.dismissAria')}
                style={{
                  flexShrink: 0, width: 18, height: 18, padding: 0, marginLeft: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  border: 'none', cursor: sending === t.id ? 'default' : 'pointer',
                  background: 'transparent', color: 'var(--cth-ink-500)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13
                }}
                onMouseEnter={(e) => { if (sending !== t.id) e.currentTarget.style.color = 'var(--cth-coral)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
              >✕</button>
            </CardHeader>

            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* The question, rendered as markdown. The god writes these with
                  emphasis, lists, `code` and links; as plain text the asterisks
                  and backticks were on screen literally. The card variant keeps
                  this card's mono face and turns a single newline into a break, so
                  a question with no markdown in it looks exactly as it did. */}
              {asks.map((open, i) => (
                <div key={`${i}:${open.q}`} dir={rtl ? 'auto' : undefined} style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
                  {askedWhen(open.askedAt) && (
                    <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginBottom: 2 }}>{askedWhen(open.askedAt)}</div>
                  )}
                  <MarkdownPreview source={open.q} variant="card" roots={[...rootsFor(t), ...siblingRoots(rootsFor(t), open.q)]} onOpenFile={openFile} />
                </div>
              ))}

              <AnswerBox
                value={drafts[t.id] ?? ''}
                onChange={(text) => setAnswerDraft(t.id, text)}
                onSend={() => void sendAnswer(t)}
                busy={sending === t.id}
                placeholder={translate('askMe.answerPlaceholder')}
                sendLabel={translate('askMe.respond')}
                busyLabel={translate('askMe.sending')}
              >
                {(t.humanQA?.filter((e) => e.a).length ?? 0) > 0 && (
                  <button
                    onClick={() => openTaskDetail(t.id)}
                    title={translate('askMe.viewAnswersHistory')}
                    style={{
                      border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
                      fontSize: 10, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-display)',
                      textDecoration: 'underline'
                    }}
                  >
                    {(() => {
                      const n = t.humanQA!.filter((e) => e.a).length;
                      return n === 1
                        ? translate('askMe.viewAnswers', { count: n })
                        : translate('askMe.viewAnswersPlural', { count: n });
                    })()}
                  </button>
                )}
              </AnswerBox>

              <StuckList stuck={stuck} nameFor={nameFor} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
