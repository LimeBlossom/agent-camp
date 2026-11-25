import type { ContextRule } from './triggers';

type ContextReading = {
  isGod?: boolean;
  contextTokens?: number;
  contextLimit?: number;
  model?: string;
};

export function passesContextPressure(a: ContextReading, rule: ContextRule): boolean {
  const used = a.contextTokens;
  const measured = used !== undefined && Number.isFinite(used);
  const absolute = rule.bossMinContextTokens;
  if (a.isGod && absolute !== undefined && Number.isFinite(absolute) && absolute > 0) {
    // An absolute threshold requires a token reading; window-size guesses cannot substitute.
    return measured && used >= absolute;
  }
  const bar = (a.contextLimit ?? 0) >= 500_000 ? rule.minContextPctLargeWindow : rule.minContextPct;
  if (!(bar > 0) || !measured) return true;
  const limit = a.contextLimit && a.contextLimit > 0
    ? a.contextLimit : (/1m/i.test(a.model ?? '') ? 1_000_000 : 200_000);
  return (used / limit) * 100 >= bar;
}
