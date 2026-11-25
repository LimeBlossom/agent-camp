'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts tests
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-reload-userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userDataDir } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { writeConfig, readConfig, startConfigWatcher } = loadTs('src/main/config.ts');
const { startRosterWatcher } = loadTs('src/main/roster.ts');

test.after(() => rmTree(userDataDir));

function tmpHive(prefix = 'md-camp-reload-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const hiveRoot = path.join(dir, 'hive');
  return {
    dir,
    hiveRoot,
    hive: new HiveManager(() => dir)
  };
}

function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0, 'the hive prompt must be on argv');
  return inj.args[i + 1];
}

// ─── Item 1: Camp MCP Server outside path + fallback ──────────────────────────

test('Item 1: camp MCP server points to outside script when set via env var CAMP_MCP_SERVER_PATH', async (t) => {
  const { dir, hive } = tmpHive();
  t.after(() => rmTree(dir));

  const extScript = path.join(dir, 'external-camp-server.js');
  fs.writeFileSync(extScript, '// custom camp tools implementation\n', 'utf8');

  const oldEnv = process.env.CAMP_MCP_SERVER_PATH;
  process.env.CAMP_MCP_SERVER_PATH = extScript;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.CAMP_MCP_SERVER_PATH;
    else process.env.CAMP_MCP_SERVER_PATH = oldEnv;
  });

  const inj = await hive.ensureAgent(
    { id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: dir },
    {}
  );
  assert.ok(inj);

  const mcpJsonPath = path.join(dir, 'hive', 'agents', 'god', 'mcp.json');
  assert.ok(fs.existsSync(mcpJsonPath), 'mcp.json must be written for God agent');
  const mcpCfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));

  assert.ok(mcpCfg.mcpServers?.camp, 'camp MCP server must be present in mcp.json');
  assert.equal(
    mcpCfg.mcpServers.camp.args[0],
    extScript,
    'camp MCP server script must point to outside script from CAMP_MCP_SERVER_PATH'
  );
  assert.equal(
    hive.campMcpServerScript(),
    extScript,
    'hive.campMcpServerScript() must resolve to external script path'
  );
});

test('Item 1: camp MCP server falls back to bundled script when outside path from env var does not exist', async (t) => {
  const { dir, hive } = tmpHive();
  t.after(() => rmTree(dir));

  const missingScript = path.join(dir, 'nonexistent-camp-server.js');
  const oldEnv = process.env.CAMP_MCP_SERVER_PATH;
  process.env.CAMP_MCP_SERVER_PATH = missingScript;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.CAMP_MCP_SERVER_PATH;
    else process.env.CAMP_MCP_SERVER_PATH = oldEnv;
  });

  const resolved = hive.campMcpServerScript();
  assert.ok(
    resolved.endsWith('campMcpServer.js'),
    `missing outside file must fall back to bundled campMcpServer.js, got ${resolved}`
  );
  assert.notEqual(resolved, missingScript, 'must not point to missing outside file');

  const inj = await hive.ensureAgent(
    { id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: dir },
    {}
  );
  const mcpJsonPath = path.join(dir, 'hive', 'agents', 'god', 'mcp.json');
  const mcpCfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  assert.ok(
    mcpCfg.mcpServers.camp.args[0].endsWith('campMcpServer.js'),
    'mcp.json must fall back to bundled script when outside path does not exist'
  );
});

test('Item 1: camp MCP server points to outside script when set via hive config / options', async (t) => {
  const { dir, hive } = tmpHive();
  t.after(() => rmTree(dir));

  const extScript = path.join(dir, 'config-camp-server.js');
  fs.writeFileSync(extScript, '// config-specified camp tools\n', 'utf8');

  hive.setCampMcpServerPath(extScript);
  assert.equal(hive.campMcpServerScript(), extScript);

  await hive.ensureAgent(
    { id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: dir },
    { campMcpServerPath: extScript }
  );

  const mcpJsonPath = path.join(dir, 'hive', 'agents', 'god', 'mcp.json');
  const mcpCfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
  assert.equal(
    mcpCfg.mcpServers.camp.args[0],
    extScript,
    'mcp.json must point to script configured in options / HiveManager'
  );
});

test('Item 1: camp MCP server falls back to bundled script when config path does not exist', async (t) => {
  const { dir, hive } = tmpHive();
  t.after(() => rmTree(dir));

  const missing = path.join(dir, 'nonexistent-from-config.js');
  hive.setCampMcpServerPath(missing);

  const resolved = hive.campMcpServerScript(missing);
  assert.ok(
    resolved.endsWith('campMcpServer.js'),
    'missing config path must fall back to bundled campMcpServer.js'
  );
});

// ─── Item 2: Injected prompt template loads from <hive>/prompts/ ─────────────

test('Item 2: injected prompt loads custom worker template from <hive>/prompts/ when file exists', async (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));

  hive.ensureHive();
  const promptsDir = path.join(hiveRoot, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });

  const customWorkerPrompt = '# CUSTOM WORKER TEMPLATE FROM DISK\n\nYou are a specialist worker.\nRules:\n1. Strict TDD first.\n';
  fs.writeFileSync(path.join(promptsDir, 'worker.md'), customWorkerPrompt, 'utf8');

  const inj = await hive.ensureAgent(
    { id: 'worker-tdd', name: 'Elm', isGod: false, provider: 'claude', cwd: dir },
    {}
  );

  const prompt = promptOf(inj);
  assert.ok(
    prompt.includes('CUSTOM WORKER TEMPLATE FROM DISK'),
    'injected prompt must load template text from <hive>/prompts/worker.md'
  );
});

test('Item 2: injected prompt loads custom boss template from <hive>/prompts/ when file exists', async (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));

  hive.ensureHive();
  const promptsDir = path.join(hiveRoot, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });

  const customBossPrompt = '# CUSTOM BOSS ORCHESTRATION PROTOCOL\n\nOrchestrate autonomously.\n';
  fs.writeFileSync(path.join(promptsDir, 'boss.md'), customBossPrompt, 'utf8');

  const inj = await hive.ensureAgent(
    { id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: dir },
    {}
  );

  const prompt = promptOf(inj);
  assert.ok(
    prompt.includes('CUSTOM BOSS ORCHESTRATION PROTOCOL'),
    'injected prompt must load template text from <hive>/prompts/boss.md'
  );
});

test('Item 2: injected prompt falls back to bundled template when <hive>/prompts/ file is missing', async (t) => {
  const { dir, hive } = tmpHive();
  t.after(() => rmTree(dir));

  // No prompts folder or file created
  const inj = await hive.ensureAgent(
    { id: 'worker-fallback', name: 'Worker', isGod: false, provider: 'claude', cwd: dir },
    {}
  );

  const prompt = promptOf(inj);
  assert.ok(
    prompt.includes('HIVE PROTOCOL: follow it every task.'),
    'must fall back to bundled system prompt when outside prompts are missing'
  );
  assert.ok(
    prompt.includes('You are "Worker" (worker-fallback)'),
    'must contain agent identity from bundled template'
  );
});

// ─── Item 3: PROTOCOL*.md and COMMANDS.md overwrite protection ────────────────

test('Item 3: ensureHive writes bundled PROTOCOL.md, PROTOCOL-BOSS.md, and COMMANDS.md when missing', (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));

  hive.ensureHive();

  assert.ok(fs.existsSync(path.join(hiveRoot, 'PROTOCOL.md')), 'PROTOCOL.md must exist on fresh hive');
  assert.ok(fs.existsSync(path.join(hiveRoot, 'PROTOCOL-BOSS.md')), 'PROTOCOL-BOSS.md must exist on fresh hive');
  assert.ok(fs.existsSync(path.join(hiveRoot, 'COMMANDS.md')), 'COMMANDS.md must exist on fresh hive');
});

test('Item 3: ensureHive keeps and logs edited protocols with recorded bundle hashes', async (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));

  hive.ensureHive();

  const protocolPath = path.join(hiveRoot, 'PROTOCOL.md');
  const protocolBossPath = path.join(hiveRoot, 'PROTOCOL-BOSS.md');
  const commandsPath = path.join(hiveRoot, 'COMMANDS.md');

  // User/agent customizes files on disk
  const customProtocol = fs.readFileSync(protocolPath, 'utf8') + '\n\n## Custom User Rule\nNever bypass typecheck.';
  const customBoss = fs.readFileSync(protocolBossPath, 'utf8') + '\n\n## Custom Boss Rule\nTDD step must run first.';
  const customCommands = fs.readFileSync(commandsPath, 'utf8') + '\n\n## Local Custom Command\n/camp-reload';

  fs.writeFileSync(protocolPath, customProtocol, 'utf8');
  fs.writeFileSync(protocolBossPath, customBoss, 'utf8');
  fs.writeFileSync(commandsPath, customCommands, 'utf8');

  // Re-run ensureHive (e.g. at app start or before agent spawn)
  hive.ensureHive();

  assert.equal(
    fs.readFileSync(protocolPath, 'utf8'),
    customProtocol,
    'ensureHive must not overwrite an edited PROTOCOL.md'
  );
  assert.equal(
    fs.readFileSync(protocolBossPath, 'utf8'),
    customBoss,
    'ensureHive must not overwrite an edited PROTOCOL-BOSS.md'
  );
  assert.equal(
    fs.readFileSync(commandsPath, 'utf8'),
    customCommands,
    'ensureHive must not overwrite an edited COMMANDS.md'
  );
  await hive.flushWrites();
  const kept = fs.readFileSync(path.join(hiveRoot, 'log.jsonl'), 'utf8').trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter((event) => event.kind === 'protocol-file-kept');
  assert.deepEqual(kept.map((event) => event.file).sort(), ['COMMANDS.md', 'PROTOCOL-BOSS.md', 'PROTOCOL.md']);
});

// ─── Item 4: fs.watch on config.json (debounce + bad JSON survival) ───────────

test('Item 4: readConfig survives bad-JSON config edit on disk by keeping last good config', () => {
  const configPath = path.join(userDataDir, 'config.json');

  // Seed a valid known config
  writeConfig({
    harnessHome: '/valid/hive/path',
    autoMode: true,
    notifications: true
  });

  const good = readConfig();
  assert.equal(good.harnessHome, '/valid/hive/path');
  assert.equal(good.autoMode, true);

  // Simulate an external editor or tool corrupting config.json with broken syntax
  fs.writeFileSync(configPath, '{\n  "harnessHome": "/corrupt",\n  "autoMode": ', 'utf8');

  const afterCorrupt = readConfig();
  assert.equal(
    afterCorrupt.harnessHome,
    '/valid/hive/path',
    'readConfig must preserve last good harnessHome on bad JSON, not reset to null/defaults'
  );
  assert.equal(
    afterCorrupt.autoMode,
    true,
    'readConfig must preserve last good autoMode on bad JSON'
  );
});

test('Item 4: config watcher debounces rapid writes to config.json and reloads once', async (t) => {
  const configPath = path.join(userDataDir, 'config.json');
  let reloads = 0;
  let lastReloadedConfig = null;
  let onReloaded;
  const reloaded = new Promise((resolve) => {
    onReloaded = resolve;
  });

  writeConfig({ autoMode: false });

  const watcher = startConfigWatcher({
    debounceMs: 50,
    onReload: (cfg) => {
      reloads++;
      lastReloadedConfig = cfg;
      onReloaded();
    }
  });
  t.after(() => watcher.close());

  // Rapidly write 5 times to simulate atomic saves or multiple edit events
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ autoMode: i % 2 === 0, harnessHome: `/hive/v${i}`, snapshotDefaultsCleanedV1: true }),
      'utf8'
    );
  }

  // Await the debounced reload callback event directly instead of an arbitrary wall-clock sleep
  await reloaded;

  // Brief quiet window past debounceMs to verify no trailing duplicate reload fires
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(
    reloads,
    1,
    `expected exactly 1 debounced reload callback, got ${reloads}`
  );
  assert.equal(
    lastReloadedConfig?.harnessHome,
    '/hive/v5',
    'debounced reload should deliver final persisted state'
  );
});

test('Item 4: config watcher survives bad JSON without crashing and keeps last good config', async (t) => {
  const configPath = path.join(userDataDir, 'config.json');
  let reloads = 0;

  writeConfig({ harnessHome: '/safe/home', autoMode: true });

  const watcher = startConfigWatcher({
    debounceMs: 50,
    onReload: () => { reloads++; }
  });
  t.after(() => watcher.close());

  // Corrupt file on disk
  fs.writeFileSync(configPath, 'INVALID_JSON_HERE{{{', 'utf8');

  // Wait for watcher to react
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Assert it did not throw/crash and readConfig retains safe config
  const current = readConfig();
  assert.equal(current.harnessHome, '/safe/home');
});

// ─── Item 5: fs.watch on roster.json and registry.json pushes roster:changed ──

async function waitUntil(cond, ms = 10000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

test('Item 5: roster watcher notifies when roster.json is modified on disk', async (t) => {
  const { dir } = tmpHive();
  t.after(() => rmTree(dir));

  const rosterPath = path.join(dir, 'roster.json');
  fs.writeFileSync(rosterPath, JSON.stringify({ agents: [], archived: [] }), 'utf8');

  const events = [];
  const watcher = startRosterWatcher(dir, (evt) => events.push(evt), { debounceMs: 50 });
  t.after(() => watcher.close());

  // Modify roster.json on disk
  fs.writeFileSync(
    rosterPath,
    JSON.stringify({ agents: [{ id: 'agent-1', name: 'Added On Disk' }], archived: [] }),
    'utf8'
  );

  await waitUntil(() => events.some((e) => e.source === 'roster'));

  assert.ok(events.length >= 1, 'roster watcher must emit when roster.json is modified');
  const rosterEvt = events.find((e) => e.source === 'roster');
  assert.ok(rosterEvt, 'emitted event must have source: "roster"');
});

test('Item 5: roster watcher notifies when hive/registry.json is modified on disk', async (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));

  hive.ensureHive();
  const registryPath = path.join(hiveRoot, 'registry.json');

  const events = [];
  const watcher = startRosterWatcher(dir, (evt) => events.push(evt), { debounceMs: 50 });
  t.after(() => watcher.close());

  // Modify registry.json on disk
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  reg.agents['external-agent'] = { id: 'external-agent', name: 'External' };
  fs.writeFileSync(registryPath, JSON.stringify(reg), 'utf8');

  await waitUntil(() => events.some((e) => e.source === 'registry'));

  assert.ok(events.length >= 1, 'roster watcher must emit when registry.json is modified');
  const regEvt = events.find((e) => e.source === 'registry');
  assert.ok(regEvt, 'emitted event must have source: "registry"');
});

test('protocol upgrade replaces unchanged previous bundles and files without recorded hashes', (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));
  hive.ensureHive();
  const protocol = path.join(hiveRoot, 'PROTOCOL.md');
  const bundled = fs.readFileSync(protocol, 'utf8');
  const hashPath = path.join(hiveRoot, '.bundled-protocol-hashes.json');
  const hashes = JSON.parse(fs.readFileSync(hashPath, 'utf8'));
  const oldBundle = 'an older bundled protocol';
  fs.writeFileSync(protocol, oldBundle);
  hashes['PROTOCOL.md'] = require('node:crypto').createHash('sha256').update(oldBundle).digest('hex');
  fs.writeFileSync(hashPath, JSON.stringify(hashes));
  hive.ensureHive();
  assert.equal(fs.readFileSync(protocol, 'utf8'), bundled);
  fs.unlinkSync(hashPath);
  for (const name of ['PROTOCOL.md', 'PROTOCOL-BOSS.md', 'COMMANDS.md']) {
    fs.writeFileSync(path.join(hiveRoot, name), 'pre-upgrade old bundled protocol');
  }
  hive.ensureHive();
  hive.ensureHive();
  assert.equal(fs.readFileSync(protocol, 'utf8'), bundled);
  for (const name of ['PROTOCOL-BOSS.md', 'COMMANDS.md']) {
    assert.notEqual(fs.readFileSync(path.join(hiveRoot, name), 'utf8'), 'pre-upgrade old bundled protocol');
  }
});

test('prompt templates are reread on each spawn and expand identity placeholders', async (t) => {
  const { dir, hiveRoot, hive } = tmpHive();
  t.after(() => rmTree(dir));
  hive.ensureHive();
  fs.mkdirSync(path.join(hiveRoot, 'prompts'));
  const file = path.join(hiveRoot, 'prompts', 'worker.md');
  const meta = { id: 'reload-worker', name: 'Reload Worker', provider: 'claude', cwd: dir };
  fs.writeFileSync(file, 'First {{name}} {{id}} {{root}} {{dir}}');
  const first = promptOf(await hive.ensureAgent(meta, {}));
  assert.ok(first.includes(`First Reload Worker reload-worker ${hiveRoot}`));
  fs.writeFileSync(file, 'Second {{name}}');
  assert.equal(promptOf(await hive.ensureAgent(meta, {})), 'Second Reload Worker');
});

test('config watcher survives two atomic replacement saves and close cancels delivery', async (t) => {
  writeConfig({ harnessHome: '/initial' });
  let count = 0;
  const watcher = startConfigWatcher({ debounceMs: 20, onReload: () => count++ });
  t.after(() => watcher.close());
  for (const home of ['/replace-one', '/replace-two']) {
    const temp = path.join(userDataDir, 'config.tmp');
    fs.writeFileSync(temp, JSON.stringify({ ...readConfig(), harnessHome: home }));
    fs.renameSync(temp, path.join(userDataDir, 'config.json'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(readConfig().harnessHome, home);
  }
  assert.equal(count, 2);
  watcher.close();
  fs.writeFileSync(path.join(userDataDir, 'config.json'), '{}');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(count, 2);
});

test('registry watcher attaches when hive directory is created after watch starts', async (t) => {
  const { dir, hiveRoot } = tmpHive();
  t.after(() => rmTree(dir));
  const events = [];
  const watcher = startRosterWatcher(dir, (event) => events.push(event), { debounceMs: 20 });
  t.after(() => watcher.close());
  fs.mkdirSync(hiveRoot);
  await new Promise((resolve) => setTimeout(resolve, 60));
  events.length = 0;
  for (let i = 0; i < 2; i++) {
    const temp = path.join(hiveRoot, 'registry.tmp');
    fs.writeFileSync(temp, JSON.stringify({ agents: {}, godId: null }));
    fs.renameSync(temp, path.join(hiveRoot, 'registry.json'));
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(events.filter((event) => event.source === 'registry').length, 2);
});
