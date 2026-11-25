import { inferAgentProvider, providerPreset } from './agentProvider';

/** A dormant launch recipe's command follows its configured provider; its last session stays historical. */
export function reconcileDormantLaunch(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const a = raw as { provider?: string; command?: string; model?: string };
  const provider = inferAgentProvider(a.command, a.provider);
  const entry = { provider, model: a.model };
  if (!a.command || inferAgentProvider(a.command) === provider) return raw;
  if (entry.provider === 'custom') return raw;
  const preset = providerPreset(entry.provider);
  const model = entry.model ? ` ${preset.modelFlag} ${JSON.stringify(entry.model)}` : '';
  const auto = a.command && /--dangerously-skip-permissions|--permission-mode bypassPermissions|--dangerously-bypass-approvals-and-sandbox/.test(a.command)
    ? ` ${preset.autoFlag}` : '';
  return { ...raw, provider: entry.provider, model: entry.model, command: `${preset.defaultCommand}${model}${auto}` };
}
