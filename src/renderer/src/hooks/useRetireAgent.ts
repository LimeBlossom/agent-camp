import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { openCardsFor } from '@shared/agentArchive';

/** Retire a dormant agent: one confirm flow shared by the Command Center
 *  "not started" list and the dormant agent's detail header. */

export interface RetireAgentTarget {
  id: string;
  name: string;
}

export interface RetireAgentDeps {
  t: (key: string, options?: Record<string, unknown>) => string;
  confirm: (message: string) => boolean;
  hiveTasks: () => Promise<unknown>;
  hiveSetArchived: (id: string, archived: boolean) => Promise<unknown>;
  archiveAgent: (id: string) => void;
}

/** Resolves true when the agent was retired, false when the user cancelled. */
export async function retireAgent(target: RetireAgentTarget, deps: RetireAgentDeps): Promise<boolean> {
  let open: string[] = [];
  try {
    open = openCardsFor(target.id, ((await deps.hiveTasks()) as { tasks?: [] } | null)?.tasks);
  } catch { /* confirm without the card list */ }
  const prompt = open.length
    ? deps.t('commandCenter.retireConfirmOpenCards', { name: target.name, cards: open.join(', ') })
    : deps.t('commandCenter.retireConfirm', { name: target.name });
  if (!deps.confirm(prompt)) return false;
  await deps.hiveSetArchived(target.id, true);
  // Updating the store now moves or clears the selection without waiting for the next hive snapshot.
  deps.archiveAgent(target.id);
  return true;
}

export function useRetireAgent(): { retire: (target: RetireAgentTarget) => Promise<boolean> } {
  const { t } = useTranslation();
  const archiveAgent = useStore((s) => s.archiveAgent);
  const retire = useCallback((target: RetireAgentTarget) => retireAgent(target, {
    t: (key, options) => t(key, options) as string,
    confirm: (message) => window.confirm(message),
    hiveTasks: () => window.cth.hiveTasks(),
    hiveSetArchived: (id, archived) => window.cth.hiveSetArchived(id, archived),
    archiveAgent
  }), [t, archiveAgent]);
  return { retire };
}
