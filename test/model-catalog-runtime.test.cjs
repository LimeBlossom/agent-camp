'use strict';

/**
 * The RUNTIME model catalog: the copy main reads from disk on every picker open,
 * so a model added to the repo's catalog file or to Codex's own models cache
 * reaches the running app with no rebuild and no restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const baked = require('../src/shared/modelCatalog.json');

const { loadRuntimeModelCatalog } = loadTs('src/main/runtimeModelCatalog.ts');
const { applyRemoteModelCatalog, modelsForProvider, refreshModelCatalog } =
  loadTs('src/renderer/src/store/config.ts');

const BAKED_CODEX = modelsForProvider('codex');

test.afterEach(() => {
  applyRemoteModelCatalog(null);
  delete globalThis.cth;
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'camp-catalog-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function codexIds() {
  return modelsForProvider('codex').map((m) => m.id);
}

test('a model added to the catalog file reaches the picker on the next refresh, same module instance', async () => {
  const dir = tmpDir();
  const catalogPath = path.join(dir, 'modelCatalog.json');
  writeJson(catalogPath, baked);
  const errors = [];
  globalThis.cth = {
    modelCatalog: async () => ({
      catalog: loadRuntimeModelCatalog({ baked, catalogPath, log: (m) => errors.push(m) }),
      fetchedAt: 0,
      stale: false
    })
  };

  await refreshModelCatalog();
  assert.ok(!codexIds().includes('gpt-7-nova'));

  const edited = JSON.parse(JSON.stringify(baked));
  edited.providers.codex.push({ id: 'gpt-7-nova', label: 'GPT-7 Nova' });
  writeJson(catalogPath, edited);

  assert.equal(await refreshModelCatalog(), true);
  assert.ok(codexIds().includes('gpt-7-nova'));
  assert.deepEqual(errors, []);
});

test('a model only Codex knows about is appended to the codex list from its models cache', async () => {
  const dir = tmpDir();
  const codexModelsPath = path.join(dir, 'models_cache.json');
  writeJson(codexModelsPath, {
    models: [
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
      { slug: 'gpt-7-nova', display_name: 'GPT-7-Nova', visibility: 'list' },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
      { slug: 'bad slug\n--yolo', display_name: 'Evil', visibility: 'list' }
    ]
  });
  const catalog = loadRuntimeModelCatalog({ baked, codexModelsPath, log: () => {} });
  applyRemoteModelCatalog(catalog);

  const ids = codexIds();
  assert.ok(ids.includes('gpt-7-nova'), 'listed cache model appended');
  assert.ok(!ids.includes('codex-auto-review'), 'hidden cache model skipped');
  assert.ok(!ids.some((id) => id && /\s/.test(id)), 'non-slug ids never reach a --model flag');
  assert.equal(ids.filter((id) => id === 'gpt-6.2-sol').length, 1, 'catalog row wins, no duplicate');
  assert.equal(modelsForProvider('codex').find((m) => m.id === 'gpt-7-nova').label, 'GPT-7-Nova');
});

test('a missing catalog file falls back to the bundled list and logs an error', () => {
  const errors = [];
  const catalog = loadRuntimeModelCatalog({
    baked,
    catalogPath: path.join(tmpDir(), 'nope.json'),
    log: (m) => errors.push(m)
  });
  applyRemoteModelCatalog(catalog);
  assert.deepEqual(modelsForProvider('codex'), BAKED_CODEX);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /nope\.json/);
});

test('a malformed catalog file falls back to the bundled list and logs an error', () => {
  for (const body of ['{ not json', JSON.stringify({ version: 99, providers: {} })]) {
    const catalogPath = path.join(tmpDir(), 'modelCatalog.json');
    writeJson(catalogPath, body);
    const errors = [];
    applyRemoteModelCatalog(loadRuntimeModelCatalog({ baked, catalogPath, log: (m) => errors.push(m) }));
    assert.deepEqual(modelsForProvider('codex'), BAKED_CODEX);
    assert.equal(errors.length, 1, body);
  }
});

test('a missing Codex models cache is silent (no Codex installed); a malformed one is logged', () => {
  for (const body of [null, '{ not json', JSON.stringify({ models: 'x' })]) {
    const codexModelsPath = path.join(tmpDir(), 'models_cache.json');
    if (body !== null) writeJson(codexModelsPath, body);
    const errors = [];
    applyRemoteModelCatalog(loadRuntimeModelCatalog({ baked, codexModelsPath, log: (m) => errors.push(m) }));
    assert.deepEqual(modelsForProvider('codex'), BAKED_CODEX);
    assert.equal(errors.length, body === null ? 0 : 1, String(body));
  }
});


test('an Antigravity model appears on reopen and existing display-name IDs stay unique', async () => {
  const { loadRuntimeModelCatalogWithAgy } = loadTs('src/main/runtimeModelCatalog.ts');
  const errors = [];
  let output = 'gemini-4-argon-medium\tGemini 4 Argon (Medium)\r\n';
  globalThis.cth = {
    modelCatalog: async () => ({
      catalog: await loadRuntimeModelCatalogWithAgy({
        baked, readAgyModels: async () => output, log: (m) => errors.push(m)
      }),
      fetchedAt: 0,
      stale: false
    })
  };
  const models = () => modelsForProvider('antigravity');

  await refreshModelCatalog();
  assert.ok(!models().some((m) => m.id === 'gemini-4-future-xhigh'));
  output += 'gemini-4-future-xhigh\tGemini 4 Future (XHigh)\r\n';
  await refreshModelCatalog();
  assert.deepEqual(models().find((m) => m.id === 'gemini-4-future-xhigh'), {
    id: 'gemini-4-future-xhigh', label: 'Gemini 4 Future (XHigh)'
  });
  const switchCatalog = loadRuntimeModelCatalog({ baked, log: (m) => errors.push(m) }, output);
  assert.deepEqual(switchCatalog.providers.antigravity.map((m) => m.id), models().map((m) => m.id));
  assert.ok(models().some((m) => m.id === 'Gemini 4 Argon (Medium)'));
  assert.ok(!models().some((m) => m.id === 'gemini-4-argon-medium'));
  assert.deepEqual(errors, []);

  output += 'invalid line\n';
  await refreshModelCatalog();
  assert.ok(!models().some((m) => m.id === 'gemini-4-future-xhigh'));
  assert.equal(errors.length, 1);
});

test('Antigravity list failures log an error and preserve the disk catalog and Codex cache', async () => {
  const { loadRuntimeModelCatalogWithAgy } = loadTs('src/main/runtimeModelCatalog.ts');
  const dir = tmpDir();
  const catalogPath = path.join(dir, 'modelCatalog.json');
  const codexModelsPath = path.join(dir, 'models_cache.json');
  writeJson(catalogPath, {
    version: 1, providers: { antigravity: [{ id: 'gemini-4-local-high', label: 'Local Gemini' }] }
  });
  writeJson(codexModelsPath, {
    models: [{ slug: 'gpt-7-nova', display_name: 'GPT-7 Nova', visibility: 'list' }]
  });
  const readers = [
    async () => '',
    async () => 'unknown-model\tUnknown Model\n',
    async () => '{"models":[]}',
    async () => 'gemini-4-test-high\tGemini Test\t--effort\n',
    async () => { throw new Error('process timed out'); }
  ];
  for (const readAgyModels of readers) {
    const errors = [];
    applyRemoteModelCatalog(await loadRuntimeModelCatalogWithAgy({
      baked, catalogPath, codexModelsPath, readAgyModels, log: (m) => errors.push(m)
    }));
    assert.deepEqual(modelsForProvider('antigravity'), [{ id: 'gemini-4-local-high', label: 'Local Gemini' }]);
    assert.ok(codexIds().includes('gpt-7-nova'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /agy models/i);
  }
});
