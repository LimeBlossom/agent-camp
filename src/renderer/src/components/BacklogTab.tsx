import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { siblingRoots } from '@/markdown/mdLinks';
import { useRtl } from '@/i18n/useDirection';
import { type HiveTask, openQuestion } from './TasksKanban';
import { CardHeader, dependentsTree, parse, ProjectFilter, StuckList, useCardFiles, useProjectFilter } from './AskMeTab';
import { isBacklogged, unbacklogMailBody, unbacklogPatch } from '@shared/backlog';

/**
 * BACKLOG: cards the human shelved for later (shared/backlog.ts), grouped by project
 * the same way ASK ME is. "Bring back" clears the shelf mark and tells the Boss,
 * which re-plans the card.
 */

const POLL_MS = 5000;
const PROJECT_KEY = 'cth.backlogProject';

function shelvedMs(t: HiveTask): number {
  const ms = Date.parse(t.backloggedAt ?? '');
  return Number.isNaN(ms) ? 0 : ms;
}

export function BacklogTab() {
  const { t: translate } = useTranslation();
  const rtl = useRtl();
  const { rootsFor, openFile } = useCardFiles();
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parse(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  const all = tasks.filter(isBacklogged).sort((a, b) => shelvedMs(b) - shelvedMs(a));
  const filter = useProjectFilter(PROJECT_KEY, all);
  const { project, shown } = filter;

  const bringBack = async (task: HiveTask) => {
    if (busy) return;
    setBusy(task.id);
    try {
      const result = await window.cth.hivePatchTask(task.id, unbacklogPatch());
      if (!result.ok) throw new Error('unbacklog patch failed');
      await refresh();
      await window.cth.hiveSend({
        to: 'god',
        act: 'inform',
        subject: `BACK FROM BACKLOG: "${task.title}"`,
        body: unbacklogMailBody(task.title, task.id)
      }, 'human');
    } catch { /* the card stays shelved, so the user can retry */ }
    setBusy(null);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--cth-paper-200)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--cth-font-mono)' }}>
      <ProjectFilter filter={filter} total={all.length} />
      {shown.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--cth-ink-500)', fontSize: 12 }}>
          {project && all.length > 0 ? translate('backlog.emptyProject', { project }) : translate('backlog.empty')}
        </div>
      )}
      {shown.map((t) => {
        const open = openQuestion(t);
        const description = (t.description ?? '').trim();
        const roots = (text: string) => [...rootsFor(t), ...siblingRoots(rootsFor(t), text)];
        return (
          <div key={t.id} style={{ background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'flex', flexDirection: 'column' }}>
            <CardHeader task={t} assignee={nameFor(t.assignee)} />
            <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {open && (
                <div dir={rtl ? 'auto' : undefined} style={{ fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)' }}>
                  <MarkdownPreview source={open.q} variant="card" roots={roots(open.q)} onOpenFile={openFile} />
                </div>
              )}
              {description && (
                <div dir={rtl ? 'auto' : undefined} style={{
                  fontSize: 15, lineHeight: '19px', color: 'var(--cth-ink-900)',
                  ...(open ? { paddingTop: 8, boxShadow: 'inset 0 1px 0 var(--cth-ink-100)' } : {})
                }}>
                  <MarkdownPreview source={description} variant="card" roots={roots(description)} onOpenFile={openFile} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <PixelButton variant="primary" size="sm" disabled={busy === t.id} onClick={() => void bringBack(t)}>
                  {translate('backlog.bringBack')}
                </PixelButton>
                {shelvedMs(t) > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
                    {translate('backlog.shelvedOn', { date: new Date(shelvedMs(t)).toLocaleDateString() })}
                  </span>
                )}
              </div>
              <StuckList stuck={dependentsTree(t.id, tasks)} nameFor={nameFor} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
