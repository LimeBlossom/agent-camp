/** Which models are current, what a retired one became, and what each is good at.
 *  All three come from modelCatalog.json ("retired", "speciality"), so retiring or
 *  describing a model is a data edit. Retirement is per provider: a Cursor slug that
 *  looks like a retired Codex one is Cursor's own. */
import catalog from './modelCatalog.json';

interface Speciality { strengths: string; weaknesses?: string; source: string }
interface CatalogData {
  retired: Record<string, Record<string, string>>;
  speciality: Record<string, Speciality>;
  providers: Record<string, { id?: string }[]>;
}
const DATA = catalog as unknown as CatalogData;

const ONE_M = '[1m]';
const EFFORT = /-(xhigh|high|medium|low)$/;

/** agy accepts both `Gemini 4 Argon (Medium)` and `gemini-4-argon-medium`; compare in slug form. */
function slugForm(id: string): string {
  const s = id.trim();
  if (!/[ ()]/.test(s)) return s.toLowerCase();
  return s.toLowerCase().replace(/\s*\(([^)]*)\)\s*/g, '-$1').replace(/\s+/g, '-').replace(/-+$/, '');
}

interface Parts { family: string; effort?: string; oneM: boolean; label: boolean }

function parts(id: string): Parts {
  let s = id.trim();
  const oneM = s.endsWith(ONE_M);
  if (oneM) s = s.slice(0, -ONE_M.length);
  const label = /[ ()]/.test(s);
  s = slugForm(s);
  const m = EFFORT.exec(s);
  return m ? { family: s.slice(0, m.index), effort: m[1], oneM, label } : { family: s, oneM, label };
}

/** The model without its effort level, 1M window or agy display-name form. */
export function modelFamily(id: string): string {
  return parts(id).family;
}

function retiredFor(provider: string): Record<string, string> | undefined {
  return Object.prototype.hasOwnProperty.call(DATA.retired, provider) ? DATA.retired[provider] : undefined;
}

export function isRetiredModel(provider: string, model: string | undefined): boolean {
  const map = retiredFor(provider);
  return !!model && !!map && Object.prototype.hasOwnProperty.call(map, parts(model).family);
}

function catalogRow(provider: string, id: string): string | undefined {
  const want = slugForm(id);
  return (DATA.providers[provider] ?? []).find((m) => m.id !== undefined && slugForm(m.id) === want)?.id;
}

export function isCatalogModel(provider: string, model: string): boolean {
  return catalogRow(provider, model) !== undefined;
}

/** A retired model's current successor, keeping its effort, 1M window and form where the
 *  catalog offers them; anything else is returned unchanged. */
export function migrateModel(provider: string, model: string | undefined): string | undefined {
  if (!model || !isRetiredModel(provider, model)) return model;
  const p = parts(model);
  const next = retiredFor(provider)![p.family];
  const slug = p.effort ? `${next}-${p.effort}` : next;
  const base = p.label ? catalogRow(provider, slug) ?? slug : slug;
  return p.oneM && catalogRow(provider, `${base}${ONE_M}`) ? `${base}${ONE_M}` : base;
}

/** A model named on a spawn: its successor when retired, and a note either way when it
 *  is not a current catalog model of a provider whose list is checked. */
export function resolveNamedModel(provider: string, model: string | undefined): { model: string | undefined; note?: string } {
  if (!model) return { model };
  const next = migrateModel(provider, model);
  if (next !== model) return { model: next, note: `named model "${model}" is retired; running its successor ${next}` };
  if (retiredFor(provider) && !isCatalogModel(provider, model)) return { model, note: `named model "${model}" is not in the model catalog` };
  return { model };
}

function warning(what: string, provider: string, model: string): string | null {
  if (isRetiredModel(provider, model)) return `${what} is retired; its successor is ${migrateModel(provider, model)}`;
  if (retiredFor(provider) && !isCatalogModel(provider, model)) return `${what} is not in the model catalog`;
  return null;
}

interface CheckedConfig {
  defaultModel?: string;
  godProvider?: string;
  godModel?: string;
  modelTiers?: Record<string, { provider: string; model?: string }[] | undefined>;
}

/** One line per saved model selection that is retired or not in the catalog. */
export function modelCatalogWarnings(cfg: CheckedConfig): string[] {
  const out: (string | null)[] = [];
  // defaultModel is a Claude model id (it only ever marks a Claude picker row).
  if (cfg.defaultModel) out.push(warning(`defaultModel "${cfg.defaultModel}"`, 'claude', cfg.defaultModel));
  if (cfg.godModel) out.push(warning(`godModel "${cfg.godModel}"`, cfg.godProvider ?? 'claude', cfg.godModel));
  for (const [tier, list] of Object.entries(cfg.modelTiers ?? {})) {
    for (const e of Array.isArray(list) ? list : []) {
      if (e?.model) out.push(warning(`${tier} tier entry ${e.provider}/${e.model}`, e.provider, e.model));
    }
  }
  return out.filter((w): w is string => w !== null);
}

export function modelSpeciality(_provider: string, model: string | undefined): Speciality | null {
  if (!model) return null;
  const fam = modelFamily(model);
  return Object.prototype.hasOwnProperty.call(DATA.speciality, fam) ? DATA.speciality[fam] : null;
}

/** The picker tooltip for a model, or undefined when nothing is recorded. */
export function specialityText(provider: string, model: string | undefined): string | undefined {
  const s = modelSpeciality(provider, model);
  if (!s) return undefined;
  return [`Good at: ${s.strengths}`, s.weaknesses ? `Weak at: ${s.weaknesses}` : null, `Source: ${s.source}`].filter(Boolean).join('\n');
}
