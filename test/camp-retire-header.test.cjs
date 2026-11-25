'use strict';

/**
 * camp-retire-button-detail-header: Tests for the Retire button next to Edit in a dormant agent's header.
 *
 * Requirements:
 * 1. Retire button beside Edit in DormantAgentPanel header with confirm flow
 *    (openCardsFor names open cards, then window.cth.hiveSetArchived(id, true)).
 * 2. Lift the retire handler out of CommandCenterPanel's DormantSection into a shared helper/hook
 *    (src/renderer/src/hooks/useRetireAgent.ts) so both buttons call the same code.
 * 3. Reuse commandCenter.retire / retireTitle / retireConfirm / retireConfirmOpenCards strings.
 * 4. After retiring, the detail panel closes (selectedId -> null) or moves to another agent (selectedId -> agents[0].id).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Control imports from existing modules
const { openCardsFor } = loadTs('src/shared/agentArchive.ts');
const { archiveFromLists } = loadTs('src/renderer/src/store/archiveLists.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const agent = (id, extra = {}) => ({ id, name: id, status: 'idle', ...extra });

// ─── Step 2: Shared Hook / Helper Contract ───────────────────────────────────

test('step 2: useRetireAgent module exists at src/renderer/src/hooks/useRetireAgent.ts and exports useRetireAgent or retireAgent', () => {
  const hookPath = path.join(ROOT, 'src/renderer/src/hooks/useRetireAgent.ts');
  assert.ok(fs.existsSync(hookPath), 'src/renderer/src/hooks/useRetireAgent.ts must exist');

  const mod = loadTs('src/renderer/src/hooks/useRetireAgent.ts');
  const hasHook = typeof mod.useRetireAgent === 'function';
  const hasHelper = typeof mod.retireAgent === 'function';
  assert.ok(hasHook || hasHelper, 'useRetireAgent.ts must export useRetireAgent or retireAgent');
});

test('step 1 & 2: retire flow prompts with open cards list and archives on confirm', async () => {
  const hookPath = path.join(ROOT, 'src/renderer/src/hooks/useRetireAgent.ts');
  assert.ok(fs.existsSync(hookPath), 'src/renderer/src/hooks/useRetireAgent.ts must exist');
  const mod = loadTs('src/renderer/src/hooks/useRetireAgent.ts');

  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const promptTemplate = en.commandCenter.retireConfirmOpenCards;
  const expectedCards = 'card-1, card-2';
  const expectedPrompt = promptTemplate
    .replace('{{name}}', 'Sprout')
    .replace('{{cards}}', expectedCards);

  let confirmPrompt = null;
  let archivedId = null;
  let storeArchivedId = null;

  const mockCth = {
    hiveTasks: async () => ({
      tasks: [
        { id: 'card-1', assignee: 'sprout-id', status: 'todo' },
        { id: 'card-2', assignee: 'sprout-id', status: 'doing' },
        { id: 'card-3', assignee: 'other', status: 'doing' }
      ]
    }),
    hiveSetArchived: async (id, val) => {
      if (val) archivedId = id;
      return { ok: true };
    }
  };

  const mockConfirm = (msg) => {
    confirmPrompt = msg;
    return true;
  };

  const mockArchiveAgent = (id) => {
    storeArchivedId = id;
  };

  const mockT = (key, opts) => {
    if (key === 'commandCenter.retireConfirmOpenCards') {
      return en.commandCenter.retireConfirmOpenCards
        .replace('{{name}}', opts?.name ?? '')
        .replace('{{cards}}', opts?.cards ?? '');
    }
    return key;
  };

  if (typeof mod.retireAgent === 'function') {
    const res = await mod.retireAgent(
      { id: 'sprout-id', name: 'Sprout' },
      {
        t: mockT,
        confirm: mockConfirm,
        hiveTasks: mockCth.hiveTasks,
        hiveSetArchived: mockCth.hiveSetArchived,
        archiveAgent: mockArchiveAgent
      }
    );
    assert.equal(res, true);
  } else {
    // If exposed as hook only, invoke with mocked global/window
    const prevWindow = global.window;
    global.window = {
      cth: mockCth,
      confirm: mockConfirm
    };
    try {
      const hook = mod.useRetireAgent();
      assert.ok(typeof hook.retire === 'function', 'useRetireAgent must return { retire }');
      await hook.retire({ id: 'sprout-id', name: 'Sprout' });
    } finally {
      global.window = prevWindow;
    }
  }

  assert.equal(confirmPrompt, expectedPrompt, 'Confirm dialog must include agent name and open cards');
  assert.equal(archivedId, 'sprout-id', 'window.cth.hiveSetArchived must be called with agent id and true');
  assert.equal(storeArchivedId, 'sprout-id', 'store archiveAgent must be called to update renderer state');
});

test('step 1 & 2: retire flow prompts with standard confirm when no cards are open', async () => {
  const hookPath = path.join(ROOT, 'src/renderer/src/hooks/useRetireAgent.ts');
  assert.ok(fs.existsSync(hookPath), 'src/renderer/src/hooks/useRetireAgent.ts must exist');
  const mod = loadTs('src/renderer/src/hooks/useRetireAgent.ts');

  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const expectedPrompt = en.commandCenter.retireConfirm.replace('{{name}}', 'DormantBee');

  let confirmPrompt = null;
  let archivedId = null;

  const mockCth = {
    hiveTasks: async () => ({
      tasks: [
        { id: 'card-done', assignee: 'dormant-bee', status: 'done' },
        { id: 'card-blocked', assignee: 'dormant-bee', status: 'blocked' }
      ]
    }),
    hiveSetArchived: async (id, val) => {
      if (val) archivedId = id;
      return { ok: true };
    }
  };

  const mockConfirm = (msg) => {
    confirmPrompt = msg;
    return true;
  };

  const mockT = (key, opts) => {
    if (key === 'commandCenter.retireConfirm') {
      return en.commandCenter.retireConfirm.replace('{{name}}', opts?.name ?? '');
    }
    return key;
  };

  if (typeof mod.retireAgent === 'function') {
    const res = await mod.retireAgent(
      { id: 'dormant-bee', name: 'DormantBee' },
      {
        t: mockT,
        confirm: mockConfirm,
        hiveTasks: mockCth.hiveTasks,
        hiveSetArchived: mockCth.hiveSetArchived,
        archiveAgent: () => {}
      }
    );
    assert.equal(res, true);
  } else {
    const prevWindow = global.window;
    global.window = { cth: mockCth, confirm: mockConfirm };
    try {
      const hook = mod.useRetireAgent();
      await hook.retire({ id: 'dormant-bee', name: 'DormantBee' });
    } finally {
      global.window = prevWindow;
    }
  }

  assert.equal(confirmPrompt, expectedPrompt, 'Confirm dialog must use standard retireConfirm without open cards');
  assert.equal(archivedId, 'dormant-bee');
});

test('step 1 & 2: retire flow falls back gracefully when hiveTasks fails', async () => {
  const hookPath = path.join(ROOT, 'src/renderer/src/hooks/useRetireAgent.ts');
  assert.ok(fs.existsSync(hookPath), 'src/renderer/src/hooks/useRetireAgent.ts must exist');
  const mod = loadTs('src/renderer/src/hooks/useRetireAgent.ts');

  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  const expectedPrompt = en.commandCenter.retireConfirm.replace('{{name}}', 'OfflineAgent');

  let confirmPrompt = null;
  let archivedId = null;

  const mockCth = {
    hiveTasks: async () => { throw new Error('IPC failed'); },
    hiveSetArchived: async (id, val) => {
      if (val) archivedId = id;
      return { ok: true };
    }
  };

  const mockT = (key, opts) => {
    if (key === 'commandCenter.retireConfirm') {
      return en.commandCenter.retireConfirm.replace('{{name}}', opts?.name ?? '');
    }
    return key;
  };

  if (typeof mod.retireAgent === 'function') {
    const res = await mod.retireAgent(
      { id: 'offline-id', name: 'OfflineAgent' },
      {
        t: mockT,
        confirm: (msg) => { confirmPrompt = msg; return true; },
        hiveTasks: mockCth.hiveTasks,
        hiveSetArchived: mockCth.hiveSetArchived,
        archiveAgent: () => {}
      }
    );
    assert.equal(res, true);
  } else {
    const prevWindow = global.window;
    global.window = {
      cth: mockCth,
      confirm: (msg) => { confirmPrompt = msg; return true; }
    };
    try {
      const hook = mod.useRetireAgent();
      await hook.retire({ id: 'offline-id', name: 'OfflineAgent' });
    } finally {
      global.window = prevWindow;
    }
  }

  assert.equal(confirmPrompt, expectedPrompt, 'Falls back to standard confirm prompt without open cards list on error');
  assert.equal(archivedId, 'offline-id');
});

test('step 1 & 2: retire cancels cleanly when user declines confirmation', async () => {
  const hookPath = path.join(ROOT, 'src/renderer/src/hooks/useRetireAgent.ts');
  assert.ok(fs.existsSync(hookPath), 'src/renderer/src/hooks/useRetireAgent.ts must exist');
  const mod = loadTs('src/renderer/src/hooks/useRetireAgent.ts');

  let archivedCalled = false;
  let storeCalled = false;

  const mockCth = {
    hiveTasks: async () => ({ tasks: [] }),
    hiveSetArchived: async () => { archivedCalled = true; return { ok: true }; }
  };

  if (typeof mod.retireAgent === 'function') {
    const res = await mod.retireAgent(
      { id: 'keep-me', name: 'KeepMe' },
      {
        t: (k) => k,
        confirm: () => false,
        hiveTasks: mockCth.hiveTasks,
        hiveSetArchived: mockCth.hiveSetArchived,
        archiveAgent: () => { storeCalled = true; }
      }
    );
    assert.equal(res, false, 'retire must return false or abort when user cancels confirm');
  } else {
    const prevWindow = global.window;
    global.window = {
      cth: mockCth,
      confirm: () => false
    };
    try {
      const hook = mod.useRetireAgent();
      const res = await hook.retire({ id: 'keep-me', name: 'KeepMe' });
      assert.equal(res === false || res === undefined, true);
    } finally {
      global.window = prevWindow;
    }
  }

  assert.equal(archivedCalled, false, 'hiveSetArchived must not be called when cancelled');
  assert.equal(storeCalled, false, 'store archiveAgent must not be called when cancelled');
});

// ─── Step 1 & 3: DormantAgentPanel in AgentDetailPanel.tsx ────────────────────

test('step 1 & 3: DormantAgentPanel imports useRetireAgent and renders Retire button next to Edit in header', () => {
  const src = read('src/renderer/src/components/AgentDetailPanel.tsx');

  assert.match(src, /import\s+.*useRetireAgent.*from\s+['"]@\/hooks\/useRetireAgent['"]/,
    'AgentDetailPanel.tsx must import useRetireAgent from @/hooks/useRetireAgent');

  const dormantPanelIdx = src.indexOf('export function DormantAgentPanel');
  assert.ok(dormantPanelIdx > 0, 'DormantAgentPanel export exists in AgentDetailPanel.tsx');
  const dormantPanelSrc = src.slice(dormantPanelIdx);

  assert.match(dormantPanelSrc, /useRetireAgent\s*\(/,
    'DormantAgentPanel must call useRetireAgent()');

  // Verify header buttons: Edit button and Retire button
  const editButtonIdx = dormantPanelSrc.indexOf("setEditOpen(true)");
  assert.ok(editButtonIdx > 0, 'DormantAgentPanel contains edit button');

  // Retire button must be in header (before main panel body)
  const headerSlice = dormantPanelSrc.slice(0, dormantPanelSrc.indexOf("t('agentDetail.dormantTitle')"));

  assert.match(headerSlice, /commandCenter\.retireTitle/,
    'Retire button must reuse commandCenter.retireTitle for tooltip / title');
  assert.match(headerSlice, /commandCenter\.retire(?![a-zA-Z])/,
    'Retire button must reuse commandCenter.retire for button label');
  assert.match(headerSlice, /retire\s*\(\s*agent\s*\)/,
    'Retire button onClick must call retire(agent)');
});

// ─── Step 2: CommandCenterPanel Refactor ─────────────────────────────────────

test('step 2: CommandCenterPanel DormantSection imports useRetireAgent and removes duplicate handler', () => {
  const src = read('src/renderer/src/components/CommandCenterPanel.tsx');

  assert.match(src, /import\s+.*useRetireAgent.*from\s+['"]@\/hooks\/useRetireAgent['"]/,
    'CommandCenterPanel.tsx must import useRetireAgent from @/hooks/useRetireAgent');

  const dormantSectionIdx = src.indexOf('function DormantSection');
  assert.ok(dormantSectionIdx > 0, 'DormantSection function exists in CommandCenterPanel.tsx');
  const dormantSectionSrc = src.slice(dormantSectionIdx, src.indexOf('// ─── Memory tab', dormantSectionIdx));

  assert.match(dormantSectionSrc, /useRetireAgent\s*\(/,
    'DormantSection must call useRetireAgent()');

  // Must not define duplicate inline retire handler with openCardsFor logic
  assert.doesNotMatch(dormantSectionSrc, /openCardsFor\(a\.id/,
    'DormantSection must not define duplicate inline openCardsFor logic; use lifted useRetireAgent');
  assert.doesNotMatch(dormantSectionSrc, /window\.cth\.hiveSetArchived/,
    'DormantSection must delegate hiveSetArchived to lifted useRetireAgent');
});

// ─── Step 3: Localization Re-use Across All Locales ──────────────────────────

test('step 3: all locales define commandCenter retire keys and no redundant agentDetail retire keys exist', () => {
  const locales = ['en', 'ar', 'zh-CN'];
  for (const loc of locales) {
    const data = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    assert.ok(data.commandCenter, `locale ${loc} has commandCenter`);
    assert.ok(data.commandCenter.retire, `locale ${loc} has commandCenter.retire`);
    assert.ok(data.commandCenter.retireTitle, `locale ${loc} has commandCenter.retireTitle`);
    assert.ok(data.commandCenter.retireConfirm, `locale ${loc} has commandCenter.retireConfirm`);
    assert.ok(data.commandCenter.retireConfirmOpenCards, `locale ${loc} has commandCenter.retireConfirmOpenCards`);
  }

  // Ensure no redundant keys were created under agentDetail
  const en = JSON.parse(read('src/renderer/src/i18n/locales/en.json'));
  assert.equal(en.agentDetail?.retire, undefined, 'Must reuse commandCenter.retire rather than adding agentDetail.retire');
});

// ─── Step 4: Detail Panel Selection Closes or Moves ──────────────────────────

test('step 4: archiving a selected dormant agent moves selection to live agent or clears it', () => {
  // Case A: Live agents exist on the floor. Selection moves to agents[0].id.
  const stateWithLive = {
    agents: [agent('boss', { isGod: true }), agent('worker-1')],
    restorableAgents: [agent('dormant-1'), agent('dormant-2')],
    archivedAgents: [],
    feeds: {},
    messageQueues: {},
    selectedId: 'dormant-1',
    fullscreenAgentId: null
  };

  const nextListsA = archiveFromLists(stateWithLive, 'dormant-1');
  assert.ok(nextListsA, 'archiveFromLists must succeed for dormant-1');
  assert.deepEqual(nextListsA.restorableAgents.map((a) => a.id), ['dormant-2']);
  assert.deepEqual(nextListsA.archivedAgents.map((a) => a.id), ['dormant-1']);

  // Verify store selection contract:
  useStore.setState(stateWithLive);
  useStore.getState().archiveAgent('dormant-1');
  const storeStateA = useStore.getState();
  assert.equal(storeStateA.selectedId, 'boss', 'Selection moves to another agent (agents[0].id)');
  assert.deepEqual(storeStateA.restorableAgents.map((a) => a.id), ['dormant-2']);
  assert.equal(storeStateA.archivedAgents.some((a) => a.id === 'dormant-1'), true);

  // Case B: No live agents on the floor (agents is empty). Selection becomes null (detail panel closes).
  const stateNoLive = {
    agents: [],
    restorableAgents: [agent('dormant-solo')],
    archivedAgents: [],
    feeds: {},
    messageQueues: {},
    selectedId: 'dormant-solo',
    fullscreenAgentId: null
  };

  useStore.setState(stateNoLive);
  useStore.getState().archiveAgent('dormant-solo');
  const storeStateB = useStore.getState();
  assert.equal(storeStateB.selectedId, null, 'Selection clears to null when no live agents remain (detail panel closes)');
  assert.deepEqual(storeStateB.restorableAgents, []);
  assert.equal(storeStateB.archivedAgents.some((a) => a.id === 'dormant-solo'), true);

  // Case C: Archiving an agent that is NOT currently selected does not disturb selection.
  const stateUnselected = {
    agents: [agent('boss', { isGod: true })],
    restorableAgents: [agent('dormant-other'), agent('dormant-target')],
    archivedAgents: [],
    feeds: {},
    messageQueues: {},
    selectedId: 'boss',
    fullscreenAgentId: null
  };

  useStore.setState(stateUnselected);
  useStore.getState().archiveAgent('dormant-target');
  const storeStateC = useStore.getState();
  assert.equal(storeStateC.selectedId, 'boss', 'Selection remains unchanged when archiving an unselected agent');
});
