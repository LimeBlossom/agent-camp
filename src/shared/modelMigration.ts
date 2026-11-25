import { inferAgentProvider } from './agentProvider';
import { sameEntry, type AgentModelEntry } from './modelBalance';
import { migrateModel } from './modelCatalogCheck';

/** Retired models (modelCatalog.json "retired") move to their successor here, on live
 *  selections when read, never on history.
 *
 *  `--model <old>` / `-m <old>` (optionally quoted or `=`-joined) in an agent command. */
export function migrateModelCommand(command: string | undefined): string | undefined {
  if (!command) return command;
  const provider = inferAgentProvider(command);
  return command.replace(
    /((?:--model|-m)(?:=|\s+))(?:(["'])(.+?)\2|([^\s"']+))(?=\s|$)/g,
    (all, flag: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const model = quoted ?? bare ?? '';
      const next = migrateModel(provider, model);
      if (next === model) return all;
      return quote ? `${flag}${quote}${next}${quote}` : `${flag}${next}`;
    }
  );
}

/** Rungs moved off retired models; a rung that becomes a duplicate of an earlier one is dropped. */
export function migrateModelList<T>(list: T): T {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out: AgentModelEntry[] = [];
  for (const raw of list as unknown[]) {
    const e = raw as AgentModelEntry;
    if (!e || typeof e !== 'object') { out.push(e); continue; }
    const model = migrateModel(e.provider, e.model);
    const next = model === e.model ? e : { ...e, model };
    if (next !== e) changed = true;
    if (out.some((o) => o && typeof o === 'object' && sameEntry(o, next))) { changed = true; continue; }
    out.push(next);
  }
  return (changed ? out : list) as T;
}

/** A saved worker (roster agent or restorable recipe) moved off retired models. */
export function migrateAgentModels<T>(raw: T): T {
  if (!raw || typeof raw !== 'object') return raw;
  const a = raw as { provider?: string; command?: string; model?: string; models?: unknown };
  const model = migrateModel(inferAgentProvider(a.command, a.provider), a.model);
  const command = migrateModelCommand(a.command);
  const models = migrateModelList(a.models);
  if (model === a.model && command === a.command && models === a.models) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (model !== a.model) out.model = model;
  if (command !== a.command) out.command = command;
  if (models !== a.models) out.models = models;
  return out as T;
}
