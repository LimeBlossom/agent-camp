'use strict';

/**
 * Cards declare the capabilities their work needs (camp-card-needs-capabilities).
 *
 * Contract:
 * 1. A card's optional `needs` lists capabilities from CARD_NEEDS ('unity', 'network').
 *    The Boss sets it on create and patch; a worker cannot. null or [] clears it.
 * 2. An agent's effective capabilities are its registry override flags OR the needs of
 *    any of its cards that is not done. Done cards and other agents' cards grant nothing.
 * 3. A granted unity capability gives the session the unity-requests folder and the
 *    Unity prompt line, and the broker accepts the agent's requests; with no open card
 *    needing it (and no override) the line is absent and the broker refuses.
 * 4. A granted network capability reaches the Codex network switch the same way.
 * 5. The task view line shows a card's needs.
 * 6. create_card and patch_card pass needs through.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-needs-home-'));

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { CARD_NEEDS, isCardNeeds, cardNeedsOf } = loadTs('src/shared/cardNeeds.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { renderTaskView } = loadTs('src/main/taskViews.ts');
const { createCard, patchCard } = loadTs('src/main/campTools.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const card = (id, status, extra = {}) => ({ id, title: `T ${id}`, status, assignee: 'a1', dependsOn: [], ...extra });
const NOW = '2026-11-21T16:00:00Z';
const plan = (body, isBoss = true, tasks = [card('c', 'todo')], act = 'task-patch') =>
  planTaskMessage({ act, body, sender: isBoss ? 'god' : 'a1', isBoss, tasks, now: NOW });

test('CARD_NEEDS names unity and network, and isCardNeeds checks a list of them', () => {
  assert.deepEqual([...CARD_NEEDS].sort(), ['network', 'unity']);
  assert.equal(isCardNeeds(['unity']), true);
  assert.equal(isCardNeeds(['unity', 'network']), true);
  assert.equal(isCardNeeds([]), true);
  assert.equal(isCardNeeds(['gpu']), false);
  assert.equal(isCardNeeds('unity'), false);
  assert.equal(isCardNeeds([1]), false);
});

test('the Boss sets needs on patch and create; a bad value or a worker is refused; null clears', () => {
  const set = plan({ id: 'c', needs: ['unity', 'unity', 'network'] });
  assert.equal(set.ok, true, set.reason);
  assert.deepEqual(set.patch.needs, ['unity', 'network'], 'deduped');

  const bad = plan({ id: 'c', needs: ['gpu'] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /needs must be a list of unity, network/);

  const worker = plan({ id: 'c', needs: ['unity'] }, false);
  assert.equal(worker.ok, false, 'a worker cannot grant itself a capability');

  const cleared = plan({ id: 'c', needs: null }, true, [card('c', 'todo', { needs: ['unity'] })]);
  assert.equal(cleared.ok, true, cleared.reason);
  assert.ok('needs' in cleared.patch && cleared.patch.needs === undefined);
  const emptied = plan({ id: 'c', needs: [] }, true, [card('c', 'todo', { needs: ['unity'] })]);
  assert.ok('needs' in emptied.patch && emptied.patch.needs === undefined, '[] clears too');

  const created = plan({ id: 'n', title: 'New', assignee: 'a1', project: 'General', needs: ['unity'] }, true, [], 'task-create');
  assert.equal(created.ok, true, created.reason);
  assert.deepEqual(created.card.needs, ['unity']);
});

test('cardNeedsOf unions the needs of the agent\'s cards that are not done', () => {
  const tasks = [
    card('u', 'blocked', { needs: ['unity'] }),
    card('n', 'done', { needs: ['network'] }),
    card('o', 'todo', { assignee: 'other', needs: ['network'] }),
    card('plain', 'doing'),
    null,
    'junk',
    card('bad', 'todo', { needs: 'unity' })
  ];
  assert.deepEqual(cardNeedsOf(tasks, 'a1'), { needs: ['unity'], cards: { unity: ['u'], network: [] } });
  assert.deepEqual(cardNeedsOf(tasks, 'other'), { needs: ['network'], cards: { unity: [], network: ['o'] } });
  assert.deepEqual(cardNeedsOf(tasks, 'nobody'), { needs: [], cards: { unity: [], network: [] } });
});

test('the task view line shows a card\'s needs', () => {
  const out = renderTaskView({ tasks: [card('u', 'todo', { needs: ['unity', 'network'] }), card('p', 'todo')], agentId: 'a1', isBoss: false, tasksPath: '/h/tasks.json' });
  const uLine = out.split('\n').find((l) => l.includes('`u`'));
  const pLine = out.split('\n').find((l) => l.includes('`p`'));
  assert.match(uLine, /needs unity, network/);
  assert.doesNotMatch(pLine, /needs/);
});

test('create_card and patch_card pass needs through, and refuse a bad value', () => {
  const writes = [];
  const writeFileFn = (p, c) => writes.push(c);
  const hiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-needs-tools-'));
  try {
    const c = createCard({ hiveRoot, title: 'T', assignee: 'a1', project: 'General', needs: ['unity'], outboxDir: hiveRoot, writeFileFn });
    assert.equal(c.ok, true, c.error);
    assert.deepEqual(c.createPayload.body.needs, ['unity']);
    const p = patchCard({ hiveRoot, id: 'x', needs: ['network'], outboxDir: hiveRoot, writeFileFn });
    assert.equal(p.ok, true, p.error);
    assert.deepEqual(p.patchPayload.body.needs, ['network']);
    const cl = patchCard({ hiveRoot, id: 'x', needs: null, outboxDir: hiveRoot, writeFileFn });
    assert.equal(cl.ok, true, cl.error);
    assert.equal(cl.patchPayload.body.needs, null);
    const bad = patchCard({ hiveRoot, id: 'x', needs: ['gpu'], outboxDir: hiveRoot, writeFileFn });
    assert.equal(bad.ok, false);
  } finally { rmTree(hiveRoot); }
});

async function hiveWith(t, agentFlags = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-needs-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  if (Object.keys(agentFlags).length) hive.setWorkspace('a1', agentFlags);
  return { home, hive };
}

function prompt(hive, home) {
  const root = hive.root();
  return hive.injectedPrompt({ id: 'a1', name: 'A', provider: 'claude', cwd: home }, path.join(root, 'agents', 'a1'), root, false, false, undefined, '');
}

test('an open card that needs unity grants it; finishing the card revokes it', async (t) => {
  const { home, hive } = await hiveWith(t);
  assert.deepEqual(hive.capabilitiesOf('a1'), { unity: false, network: false, from: { unity: [], network: [] } });
  assert.equal(hive.brokerAgent('a1').unity, false, 'broker refuses with no card');
  assert.doesNotMatch(prompt(hive, home), /unity-requests/);

  hive.writeTasks([card('u', 'todo', { needs: ['unity'] })]);
  const caps = hive.capabilitiesOf('a1');
  assert.equal(caps.unity, true);
  assert.equal(caps.network, false);
  assert.deepEqual(caps.from.unity, ['card u']);
  assert.equal(hive.brokerAgent('a1').unity, true, 'broker accepts while the card is open');
  assert.match(prompt(hive, home), /unity-requests/, 'the Unity prompt line is injected');

  hive.writeTasks([card('u', 'done', { needs: ['unity'] })]);
  assert.equal(hive.capabilitiesOf('a1').unity, false, 'revoked once no open card needs it');
  assert.equal(hive.brokerAgent('a1').unity, false);
  assert.doesNotMatch(prompt(hive, home), /unity-requests/);
});

test('the spawn path makes the unity-requests folder for a card-granted agent', async (t) => {
  const { home, hive } = await hiveWith(t);
  hive.writeTasks([card('u', 'doing', { needs: ['unity'] })]);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  assert.equal(fs.existsSync(path.join(hive.root(), 'agents', 'a1', 'unity-requests')), true);
});

test('a card that needs network grants network; the registry flags stay an override', async (t) => {
  const { hive } = await hiveWith(t);
  hive.writeTasks([card('n', 'blocked', { needs: ['network'] })]);
  assert.equal(hive.capabilitiesOf('a1').network, true);
  assert.deepEqual(hive.capabilitiesOf('a1').from.network, ['card n']);
  assert.equal(hive.workspaceOf('a1').network, false, 'the stored flag is untouched by a card');

  const o = await hiveWith(t, { unity: true, network: true });
  const caps = o.hive.capabilitiesOf('a1');
  assert.equal(caps.unity, true);
  assert.equal(caps.network, true);
  assert.deepEqual(caps.from.unity, ['agent override']);
});
