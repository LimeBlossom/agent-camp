// The cast of the theme currently on the floor, for code outside the scene
// (pickers, portraits, name inference) that used to assume the Office cast.
import { useStore } from '@/store/store';
import { getTheme, type ThemeCast } from './themeRegistry';

export const activeCast = (): ThemeCast => getTheme(useStore.getState().officeTheme).cast;

export const useActiveCast = (): ThemeCast => getTheme(useStore((s) => s.officeTheme)).cast;

// The orchestrator is always the active theme's boss. Its stored character is
// what every card and portrait reads, so keep it in step with theme switches and
// with a roster restored from a session run under another theme.
useStore.subscribe((s) => {
  const god = s.agents.find((a) => a.isGod);
  if (!god) return;
  const boss = getTheme(s.officeTheme).cast.bossCharacter;
  if (god.character !== boss) s.updateAgent(god.id, { character: boss });
});
