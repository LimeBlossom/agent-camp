'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const rmTree = require('../test-support/rm-tree.cjs');

const repoRoot = path.resolve(__dirname, '..');
const electronBin = require('electron');

let buildDir = null;
let hiveDir = null;
let builtServerPath = null;

async function buildMainBundle(outDir) {
  const { resolveConfig } = await import('electron-vite');
  const { build } = await import('vite');
  const resolved = await resolveConfig(
    { root: repoRoot, configFile: path.join(repoRoot, 'electron.vite.config.ts') },
    'build',
    'production'
  );
  const mainCfg = resolved.config?.main;
  assert.ok(mainCfg, 'electron.vite.config.ts must resolve a main build config');
  const plugins = (mainCfg.plugins ?? []).filter((p) => !(p && typeof p === 'object' && p.name === 'copy-main-cjs-sidecars'));
  await build({
    ...mainCfg,
    configFile: false,
    logLevel: 'silent',
    plugins,
    build: {
      ...mainCfg.build,
      outDir,
      emptyOutDir: true
    }
  });
  return path.join(outDir, 'campMcpServer.js');
}

function runMcpSession(bin, args, env, requests, cwd = path.dirname(args[0])) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const responses = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      resolve({ code, signal, responses, stdout, stderr });
    });
    for (const req of requests) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`);
    }
    child.stdin.end();
  });
}

function collectLocalChunkGraph(entryFile) {
  const visited = new Set();
  const queue = [path.resolve(entryFile)];
  const localReq = /require\((['"])(\.[^'"]+)\1\)/g;
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const src = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = localReq.exec(src)) !== null) {
      const target = path.resolve(path.dirname(file), match[2]);
      const resolved = fs.existsSync(target) ? target : `${target}.js`;
      if (fs.existsSync(resolved) && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return [...visited];
}

test.before(async () => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-mcp-build-'));
  hiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-mcp-hive-'));
  fs.mkdirSync(path.join(hiveDir, 'agents', 'god-test', 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(hiveDir, 'tasks.json'), JSON.stringify({ tasks: [] }), 'utf8');
  fs.writeFileSync(path.join(hiveDir, 'fleet.json'), JSON.stringify({ agents: [] }), 'utf8');
  builtServerPath = await buildMainBundle(buildDir);
});

test.after(() => {
  if (buildDir) rmTree(buildDir);
  if (hiveDir) rmTree(hiveDir);
});

test('built campMcpServer.js answers initialize + tools/list under Electron ELECTRON_RUN_AS_NODE=1', async () => {
  assert.ok(fs.existsSync(builtServerPath), 'built campMcpServer.js must exist');
  const res = await runMcpSession(
    electronBin,
    [builtServerPath],
    {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HIVE_ROOT: hiveDir,
      AGENT_ID: 'god-test'
    },
    [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
      { id: 2, method: 'tools/list', params: {} }
    ]
  );

  assert.equal(res.code, 0, `campMcpServer crashed (code=${res.code}):\n${res.stderr}`);
  assert.equal(res.responses.length, 2, `expected 2 JSON-RPC responses, got ${res.responses.length}:\nstdout=${res.stdout}\nstderr=${res.stderr}`);

  const init = res.responses.find((r) => r.id === 1);
  assert.ok(init && init.result, `initialize failed: ${JSON.stringify(init)}`);
  assert.equal(init.result.serverInfo?.name, 'camp');
  assert.ok(init.result.capabilities?.tools);

  const list = res.responses.find((r) => r.id === 2);
  assert.ok(list && list.result && Array.isArray(list.result.tools), `tools/list failed: ${JSON.stringify(list)}`);
  const names = new Set(list.result.tools.map((t) => t.name));
  for (const requiredTool of ['ask_human', 'create_card', 'merge', 'restart_camp', 'restart_agent', 'floor']) {
    assert.ok(names.has(requiredTool), `tools/list missing expected Boss tool: ${requiredTool}`);
  }
});

test('built campMcpServer.js answers initialize, tools/list and floor call under plain node', async () => {
  const res = await runMcpSession(
    process.execPath,
    [builtServerPath],
    {
      ...process.env,
      HIVE_ROOT: hiveDir,
      AGENT_ID: 'god-test'
    },
    [
      { id: 1, method: 'initialize', params: {} },
      { id: 2, method: 'tools/list', params: {} },
      { id: 3, method: 'tools/call', params: { name: 'floor', arguments: {} } }
    ]
  );

  assert.equal(res.code, 0, `campMcpServer crashed under plain node (code=${res.code}):\n${res.stderr}`);
  assert.equal(res.responses.length, 3, `expected 3 JSON-RPC responses, got ${res.responses.length}:\nstdout=${res.stdout}\nstderr=${res.stderr}`);

  const floor = res.responses.find((r) => r.id === 3);
  assert.ok(floor && floor.result, `floor call failed: ${JSON.stringify(floor)}`);
  assert.notEqual(floor.result.isError, true, `floor returned error: ${JSON.stringify(floor.result)}`);
  assert.match(floor.result.content?.[0]?.text ?? '', /ROSTER:/);
});

test('built campMcpServer.js reads custom timings from CAMP_CONFIG_PATH without electron', async () => {
  const customHive = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-mcp-cfg-hive-'));
  const cfgFile = path.join(customHive, 'config.json');
  try {
    fs.mkdirSync(path.join(customHive, 'agents', 'god-test', 'outbox'), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({ timings: { stallAfterMs: 10_000 } }), 'utf8');
    fs.writeFileSync(
      path.join(customHive, 'tasks.json'),
      JSON.stringify({ tasks: [{ id: 'stall-card', status: 'doing', assignee: 'worker-1', project: 'Camp', title: 'Stall check' }] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(customHive, 'fleet.json'),
      JSON.stringify({ agents: [{ id: 'worker-1', name: 'Worker', role: 'dev', status: 'active', lastActiveSecAgo: 30 }] }),
      'utf8'
    );

    const res = await runMcpSession(
      electronBin,
      [builtServerPath],
      {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HIVE_ROOT: customHive,
        AGENT_ID: 'god-test',
        CAMP_CONFIG_PATH: cfgFile
      },
      [{ id: 1, method: 'tools/call', params: { name: 'floor', arguments: {} } }]
    );

    assert.equal(res.code, 0, `campMcpServer crashed (code=${res.code}):\n${res.stderr}`);
    const floor = res.responses.find((r) => r.id === 1);
    assert.ok(floor && floor.result, `floor call failed: ${JSON.stringify(floor)}`);
    assert.match(floor.result.content?.[0]?.text ?? '', /STALLED on stall-card/);
  } finally {
    rmTree(customHive);
  }
});

test('built campMcpServer.js import graph never requires electron', () => {
  const files = collectLocalChunkGraph(builtServerPath);
  assert.ok(files.length >= 1, 'expected at least campMcpServer.js in chunk graph');
  const electronReq = /require\((['"])electron\1\)/;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.equal(
      electronReq.test(src),
      false,
      `${path.relative(buildDir, file)} must not require('electron') in the MCP server bundle`
    );
  }
});

// The packaged app runs the server from inside resources/app.asar under the app's own
// Electron binary; a bundle that only loads from a plain folder fails there.
test('built campMcpServer.js answers from inside an asar archive', async () => {
  const asar = require('@electron/asar');
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-mcp-asar-'));
  try {
    const archive = path.join(packDir, 'app.asar');
    await asar.createPackage(buildDir, archive);
    const res = await runMcpSession(
      electronBin,
      [path.join(archive, 'campMcpServer.js')],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1', HIVE_ROOT: hiveDir, AGENT_ID: 'god-test' },
      [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list', params: {} }],
      packDir
    );
    assert.equal(res.code, 0, `campMcpServer crashed from asar (code=${res.code}):\n${res.stderr}`);
    const list = res.responses.find((r) => r.id === 2);
    assert.ok(list?.result?.tools?.some((t) => t.name === 'ask_human'), `tools/list from asar: ${res.stdout}\n${res.stderr}`);
  } finally {
    rmTree(packDir);
  }
});

// agy reads MCP servers from one per-user file, so every agy session on the machine
// launches the server; CAMP_BOSS_ID says which session's AGENT_ID owns the tools.
test('built campMcpServer.js offers no tools to an agy session that is not the Boss', async () => {
  const res = await runMcpSession(
    process.execPath,
    [builtServerPath],
    { ...process.env, HIVE_ROOT: hiveDir, AGENT_ID: 'quince-1', CAMP_BOSS_ID: 'god-test' },
    [
      { id: 1, method: 'initialize', params: {} },
      { id: 2, method: 'tools/list', params: {} },
      { id: 3, method: 'tools/call', params: { name: 'floor', arguments: {} } }
    ]
  );
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.responses.find((r) => r.id === 2).result.tools, []);
  assert.equal(res.responses.find((r) => r.id === 3).result.isError, true);
  assert.equal(fs.existsSync(path.join(hiveDir, 'agents', 'quince-1', 'camp-mcp.json')), false);
});

test('built campMcpServer.js offers no tools to a personal agy session with no AGENT_ID', async () => {
  const env = { ...process.env, HIVE_ROOT: hiveDir, CAMP_BOSS_ID: 'god-test' };
  delete env.AGENT_ID;
  const res = await runMcpSession(process.execPath, [builtServerPath], env,
    [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list', params: {} }]);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.responses.find((r) => r.id === 2).result.tools, []);
});

test('built campMcpServer.js checks in for the Boss on initialize', async () => {
  const beat = path.join(hiveDir, 'agents', 'god-test', 'camp-mcp.json');
  fs.rmSync(beat, { force: true });
  const before = Date.now();
  const res = await runMcpSession(
    process.execPath,
    [builtServerPath],
    { ...process.env, HIVE_ROOT: hiveDir, AGENT_ID: 'god-test', CAMP_BOSS_ID: 'god-test' },
    [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list', params: {} }]
  );
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.responses.find((r) => r.id === 2).result.tools.length > 0);
  const rec = JSON.parse(fs.readFileSync(beat, 'utf8'));
  assert.equal(rec.agentId, 'god-test');
  assert.ok(Date.parse(rec.at) >= before - 1000, `check-in time ${rec.at} predates the session`);
});
