import { useCallback, useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { desktopView } from '@/desktop/view';
import { isExternalMediaPath } from '@shared/fileOpenRoute';
import { openMediaExternally, showMediaNotice } from '@/media/openMedia';
import type { HiveTask } from './TasksKanban';

/** The folders a card's files resolve under, and how a clicked file opens. Shared by ASK ME, Backlog and the task detail. */
export function useCardFiles() {
  const agents = useStore((s) => s.agents);
  // Workspaces a question may show files from: each asker's cwd is added per
  // card; these are the registered repos and the hive itself.
  const [baseRoots, setBaseRoots] = useState<string[]>([]);
  useEffect(() => {
    void Promise.all([window.cth.getConfig(), window.cth.homeDir().catch(() => '')])
      // `<home>/hive` is listed before `<home>` because agents write paths relative to the hive.
      // The user's home folder goes last, so a path an agent cites outside every
      // workspace (another tool's README, say) is still clickable.
      .then(([c, home]) => setBaseRoots([
        ...(c.registeredRepos ?? []),
        ...(c.harnessHome ? [`${c.harnessHome}/hive`, c.harnessHome] : []),
        ...(home ? [home] : [])
      ]))
      .catch(() => setBaseRoots([]));
  }, []);
  const rootsFor = (task: HiveTask): string[] => {
    const cwd = task.assignee ? agents.find((a) => a.id === task.assignee)?.cwd : undefined;
    return [...new Set([...(cwd ? [cwd] : []), ...baseRoots])];
  };
  // A backticked file path in a question: the first candidate that exists opens.
  // Main sends allowlisted types (media, documents, images, HTML) to the system app
  // (route fileOpenRoute); the rest open in the IDE when an agent's workspace holds them,
  // else are revealed. The desktop pop-up has no IDE, so it reveals those.
  const openFile = useCallback(async (candidates: string[]) => {
    for (const c of candidates) {
      const st = await window.cth.statAbs(c).catch(() => null);
      if (!st?.exists) continue;
      if (!st.isFile) { void window.cth.revealPath(st.path); return; }
      if (isExternalMediaPath(st.path)) { void openMediaExternally(st.path); return; }
      const r = await window.cth.openCardFile(st.path).catch(() => null);
      if (r?.ok && r.route !== 'viewer') return;
      const owned = useStore.getState().agents.some((a) => st.path === a.cwd || st.path.startsWith(a.cwd + '/'));
      if (r?.ok && owned && !desktopView) useStore.getState().openFileInIde(st.path);
      else void window.cth.revealPath(st.path);
      return;
    }
    if (candidates.some(isExternalMediaPath)) showMediaNotice(`Could not open: not found (${candidates[0]})`);
  }, []);
  return { rootsFor, openFile };
}
