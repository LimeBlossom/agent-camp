'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Codex agents link their sessions under ~/.codex; keep that inside a throwaway home.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'md-workspace-home-'));

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { cleanExtraDirs, extraDirsOf } = loadTs('src/shared/workspace.ts');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'md-workspace-')); }
function registryOf(home) { return JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8')); }
function writeRegistry(home, reg) { fs.writeFileSync(path.join(home, 'hive', 'registry.json'), JSON.stringify(reg)); }

test('extraDirs wins when present, even empty; codexExtraDirs is read only without it', () => {
  assert.deepEqual(extraDirsOf({ codexExtraDirs: ['/old'] }), ['/old']);
  assert.deepEqual(extraDirsOf({ extraDirs: ['/new'], codexExtraDirs: ['/old'] }), ['/new']);
  assert.deepEqual(extraDirsOf({ extraDirs: [], codexExtraDirs: ['/old'] }), []);
  assert.deepEqual(extraDirsOf(undefined), []);
  assert.deepEqual(cleanExtraDirs(' /a \n\nrelative\n~/b\n/a'), ['/a', '~/b']);
});

test('setWorkspace stores the folder, extra folders and Unity flag, and drops the legacy key', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'codex', cwd: home });
  const reg = registryOf(home);
  reg.agents.a1.codexExtraDirs = ['/legacy'];
  reg.agents.a1.codexSandbox = 'projects';
  writeRegistry(home, reg);
  assert.deepEqual(hive.workspaceOf('a1').extraDirs, ['/legacy'], 'legacy folders still read');
  assert.equal(hive.codexSandboxOf('a1').level, 'sandboxed', "a stored 'projects' reads as sandboxed");

  const sub = path.join(home, 'sub');
  fs.mkdirSync(sub);
  const r = hive.setWorkspace('a1', { cwd: sub, extraDirs: '/x\n/y', unity: true });
  assert.deepEqual(r, { ok: true, cwd: sub });
  const a = registryOf(home).agents.a1;
  assert.equal(a.cwd, sub);
  assert.deepEqual(a.extraDirs, ['/x', '/y']);
  assert.equal(a.codexExtraDirs, undefined);
  assert.equal(a.unity, true);
  assert.equal(fs.existsSync(path.join(home, 'hive', 'agents', 'a1', 'unity-requests')), true);
});

test('setWorkspace refuses a folder that does not exist or is not absolute', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  assert.match(hive.setWorkspace('a1', { cwd: path.join(home, 'missing') }).error, /does not exist/);
  assert.match(hive.setWorkspace('a1', { cwd: 'relative/dir' }).error, /absolute/);
  assert.equal(registryOf(home).agents.a1.cwd, home, 'nothing written on a refusal');
});

test('extra folders reach the Claude sandbox and Codex --add-dir', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  hive.setWorkspace('c1', { extraDirs: ['/extra/one'] });
  const inj = await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.ok(settings.sandbox.filesystem.allowWrite.includes('/extra/one'));
  assert.ok(settings.permissions.additionalDirectories.includes('/extra/one'));

  await hive.ensureAgent({ id: 'x1', name: 'X', provider: 'codex', cwd: home });
  hive.setWorkspace('x1', { extraDirs: ['/extra/two'] });
  const cx = await hive.ensureAgent({ id: 'x1', name: 'X', provider: 'codex', cwd: home });
  const addDirs = cx.args.flatMap((a, i) => (a === '--add-dir' ? [cx.args[i + 1]] : []));
  assert.ok(addDirs.includes('/extra/two'), JSON.stringify(addDirs));
  assert.ok(addDirs.includes(home), 'cwd always applies, no projects level needed');
});

test('the Unity paragraph rides in the protocol only when the flag is on', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const off = await hive.ensureAgent({ id: 'u1', name: 'U', provider: 'claude', cwd: home });
  assert.ok(!off.args[off.args.indexOf('--append-system-prompt') + 1].includes('UNITY (batch only)'));
  hive.setWorkspace('u1', { unity: true });
  const on = await hive.ensureAgent({ id: 'u1', name: 'U', provider: 'claude', cwd: home });
  const prompt = on.args[on.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /UNITY \(batch only\)/);
  assert.ok(prompt.includes(path.join(home, 'hive', 'agents', 'u1', 'unity-requests')));
  assert.match(prompt, /MD_UNITY_OUT/);
  assert.match(prompt, /SetCustomRenderingResolution/);
});

test('the worker config.toml follows the agent network switch, on and back off', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const cfg = () => fs.readFileSync(path.join(home, 'hive', 'agents', 'n1', '.codex', 'config.toml'), 'utf8');
  await hive.ensureAgent({ id: 'n1', name: 'N', provider: 'codex', cwd: home });
  assert.match(cfg(), /^network_access = false$/m);
  hive.setWorkspace('n1', { network: true });
  assert.equal(hive.workspaceOf('n1').network, true);
  await hive.ensureAgent({ id: 'n1', name: 'N', provider: 'codex', cwd: home });
  assert.match(cfg(), /^network_access = true$/m);
  hive.setWorkspace('n1', { network: false });
  await hive.ensureAgent({ id: 'n1', name: 'N', provider: 'codex', cwd: home });
  assert.match(cfg(), /^network_access = false$/m);
  assert.doesNotMatch(cfg(), /network_access = true/);
});

test('a Codex worker never shows the update prompt, and its repos are writable roots', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'g1', name: 'G', provider: 'codex', cwd: proj });
  const cfg = fs.readFileSync(path.join(home, 'hive', 'agents', 'g1', '.codex', 'config.toml'), 'utf8');
  assert.match(cfg.split(/^\s*\[/m)[0], /^check_for_update_on_startup = false$/m, 'top level, before any table');
  const addDirs = inj.args.flatMap((a, i) => (a === '--add-dir' ? [inj.args[i + 1]] : []));
  assert.ok(addDirs.includes(path.join(proj, '.git')), JSON.stringify(addDirs));
  assert.ok(cfg.includes(JSON.stringify(path.join(proj, '.git'))), 'and in writable_roots');
});

test('a Codex worker session runs in its own folder, never the app cwd', async (t) => {
  // workspace-write makes the session cwd writable, so a $HOME cwd would open all of it.
  const home = tmpHome();
  t.after(() => rmTree(home));
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'codex', cwd: proj });
  assert.equal(inj.args[inj.args.indexOf('-C') + 1], proj);
  assert.ok(inj.args.includes('--no-daemon'), 'a local TUI, never a shared app-server');
  assert.ok(!inj.args.includes('--remote'));
});

test('the Blender MCP switch writes the Codex server table, and removes it when off', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const cfg = () => fs.readFileSync(path.join(home, 'hive', 'agents', 'm1', '.codex', 'config.toml'), 'utf8');
  await hive.ensureAgent({ id: 'm1', name: 'M', provider: 'codex', cwd: home });
  assert.doesNotMatch(cfg(), /mcp_servers/);
  hive.setWorkspace('m1', { mcp: { blender: true, bogus: true } });
  assert.deepEqual(hive.workspaceOf('m1').mcp, { blender: true });
  const on = await hive.ensureAgent({ id: 'm1', name: 'M', provider: 'codex', cwd: home });
  assert.match(cfg(), /^\[mcp_servers\.blender\]\ncommand = "uvx"\nargs = \["blender-mcp"\]\nstartup_timeout_sec = 10$/m);
  const prompt = on.args[on.args.length - 1];
  assert.match(prompt, /TOOLS YOU HAVE/);
  assert.match(prompt, /MCP servers: blender \(drives the human's open Blender/);
  hive.setWorkspace('m1', { mcp: { blender: false } });
  const off = await hive.ensureAgent({ id: 'm1', name: 'M', provider: 'codex', cwd: home });
  assert.doesNotMatch(cfg(), /mcp_servers/);
  assert.doesNotMatch(off.args[off.args.length - 1], /blender/);
});

test('the Blender MCP switch gives a Claude agent an --mcp-config file, and drops it when off', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  hive.setWorkspace('c1', { mcp: { blender: true } });
  const on = await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  const flag = on.args.find((a) => a.startsWith('--mcp-config='));
  assert.ok(flag, JSON.stringify(on.args));
  const file = flag.slice('--mcp-config='.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { mcpServers: { blender: { type: 'stdio', command: 'uvx', args: ['blender-mcp'] } } });
  assert.match(on.args[on.args.indexOf('--append-system-prompt') + 1], /MCP servers: blender/);
  hive.setWorkspace('c1', { mcp: { blender: false } });
  const off = await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  assert.ok(!off.args.some((a) => a.startsWith('--mcp-config')));
  assert.equal(fs.existsSync(file), false);
});

test('the Boss keeps Chrome while both Boss and workers get strict MCP config', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const boss = await hive.ensureAgent({ id: 'god', name: 'B', provider: 'claude', cwd: home, isGod: true });
  assert.ok(boss.args.includes('--strict-mcp-config'), JSON.stringify(boss.args));
  assert.ok(boss.args.includes('--chrome'));
  const worker = await hive.ensureAgent({ id: 'w2', name: 'W', provider: 'claude', cwd: home });
  assert.ok(worker.args.includes('--strict-mcp-config'));
  assert.ok(!worker.args.includes('--chrome'));
});

test('a Claude agent gets the startable catalog servers in its --mcp-config file, never in settings', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const probed = [];
  hive.setMcpProbe(async (spec) => {
    probed.push(spec.args.join(' '));
    return spec.args.includes('mcp-server-fetch') ? { ok: false, reason: 'exited 1 before answering' } : { ok: true, tools: 1 };
  });
  const { defaultMcpDefaults } = loadTs('src/shared/mcpCatalog.ts');
  const mcpDefaults = { ...defaultMcpDefaults(), db: { enabled: true }, fetch: { enabled: true } };
  await hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home });
  hive.setWorkspace('c2', { mcp: { blender: true } });
  const inj = await hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home }, { mcpDefaults });
  const file = inj.args.find((a) => a.startsWith('--mcp-config=')).slice('--mcp-config='.length);
  const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['blender', 'munder-context7']);
  assert.ok(!probed.some((a) => a.includes('server-postgres')), 'an unconfigured secret server is never started');
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.equal(settings.mcpServers, undefined);
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /MCP servers: .*munder-context7/);
  assert.doesNotMatch(prompt, /munder-fetch/);
  await hive.flushWrites();
  const drops = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((e) => e.kind === 'mcp-drop' && e.agentId === 'c2');
  assert.deepEqual(drops.map((e) => [e.server, e.reason]).sort(),
    [['db', 'not configured: DATABASE_URL is empty'], ['fetch', 'exited 1 before answering']]);
  const before = probed.length;
  await hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home }, { mcpDefaults });
  assert.equal(probed.length, before, 'a respawn reuses the cached results');
});
