// The app's name and logo. Neutral by default; an installed theme pack with a
// `branding` block replaces them (scene/office/themePacks.ts sets it at startup).
import defaultLogo from '@brand/logo.png?url';
import { DEFAULT_APP_TITLE } from '@shared/themePack';

export interface Branding {
  title: string;
  logo: string;
}

export const DEFAULT_BRANDING: Readonly<Branding> = Object.freeze({ title: DEFAULT_APP_TITLE, logo: defaultLogo });

let current: Branding = DEFAULT_BRANDING;
const listeners = new Set<(b: Branding) => void>();

export function branding(): Branding {
  return current;
}

/** Null restores the default branding. */
export function setBranding(next: Branding | null): void {
  current = next ?? DEFAULT_BRANDING;
  for (const fn of listeners) fn(current);
}

export function onBrandingChange(fn: (b: Branding) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
