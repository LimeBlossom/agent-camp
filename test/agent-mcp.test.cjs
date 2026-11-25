'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  agentMcpSupported, agentToolsLine, claudeMcpConfig, cleanAgentMcp, codexFeatureEnabled,
  codexMcpServerNames, codexWebSearchMode, enabledAgentMcp, setCodexMcpServers
} = loadTs('src/shared/agentMcp.ts');
const { catalogMcpServers, defaultMcpDefaults } = loadTs('src/shared/mcpCatalog.ts');

const BLENDER = '[mcp_servers.blender]\ncommand = "uvx"\nargs = ["blender-mcp"]\nstartup_timeout_sec = 10';

test('cleanAgentMcp keeps known ids with boolean values only', () => {
  assert.deepEqual(cleanAgentMcp({ blender: true, other: true, x: 1 }), { blender: true });
  assert.deepEqual(cleanAgentMcp({ blender: 'yes' }), {});
  assert.deepEqual(cleanAgentMcp(null), {});
  assert.deepEqual(enabledAgentMcp({ blender: true }), ['blender']);
  assert.deepEqual(enabledAgentMcp({ blender: false }), []);
});

test('only Claude and Codex take per-agent servers', () => {
  assert.equal(agentMcpSupported('claude'), true);
  assert.equal(agentMcpSupported('codex'), true);
  assert.equal(agentMcpSupported(undefined), true);
  assert.equal(agentMcpSupported('antigravity'), false);
  assert.equal(agentMcpSupported('grok'), false);
});

test('setCodexMcpServers appends the table when on and leaves other tables alone', () => {
  const cfg = 'model = "gpt"\n\n[tui]\nx = 1\n';
  const on = setCodexMcpServers(cfg, ['blender']);
  assert.ok(on.startsWith(cfg));
  assert.ok(on.includes(BLENDER));
  assert.equal(setCodexMcpServers(on, ['blender']), on, 'idempotent');
  assert.equal(setCodexMcpServers(on, []).trimEnd(), cfg.trimEnd());
});

test('a table inherited from the user config, with subtables, is replaced or removed', () => {
  const user = '[mcp_servers."blender"]\ncommand = "old"\n\n[mcp_servers.blender.env]\nK = "v"\n\n[mcp_servers.other]\ncommand = "o"\n';
  const on = setCodexMcpServers(user, ['blender']);
  assert.doesNotMatch(on, /"old"|K = "v"/);
  assert.equal(on.match(/\[mcp_servers\.blender\]/g).length, 1);
  assert.match(on, /\[mcp_servers\.other\]\ncommand = "o"/);
  const off = setCodexMcpServers(user, []);
  assert.doesNotMatch(off, /blender/);
  assert.match(off, /\[mcp_servers\.other\]/);
  assert.deepEqual(codexMcpServerNames(on).sort(), ['blender', 'other']);
});

test('codexWebSearchMode reads the top-level key only', () => {
  assert.equal(codexWebSearchMode('model = "x"\n'), null);
  assert.equal(codexWebSearchMode('web_search = "live"\n[t]\n'), 'live');
  assert.equal(codexWebSearchMode('[t]\nweb_search = "disabled"\n'), null);
});

test('codexFeatureEnabled parses the `codex features list` table', () => {
  const listing = 'hooks                                    stable             true\nimage_generation                         stable             true\nimage_resize_notice                      under development  false\n';
  assert.equal(codexFeatureEnabled(listing, 'image_generation'), true);
  assert.equal(codexFeatureEnabled(listing, 'image_resize_notice'), false);
  assert.equal(codexFeatureEnabled(listing, 'image'), false);
  assert.equal(codexFeatureEnabled('', 'image_generation'), false);
});

test('claudeMcpConfig is the --mcp-config body, null with nothing on', () => {
  assert.deepEqual(claudeMcpConfig(['blender']),
    { mcpServers: { blender: { type: 'stdio', command: 'uvx', args: ['blender-mcp'] } } });
  assert.equal(claudeMcpConfig([]), null);
  assert.equal(claudeMcpConfig([], {}), null);
});

test('claudeMcpConfig merges catalog servers with the per-agent switches', () => {
  const cfg = claudeMcpConfig(['blender'], { 'munder-time': { command: 'uvx', args: ['mcp-server-time'] } });
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['blender', 'munder-time']);
  assert.deepEqual(cfg.mcpServers['munder-time'], { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] });
  assert.deepEqual(Object.keys(claudeMcpConfig([], { 'munder-time': { command: 'uvx', args: [] } }).mcpServers), ['munder-time']);
});

test('catalogMcpServers gives the safe defaults, scoped to the cwd, and no secret tier', () => {
  const { servers, dropped } = catalogMcpServers('/w', defaultMcpDefaults());
  assert.deepEqual(Object.keys(servers), ['munder-context7']);
  assert.deepEqual(dropped, []);
  assert.deepEqual(catalogMcpServers('/w', undefined).servers, {});
});

test('a secret server needs explicit consent and its env, and never writes an inherited value', () => {
  const consent = { ...defaultMcpDefaults(), 'github-token': { enabled: true } };
  const off = catalogMcpServers('/w', consent, {});
  assert.equal(off.servers['munder-github-token'], undefined);
  assert.deepEqual(off.dropped, [{ id: 'github-token', reason: 'not configured: GITHUB_PERSONAL_ACCESS_TOKEN is empty' }]);
  const on = catalogMcpServers('/w', consent, { GITHUB_PERSONAL_ACCESS_TOKEN: 'tok-secret' });
  assert.ok(on.servers['munder-github-token']);
  assert.doesNotMatch(JSON.stringify(on), /tok-secret/);
  const fromDefault = catalogMcpServers('/w', { 'github-token': undefined }, { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' });
  assert.equal(fromDefault.servers['munder-github-token'], undefined, 'a default never arms a secret server');
});

test('the tools line for a Codex agent names native tools, MCP, Unity and skills', () => {
  const line = agentToolsLine({
    provider: 'codex', imageGeneration: true, webSearch: null,
    mcpServers: ['blender'], unity: true, skills: ['test-scope', 'critic']
  });
  assert.match(line, /^TOOLS YOU HAVE/);
  assert.match(line, /Built in: image generation, web search\./);
  assert.match(line, /blender \(drives the human's open Blender.*hive-blender -b/);
  assert.match(line, /Unity batch runs through the harness broker/);
  assert.match(line, /Skills: critic, test-scope\./);
  assert.ok(line.split('\n').length <= 5);
});

test('the tools line leaves out what is not configured', () => {
  const codex = agentToolsLine({ provider: 'codex', imageGeneration: false, webSearch: 'disabled', mcpServers: [], unity: false, skills: [] });
  assert.equal(codex, '');
  const live = agentToolsLine({ provider: 'codex', imageGeneration: false, webSearch: 'live', mcpServers: [], unity: false, skills: [] });
  assert.match(live, /web search \(live\)/);
  const claude = agentToolsLine({ provider: 'claude', mcpServers: ['blender'], unity: false, skills: ['critic'] });
  assert.doesNotMatch(claude, /Built in|image generation|web search/);
  assert.match(claude, /MCP servers: blender/);
  const agy = agentToolsLine({ provider: 'antigravity', mcpServers: ['other'], unity: false, skills: [] });
  assert.match(agy, /MCP servers: other\.$/m);
});
