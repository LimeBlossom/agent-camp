import type { CSSProperties } from 'react';

/** Compact reset-credit expiry shared by the Claude and Codex title-bar chips. */
export function formatResetUseBy(expiresAt: number | undefined): string {
  if (!expiresAt) return '';
  const date = new Date(expiresAt * 1000);
  return `use by ${date.getMonth() + 1}/${date.getDate()}`;
}

/** The shared box around each provider's usage readout in the title bar, so the Claude,
 *  Codex and agy groups read as separate items rather than one run of numbers. */
export const usageChipStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 8px',
  borderRadius: 3,
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
};
