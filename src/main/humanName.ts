/**
 * How card notes name the person who answers ASK ME: "the human", or the name in config
 * `humanName`. The app exports that name as MD_HUMAN_NAME so the Camp MCP servers match
 * the same notes.
 */
type Env = Record<string, string | undefined>;

export function exportHumanName(cfg: { humanName?: string | null }, env: Env = process.env): void {
  const name = cfg.humanName?.trim();
  if (name) env.MD_HUMAN_NAME = name;
  else delete env.MD_HUMAN_NAME;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source (no groups to capture) matching any word for the human in a note. */
export function humanWords(env: Env = process.env): string {
  const name = env.MD_HUMAN_NAME?.trim();
  return name ? `(?:(?:the\\s+)?human|${escape(name).replace(/\s+/g, '\\s+')})` : '(?:(?:the\\s+)?human)';
}
