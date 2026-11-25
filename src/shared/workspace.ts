/** An agent's workspace beyond its cwd: extra folders its sandbox may write, for every
 *  provider that has one (Claude settings.json, Codex --add-dir / writable_roots). */

/** Absolute, de-duplicated folders from user input (one per line or an array); blanks dropped. */
export function cleanExtraDirs(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : [];
  const out = raw
    .filter((d): d is string => typeof d === 'string')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && (d.startsWith('/') || d.startsWith('~') || /^[A-Za-z]:[\\/]/.test(d)));
  return Array.from(new Set(out));
}

/** The extra folders on a registry entry. `extraDirs` wins whenever it is present, even
 *  empty; `codexExtraDirs` is the pre-generic spelling, read only when it is absent. */
export function extraDirsOf(entry: { extraDirs?: unknown; codexExtraDirs?: unknown } | undefined): string[] {
  if (!entry) return [];
  return cleanExtraDirs(Array.isArray(entry.extraDirs) ? entry.extraDirs : entry.codexExtraDirs);
}
