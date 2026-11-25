/** The short "Provider · model" label shown on an agent's card and side panel, e.g.
 *  "Codex · gpt-6.2-sol" or "agy · Opus 4.6 Thinking". */
import type { AgentProvider } from './agentProvider';

const PROVIDER_SHORT: Partial<Record<AgentProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'agy',
  grok: 'Grok',
  kimi: 'Kimi',
  gemini: 'Gemini',
  qwen: 'Qwen',
  opencode: 'OpenCode',
  crush: 'Crush',
  pi: 'Pi',
  copilot: 'Copilot',
  cursor: 'Cursor',
  custom: 'Custom'
};

const CLAUDE_FAMILY = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i;

/** A model id or display name with its boilerplate dropped: path prefixes, a leading
 *  "claude"/"Claude " (the family name says it), date stamps, brackets and parens. */
export function shortModelName(model: string | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw) return 'default';
  let m = raw.split('/').pop() ?? raw;
  m = m.replace(/^claude[- ]/i, '').replace(/-\d{8}$/, '');
  const fam = CLAUDE_FAMILY.exec(m);
  if (fam) {
    const name = fam[1][0].toUpperCase() + fam[1].slice(1).toLowerCase();
    m = `${name} ${fam[2]}${fam[3] ? `.${fam[3]}` : ''}${m.slice(fam[0].length)}`;
  }
  return m.replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim() || raw;
}

/** An agent tile's sub-line: the live session's model name alone ("Opus 5.5"), or ''
 *  when there is no session (dormant, between cards) or no model known. */
export function tileModelLine(ptyId: string | undefined, liveModel: string | undefined): string {
  const model = (liveModel ?? '').replace(/\[[^\]]*\]$/, '').trim();
  return ptyId && model ? shortModelName(model) : '';
}

export function agentModelLabel(provider: AgentProvider, model: string | undefined): string {
  return `${PROVIDER_SHORT[provider] ?? provider} · ${shortModelName(model)}`;
}
