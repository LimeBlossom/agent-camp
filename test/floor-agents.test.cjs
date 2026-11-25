'use strict';

/** Who the camp floor draws: live agents, plus one being closed and woken fresh for a
 *  new card, so the swap does not walk it out and back in. Other dormant agents stay off. */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { floorAgentsOf } = loadTs('src/renderer/src/scene/office/floorAgents.ts');

const agent = (id, extra = {}) => ({ id, name: id, status: 'working', action: 'edit x', lastPrompt: 'do it', ...extra });

test('live agents are drawn as they are', () => {
  const agents = [agent('boss', { isGod: true }), agent('bulba')];
  assert.equal(floorAgentsOf({ agents, restorableAgents: [] }), agents);
});

test('a rewaking agent is drawn idle, with no stale activity or terminal', () => {
  const out = floorAgentsOf({ agents: [agent('bulba')], restorableAgents: [agent('grook', { rewaking: true, ptyId: 'pty-grook', action: 'dormant' })] });
  assert.deepEqual(out.map((a) => a.id), ['bulba', 'grook']);
  const g = out[1];
  assert.equal(g.status, 'idle');
  assert.equal(g.action, '');
  assert.equal(g.lastPrompt, undefined);
  assert.equal(g.ptyId, undefined);
});

test('launch-time sleepers, limit-switch sleepers and other dormant agents stay off the floor', () => {
  const out = floorAgentsOf({ agents: [], restorableAgents: [agent('sleeper'), agent('limit', { rewaking: undefined })] });
  assert.deepEqual(out, []);
});

test('never the Boss or prep assistant, never a duplicate of a live agent, never on a desktop mirror', () => {
  const restorableAgents = [agent('boss', { isGod: true, rewaking: true }), agent('prep', { isAssistant: true, rewaking: true }), agent('bulba', { rewaking: true })];
  assert.deepEqual(floorAgentsOf({ agents: [agent('bulba')], restorableAgents }).map((a) => a.id), ['bulba']);
  assert.deepEqual(floorAgentsOf({ agents: [], restorableAgents: [agent('grook', { rewaking: true })] }, true), []);
});
