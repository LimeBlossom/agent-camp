'use strict';

/**
 * Retiring an agent (archive, reversible): the human's Retire control on a dormant row, the
 * Boss's archive_agent camp tool, and the harness router that re-checks the Boss's
 * request. An archived agent leaves the dormant list, so mail cannot wake it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { ARCHIVE_AGENT_ACT, openCardsFor, validateArchiveRequest } = loadTs('src/shared/agentArchive.ts');
const { CAMP_MCP_TOOLS, archiveAgent } = loadTs('src/main/campTools.ts');
const { archiveFromLists } = loadTs('src/renderer/src/store/archiveLists.ts');
const { planDormancy } = loadTs('src/shared/dormantWake.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const roster = (extra = {}) => ({
  godId: 'boss',
  known: (id) => ['boss', 'crystal-bite', 'busy', 'gone'].includes(id),
  isGod: (id) => id === 'boss',
  isArchived: (id) => id === 'gone',
  openCards: (id) => (id === 'busy' ? ['card-a'] : []),
  ...extra
});

test('openCardsFor lists only todo and doing cards assigned to the agent', () => {
  const tasks = [
    { id: 't1', assignee: 'w', status: 'todo' },
    { id: 't2', assignee: 'w', status: 'doing' },
    { id: 't3', assignee: 'w', status: 'blocked' },
    { id: 't4', assignee: 'w', status: 'done' },
    { id: 't5', assignee: 'other', status: 'doing' }
  ];
  assert.deepEqual(openCardsFor('w', tasks), ['t1', 't2']);
  assert.deepEqual(openCardsFor('w', undefined), []);
});

test('only the Boss may archive, never itself, never an agent with an open card', () => {
  assert.equal(validateArchiveRequest('crystal-bite', { agentId: 'busy' }, roster()).ok, false);
  assert.match(validateArchiveRequest('crystal-bite', { agentId: 'busy' }, roster()).error, /only the Boss/);
  assert.match(validateArchiveRequest('boss', { agentId: 'boss' }, roster()).error, /Boss/);
  assert.match(validateArchiveRequest('boss', { agentId: 'ghost' }, roster()).error, /unknown agent/);
  assert.match(validateArchiveRequest('boss', { agentId: '../x' }, roster()).error, /invalid agentId/);
  const busy = validateArchiveRequest('boss', { agentId: 'busy' }, roster());
  assert.equal(busy.ok, false);
  assert.match(busy.error, /card-a/);
  assert.match(validateArchiveRequest('boss', { agentId: 'gone' }, roster()).error, /already archived/);
  const ok = validateArchiveRequest('boss', { agentId: 'crystal-bite', reason: 'temp worker, card closed' }, roster());
  assert.deepEqual(ok, { ok: true, request: { agentId: 'crystal-bite', reason: 'temp worker, card closed' } });
});

test('archive_agent is a camp tool that queues a harness message, and refuses without writing', (t) => {
  const tool = CAMP_MCP_TOOLS.find((x) => x.name === 'archive_agent');
  assert.ok(tool, 'archive_agent tool is listed');
  assert.deepEqual(tool.inputSchema.required, ['agentId']);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-archive-tool-'));
  t.after(() => rmTree(home));
  fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify({ godId: 'boss', agents: { boss: { isGod: true }, 'crystal-bite': {}, busy: {} } }));
  fs.writeFileSync(path.join(home, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'card-a', assignee: 'busy', status: 'doing' }] }));
  const outboxDir = path.join(home, 'agents', 'boss', 'outbox');

  const refused = archiveAgent({ hiveRoot: home, agentId: 'boss', args: { agentId: 'busy' }, outboxDir });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /card-a/);
  assert.equal(fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).length : 0, 0);

  const notBoss = archiveAgent({ hiveRoot: home, agentId: 'busy', args: { agentId: 'crystal-bite' }, outboxDir });
  assert.equal(notBoss.ok, false);

  const queued = archiveAgent({ hiveRoot: home, agentId: 'boss', args: { agentId: 'crystal-bite' }, outboxDir });
  assert.equal(queued.ok, true);
  const msg = JSON.parse(fs.readFileSync(queued.queued, 'utf8'));
  assert.equal(msg.to, 'harness');
  assert.equal(msg.act, ARCHIVE_AGENT_ACT);
  assert.equal(msg.body.agentId, 'crystal-bite');
});

async function hiveRig(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-archive-route-'));
  t.after(() => rmTree(home));
  const emitted = [];
  const hive = new HiveManager(() => home, (channel, payload) => { emitted.push({ channel, payload }); return true; });
  await hive.ensureAgent({ id: 'boss', name: 'Oak', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'crystal-bite', name: 'Crystal Bite', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'busy', name: 'Busy', provider: 'claude', cwd: home });
  hive.writeTasks([{ id: 'card-a', title: 'A', assignee: 'busy', status: 'todo', dependsOn: [] }]);
  const root = path.join(home, 'hive');
  const send = (from, body) => {
    const file = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    fs.writeFileSync(path.join(root, 'agents', from, 'outbox', file), JSON.stringify({ to: 'harness', act: ARCHIVE_AGENT_ACT, body }), 'utf8');
    return hive.routeOnce();
  };
  const reg = () => JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const inbox = (id) => fs.readdirSync(path.join(root, 'agents', id, 'inbox')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'agents', id, 'inbox', f), 'utf8')));
  return { hive, emitted, send, reg, inbox };
}

test('the router archives on a Boss request, tells the renderer and the Boss', async (t) => {
  const { emitted, send, reg, inbox } = await hiveRig(t);
  send('boss', { agentId: 'crystal-bite', reason: 'old temp worker' });
  assert.equal(reg().agents['crystal-bite'].archived, true);
  assert.ok(emitted.some((e) => e.channel === 'hive:agentArchived' && e.payload?.id === 'crystal-bite'));
  assert.ok(inbox('boss').some((m) => /crystal-bite archived/.test(m.subject)));
});

test('the router refuses a worker sender, an open card, and a live session, touching nothing', async (t) => {
  const { hive, emitted, send, reg, inbox } = await hiveRig(t);
  send('crystal-bite', { agentId: 'busy' });
  assert.notEqual(reg().agents.busy.archived, true);
  assert.ok(inbox('crystal-bite').some((m) => /refused/.test(m.subject)));

  send('boss', { agentId: 'busy' });
  assert.notEqual(reg().agents.busy.archived, true);
  assert.ok(inbox('boss').some((m) => /refused/.test(m.subject) && /card-a/.test(`${m.subject} ${m.body}`)));

  hive.setArchiveAgentGuard((id) => (id === 'crystal-bite' ? 'it has a live session' : null));
  send('boss', { agentId: 'crystal-bite' });
  assert.notEqual(reg().agents['crystal-bite'].archived, true);
  assert.ok(inbox('boss').some((m) => /refused/.test(m.subject) && /live session/.test(`${m.subject} ${m.body}`)));
  assert.equal(emitted.filter((e) => e.channel === 'hive:agentArchived').length, 0);
});

const agent = (id, extra = {}) => ({ id, name: id, status: 'idle', ...extra });

test('archiving a dormant agent moves it off the dormant list, so mail cannot wake it', () => {
  const state = { agents: [agent('boss', { isGod: true })], restorableAgents: [agent('crystal-bite'), agent('junk-refs')], archivedAgents: [] };
  const next = archiveFromLists(state, 'crystal-bite');
  assert.deepEqual(next.restorableAgents.map((a) => a.id), ['junk-refs']);
  assert.deepEqual(next.archivedAgents.map((a) => a.id), ['crystal-bite']);
  assert.equal(next.archivedAgents[0].archived, true);
  assert.equal(next.agents, state.agents);
  // The next dormancy pass must not flip it back to dormant once it is off the dormant list.
  const plan = planDormancy(
    { boss: { isGod: true }, 'crystal-bite': { archived: true } },
    { boot: false, godId: 'boss', liveIds: new Set(), rosterIds: new Set(['junk-refs']), restorableIds: new Set(next.restorableAgents.map((a) => a.id)) }
  );
  assert.ok(!plan.dormant.includes('crystal-bite'));
});

test('archiving a live agent still works and an unknown id is a no-op', () => {
  const state = { agents: [agent('w', { ptyId: 'p1', status: 'working' })], restorableAgents: [], archivedAgents: [] };
  const next = archiveFromLists(state, 'w');
  assert.deepEqual(next.agents, []);
  assert.equal(next.archivedAgents[0].ptyId, undefined);
  assert.equal(archiveFromLists(state, 'nobody'), null);
});

test('the dormant row has a confirmed Retire control that archives through main', () => {
  const panel = read('src/renderer/src/components/CommandCenterPanel.tsx');
  const dormant = panel.slice(panel.indexOf('function DormantSection'), panel.indexOf('// ─── Memory tab'));
  const usesHook = /useRetireAgent/.test(dormant);
  if (usesHook) {
    const hook = read('src/renderer/src/hooks/useRetireAgent.ts');
    assert.match(hook, /confirm\(/);
    assert.match(hook, /hiveSetArchived/);
  } else {
    assert.match(dormant, /confirm\(/);
    assert.match(dormant, /hiveSetArchived\(a\.id, true\)/);
  }
  assert.match(dormant, /commandCenter\.retire/);
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  for (const k of ['retire', 'retireTitle', 'retireConfirm', 'retireConfirmOpenCards']) assert.ok(en.commandCenter[k], `en commandCenter.${k}`);
});

test('the setArchived IPC tells the renderer, so a dormant agent leaves its list', () => {
  const index = read('src/main/index.ts');
  const handler = index.slice(index.indexOf("ipcMain.handle('hive:setArchived'"), index.indexOf("ipcMain.handle('hive:patchAgentRole'"));
  assert.match(handler, /hive:agentArchived/);
});

test('the store archiveAgent uses archiveFromLists, so it handles dormant agents', () => {
  const store = read('src/renderer/src/store/store.ts');
  assert.match(store, /archiveFromLists\(/);
});

test('PROTOCOL-BOSS.md documents archive_agent', async (t) => {
  const { hive } = await hiveRig(t);
  const text = fs.readFileSync(path.join(hive.root(), 'PROTOCOL-BOSS.md'), 'utf8');
  assert.match(text, /## Retiring an agent/);
  assert.match(text, /archive_agent/);
});
