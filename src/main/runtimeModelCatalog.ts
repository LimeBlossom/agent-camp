/**
 * The model catalog as RUNTIME data, re-read from disk on every picker open.
 *
 * Read-only sources:
 *   - `catalogPath`: the repo's own src/shared/modelCatalog.json (under
 *     CAMP_REPO_PATH). It is the same file a build bakes in, so one edit is live
 *     now and baked into the next build, with no second copy to drift.
 *   - `codexModelsPath`: Codex's ~/.codex/models_cache.json. Only `slug` and
 *     `display_name` of rows with `visibility: "list"` are used; a slug the codex
 *     list lacks is appended to it.
 *   - Antigravity’s model listing supplies Gemini slugs when the CLI is available.
 *
 * Returns null for "keep the bundled catalog". Never throws; every unreadable
 * source is reported through `log` and skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isRetiredModel } from '../shared/modelCatalogCheck';
import { CATALOG_SCHEMA_VERSION, parseModelCatalog, type CatalogModel, type ModelCatalog } from '../shared/modelCatalogPayload';

export interface RuntimeCatalogSources {
  baked: { providers: Record<string, unknown> };
  catalogPath?: string | null;
  codexModelsPath?: string | null;
  log: (message: string) => void;
}

/** A Codex slug goes straight onto a `--model` flag, so only slug characters pass. */
const CODEX_SLUG = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;

function readCatalogFile(path: string, log: (m: string) => void): ModelCatalog | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`model catalog ${path} unreadable, using the bundled list: ${(err as Error).message}`);
    return null;
  }
  const catalog = parseModelCatalog(raw);
  if (!catalog) log(`model catalog ${path} is not a version ${CATALOG_SCHEMA_VERSION} catalog, using the bundled list`);
  return catalog;
}

function readCodexModels(path: string, log: (m: string) => void): CatalogModel[] {
  if (!existsSync(path)) return [];
  let models: unknown;
  try {
    models = (JSON.parse(readFileSync(path, 'utf8')) as { models?: unknown })?.models;
  } catch (err) {
    log(`codex models cache ${path} unreadable: ${(err as Error).message}`);
    return [];
  }
  if (!Array.isArray(models)) {
    log(`codex models cache ${path} has no models array`);
    return [];
  }
  const out: CatalogModel[] = [];
  for (const row of models) {
    const r = row as { slug?: unknown; display_name?: unknown; visibility?: unknown } | null;
    if (!r || r.visibility !== 'list' || typeof r.slug !== 'string' || !CODEX_SLUG.test(r.slug) || isRetiredModel('codex', r.slug)) continue;
    out.push({ id: r.slug, label: typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name : r.slug });
  }
  return out;
}

export function loadRuntimeModelCatalog(src: RuntimeCatalogSources, agyOutput?: string): ModelCatalog | null {
  const base = loadDiskCatalog(src);
  return agyOutput === undefined ? base : mergeAgyModels(src, base, agyOutput);
}

function loadDiskCatalog(src: RuntimeCatalogSources): ModelCatalog | null {
  const base = src.catalogPath ? readCatalogFile(src.catalogPath, src.log) : null;
  const extra = src.codexModelsPath ? readCodexModels(src.codexModelsPath, src.log) : [];
  if (!base && extra.length === 0) return null;

  const providers: Record<string, unknown> = { ...(base?.providers ?? {}) };
  if (extra.length > 0) {
    const codex = [...((providers.codex ?? src.baked.providers.codex ?? []) as CatalogModel[])];
    const known = new Set(codex.map((m) => m.id));
    for (const m of extra) if (!known.has(m.id)) { codex.push(m); known.add(m.id); }
    providers.codex = codex;
  }
  return parseModelCatalog({ version: CATALOG_SCHEMA_VERSION, providers });
}

export async function loadRuntimeModelCatalogWithAgy(
  src: RuntimeCatalogSources & { readAgyModels: () => Promise<string> }
): Promise<ModelCatalog | null> {
  let output: string;
  try {
    output = await src.readAgyModels();
  } catch {
    src.log('agy models could not be read, using the catalog list');
    return loadRuntimeModelCatalog(src);
  }
  return loadRuntimeModelCatalog(src, output);
}

function mergeAgyModels(src: RuntimeCatalogSources, base: ModelCatalog | null, output: string): ModelCatalog | null {
  const bakedModels = src.baked.providers.antigravity as CatalogModel[] | undefined;
  const models = [...(base?.providers.antigravity ?? bakedModels ?? [])];
  const known = new Set(models.map((model) => model.id));
  let hasGemini = false;
  for (const line of output.replace(/(?:\r?\n)+$/, '').split(/\r?\n/)) {
    const row = /^([a-z0-9][a-z0-9.-]{0,119})\t([^\x00-\x1f\x7f]+)$/.exec(line);
    if (!row || !row[2].trim()) {
      src.log('agy models returned an invalid listing, using the catalog list');
      return base;
    }
    const [, id, displayName] = row;
    if (!id.startsWith('gemini-')) continue;
    hasGemini = true;
    if (isRetiredModel('antigravity', id)) continue;
    const label = displayName.trim();
    if (known.has(id) || known.has(label)) continue;
    models.push({ id, label });
    known.add(id);
  }
  if (!hasGemini) {
    src.log('agy models returned no Gemini models, using the catalog list');
    return base;
  }

  return parseModelCatalog({
    version: CATALOG_SCHEMA_VERSION,
    providers: { ...base?.providers, antigravity: models }
  });
}
