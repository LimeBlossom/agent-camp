/** agy's reset wording, shared by main (engine choice) and the title-bar chip. */

/** "Refreshes in 72h 46m" as milliseconds; 0 for "Quota available"; undefined otherwise. */
export function refreshInMs(note: string | undefined): number | undefined {
  if (!note) return undefined;
  if (/^Quota available$/i.test(note)) return 0;
  const m = /^Refreshes in (.+)$/i.exec(note);
  return m ? durationMs(m[1]) : undefined;
}

/** "72h 46m", "4h16m24s", "1d 2h" as milliseconds; undefined when no unit is found. */
export function durationMs(text: string): number | undefined {
  let ms = 0;
  let any = false;
  for (const [, n, unit] of text.matchAll(/(\d+)\s*([dhms])(?![a-z])/gi)) {
    any = true;
    ms += Number(n) * ({ d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 } as Record<string, number>)[unit.toLowerCase()];
  }
  return any ? ms : undefined;
}
