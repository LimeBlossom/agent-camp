'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function mainHandler({ cards = [], hasMail = false, idle = true, boundary = true, eligible = true, canClose = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf("ipcMain.handle('hive:cardClose',");
  const snippet = source.slice(start, source.indexOf('\n});', start) + 4);
  let handler;
  const kills = [];
  const ctx = {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    isDesktopSender: () => false, ptyForAgent: () => 'pty',
    pendingCardCloses: new Set(['worker']),
    refuseCardClose: (_id, error) => ({ ok: false, error }),
    todoNudgeFacts: () => ({ eligible, canClose, cards, hasMail }),
    todoNudger: { closeStands: () => idle, shouldClose: () => boundary, finished: () => true },
    ptyManager: { kill: id => kills.push(id) }, teardownPty: () => {},
    hive: { appendLog: () => {} }, console: { log: () => {} }
  };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  return { result: handler({ sender: {} }, 'worker'), kills };
}

test('accepted last-card close parks; open work or unread mail requests a fresh wake', () => {
  for (const [state, wake] of [[{}, false], [{ cards: [{ id: 'next', status: 'todo' }] }, true], [{ hasMail: true }, true]]) {
    const h = mainHandler(state);
    assert.equal(h.result.ok, true);
    assert.equal(h.result.wake, wake);
    assert.deepEqual(h.kills, ['pty']);
  }
});

test('main revalidates idle, handoff, eligibility and closeability before killing', () => {
  for (const state of [{ idle: false }, { boundary: false }, { eligible: false }, { canClose: false }]) {
    const h = mainHandler(state);
    assert.equal(h.result.ok, false);
    assert.deepEqual(h.kills, []);
  }
});

test('renderer honors parked result and preserves queued-message/draft guards', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/hooks/useHive.ts'), 'utf8');
  const start = source.indexOf('const offCardClose =');
  const snippet = source.slice(start, source.indexOf('\n    const offIdlePark', start));
  for (const [wake, draft, queue] of [[false, '', []], [true, '', []], [true, 'unfinished message', []], [true, '', ['pending']]]) {
    let callback;
    const calls = [];
    const agent = { id: 'worker', ptyId: 'pty', cwd: '/project' };
    const state = { agents: [agent], messageQueues: { worker: queue }, drafts: { worker: draft }, sleepAgent: (_id, opts) => calls.push(['sleep', opts.rewaking]) };
    const ctx = {
      window: { cth: {
        onHiveCardCloseDue: fn => { callback = fn; },
        hiveCardCloseRefuse: (_id, reason) => { calls.push(['refuse', reason]); return Promise.resolve(); },
        hiveCardClose: () => { calls.push(['close']); return Promise.resolve({ ok: true, wake }); }
      } },
      closing: false, config: {}, useStore: { getState: () => state },
      disposeTerminal: () => {}, wakeDormantAgent: () => calls.push(['wake']), console: { log: () => {} }
    };
    vm.createContext(ctx);
    vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
    await callback({ agentId: 'worker' });
    if (draft || queue.length) assert.deepEqual(calls, [['refuse', draft ? 'draft' : 'queued-message']]);
    else assert.deepEqual(calls, [['close'], ['sleep', wake], ...(wake ? [['wake']] : [])]);
  }
});
