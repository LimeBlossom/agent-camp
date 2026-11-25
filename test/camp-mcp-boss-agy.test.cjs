'use strict';
// The Boss's camp tools (ask_human, create_card, merge, restart_camp) reach it only as an MCP
// server. Claude gets it from a per-agent --mcp-config file; agy has no such flag and reads
// MCP servers from ONE per-user file, so a Boss handed to agy booted with only `blender`
// (2026-11-24) and could not run the floor. These cover the agy registration and the
// health check that turns a missing camp server into a logged, visible event.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-mcp-agy-')));
  t.after(() => rmTree(base));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  const realHome = process.env.HOME;
  const realTmp = process.env.TMPDIR;
  process.env.HOME = home;
  process.env.TMPDIR = path.join(base, 'tmp');
  fs.mkdirSync(process.env.TMPDIR);
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp;
  });
  assert.equal(os.homedir(), home, 'home redirect failed; aborting before touching the real home');
  const hiveHome = path.join(base, 'hive-x');
  const mcpConfig = path.join(home, '.gemini', 'config', 'mcp_config.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } }, null, 2));
  return { home, hiveHome, mcpConfig, hive: new HiveManager(() => hiveHome) };
}

const readServers = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers;
const promptOf = (inj) => inj.args.join('\n');
const logKinds = (hiveHome) => {
  const p = path.join(hiveHome, 'hive', 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

test('an agy Boss spawn registers the camp server in agy\'s user mcp_config.json, keeping the user\'s servers', async (t) => {
  const { hiveHome, mcpConfig, hive } = fixture(t);
  hive.setUserConfigHome(os.homedir());
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'antigravity', cwd: hiveHome });
  const servers = readServers(mcpConfig);
  assert.ok(servers.blender, 'the user\'s own blender server must survive');
  const camp = servers.camp;
  assert.ok(camp, 'camp must be registered for an agy Boss');
  assert.equal(camp.command, process.execPath);
  assert.equal(camp.args[0], hive.campMcpServerScript());
  assert.equal(camp.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(camp.env.HIVE_ROOT, path.join(hiveHome, 'hive'));
  assert.equal(camp.env.CAMP_BOSS_ID, 'god');
  // The file is shared by every agy session; the identity must come from the session's own env.
  assert.equal(camp.env.AGENT_ID, undefined, 'a fixed AGENT_ID would let every agy session act as the Boss');
});

test('an agy Boss is told it has the camp tools', async (t) => {
  const { hiveHome, hive } = fixture(t);
  hive.setUserConfigHome(os.homedir());
  const inj = await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'antigravity', cwd: hiveHome });
  assert.match(promptOf(inj), /MCP servers:[^\n]*\bcamp\b/);
});

test('an agy worker spawn does not register camp', async (t) => {
  const { hiveHome, mcpConfig, hive } = fixture(t);
  hive.setUserConfigHome(os.homedir());
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: hiveHome });
  assert.equal(readServers(mcpConfig).camp, undefined);
});

test('an agy worker spawned after the Boss is not told it has the camp tools', async (t) => {
  const { hiveHome, mcpConfig, hive } = fixture(t);
  hive.setUserConfigHome(os.homedir());
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'antigravity', cwd: hiveHome });
  assert.ok(readServers(mcpConfig).camp);
  const inj = await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: hiveHome });
  assert.doesNotMatch(promptOf(inj), /MCP servers:[^\n]*\bcamp\b/);
});

test('a hive not given the user home never writes agy\'s user mcp_config.json', async (t) => {
  const { hiveHome, mcpConfig, hive } = fixture(t);
  const before = fs.readFileSync(mcpConfig, 'utf8');
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'antigravity', cwd: hiveHome });
  assert.equal(fs.readFileSync(mcpConfig, 'utf8'), before);
});

test('a Boss whose camp server never checks in is logged as camp-mcp-missing and raised', async (t) => {
  const { hiveHome, hive } = fixture(t);
  hive.setUserConfigHome(os.homedir());
  const raised = [];
  hive.emit = (ch, payload) => { if (ch === 'hive:degraded') raised.push(payload); };
  hive.setCampMcpCheckDelayMs(30);
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'antigravity', cwd: hiveHome });
  await new Promise((r) => setTimeout(r, 120));
  const missing = logKinds(hiveHome).filter((e) => e.kind === 'camp-mcp-missing');
  assert.equal(missing.length, 1, 'exactly one camp-mcp-missing log line');
  assert.equal(missing[0].agentId, 'god');
  assert.equal(missing[0].provider, 'antigravity');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].reason, 'camp-mcp');
  const inbox = path.join(hiveHome, 'hive', 'agents', 'god', 'inbox');
  const mail = fs.readdirSync(inbox).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
  assert.ok(mail.some((m) => /camp MCP server missing/.test(m.subject)), 'the Boss is told in its inbox');
});

test('a Boss whose camp server checked in after the spawn is healthy', async (t) => {
  const { hiveHome, hive } = fixture(t);
  hive.setCampMcpCheckDelayMs(60);
  const raised = [];
  hive.emit = (ch, payload) => { if (ch === 'hive:degraded') raised.push(payload); };
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: hiveHome });
  const beat = path.join(hiveHome, 'hive', 'agents', 'god', 'camp-mcp.json');
  fs.writeFileSync(beat, JSON.stringify({ pid: 1, at: new Date().toISOString(), agentId: 'god' }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hive.campMcpHealth('god').ok, true);
  assert.deepEqual(logKinds(hiveHome).filter((e) => e.kind === 'camp-mcp-missing'), []);
  assert.deepEqual(raised, []);
});

test('a check-in left over from an earlier session does not count for a new spawn', async (t) => {
  const { hiveHome, hive } = fixture(t);
  hive.setCampMcpCheckDelayMs(60_000);
  const dir = path.join(hiveHome, 'hive', 'agents', 'god');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'camp-mcp.json'), JSON.stringify({ pid: 1, at: new Date(Date.now() - 3_600_000).toISOString(), agentId: 'god' }));
  await hive.ensureAgent({ id: 'god', name: 'Michael', isGod: true, provider: 'claude', cwd: hiveHome });
  const health = hive.campMcpHealth('god');
  assert.equal(health.ok, false);
  assert.match(health.reason, /before this spawn|stale/);
  hive.cancelCampMcpChecks();
});

test('workers get no camp health check', async (t) => {
  const { hiveHome, hive } = fixture(t);
  hive.setCampMcpCheckDelayMs(20);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'claude', cwd: hiveHome });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(logKinds(hiveHome).filter((e) => e.kind === 'camp-mcp-missing'), []);
});
