'use strict';

/** A CLI that exits on its own (clean exit, not a crash) leaves its agent on the floor
 *  with a dead tab. Its last hook label ("using run_command") must not outlive it. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { clearRunStateForExitedPty } = loadTs('src/renderer/src/store/agentPatch.ts');
const { floorAgentsOf } = loadTs('src/renderer/src/scene/office/floorAgents.ts');

const agent = (id, extra = {}) => ({
  id, name: id, ptyId: `pty-${id}`, status: 'working', action: 'using run_command',
  currentStation: 'terminal', carrying: 'terminal', lastPrompt: 'do the card', ...extra
});

for (const provider of ['antigravity', 'claude', 'codex']) {
  test(`${provider}: a tool started, then the CLI exited -> no tool label on the floor`, () => {
    const agents = [agent('grook', { provider }), agent('bulba', { provider })];
    const after = clearRunStateForExitedPty(agents, 'pty-grook');
    const g = floorAgentsOf({ agents: after, restorableAgents: [] }).find((a) => a.id === 'grook');
    assert.equal(g.status, 'idle');
    assert.equal(g.action, '');
    assert.equal(g.carrying, undefined);
    assert.equal(g.lastPrompt, undefined);
    assert.equal(g.currentStation, 'desk');
  });
}

test('other agents keep their live run state', () => {
  const agents = [agent('grook'), agent('bulba')];
  const after = clearRunStateForExitedPty(agents, 'pty-grook');
  assert.equal(after[1], agents[1]);
});

test('an exit for a pty no agent owns changes nothing', () => {
  const agents = [agent('grook')];
  assert.equal(clearRunStateForExitedPty(agents, 'pty-nobody'), agents);
});

test('the terminal pool clears the run state when a pty exits', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  const exitHandler = src.slice(src.indexOf('window.cth.onPtyExit(ptyId'), src.indexOf('window.cth.onPtyRelaunch(ptyId'));
  assert.match(exitHandler, /ptyExited\(ptyId\)/);
});
