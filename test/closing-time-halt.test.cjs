'use strict';

/**
 * "stop after this step" left an agent halted for good, and a halted agent's
 * every hook answers continue:false, so it never read the closing-time brief
 * and the shutdown waited on an ACK that could not come.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { ControlRegistry } = loadTs('src/main/control.ts');
const { ClosingTimeController } = loadTs('src/main/closingTime.ts');

function floor(t) {
  const control = new ControlRegistry();
  const sent = [];
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: { isGod: true }, dev1: {}, dev2: {} } }),
    send: (message) => sent.push(message)
  };
  const ct = new ClosingTimeController(hive, () => ['god', 'dev1', 'dev2'], () => null, () => {}, control);
  t.after(() => ct.cancel());
  return { control, ct, sent };
}

test('cancellation supersedes already delivered shutdown steers for every notified agent', (t) => {
  const { control, ct, sent } = floor(t);
  ct.start();
  for (const id of ['god', 'dev1', 'dev2']) assert.match(control.takeSteer(id), /WRAP UP/);
  ct.cancel();
  assert.equal(ct.isActive(), false);
  for (const id of ['god', 'dev1', 'dev2']) {
    assert.match(control.takeSteer(id), /WRAP-UP CANCELLED by the human.*supersedes.*Resume normal operation/);
    assert.equal(control.takeSteer(id), undefined, 'cancellation is delivered once');
  }
  assert.equal(sent.at(-1).subject, 'WRAP-UP CANCELLED');
});

test('cancellation replaces pending shutdown steers without lifting operator controls', (t) => {
  const { control, ct } = floor(t);
  ct.start();
  control.pause('dev1', true);
  control.halt('dev2');
  ct.cancel();
  for (const id of ['god', 'dev1', 'dev2']) {
    const note = control.takeSteer(id);
    assert.match(note, /WRAP-UP CANCELLED/);
    assert.doesNotMatch(note, /office is shutting down|shutdown brief is waiting/);
  }
  assert.equal(control.snapshot('dev1').paused, true);
  assert.equal(control.shouldHalt('dev2'), true);
});

test('inactive cancellation is a no-op and a later shutdown still requires worker ACKs', (t) => {
  const { control, ct, sent } = floor(t);
  ct.cancel();
  assert.equal(sent.length, 0);
  ct.start();
  ct.cancel();
  for (const id of ['god', 'dev1', 'dev2']) control.takeSteer(id);
  ct.cancel();
  assert.equal(control.takeSteer('dev1'), undefined);
  ct.start();
  assert.match(control.takeSteer('dev1'), /office is shutting down/);
  ct.onRouted({ from: 'god', subject: 'CLOSING-TIME-COMPLETE' }, ['human']);
  assert.equal(ct.isActive(), true, 'premature completion cannot shut down the floor');
});

test('closing time withdraws halts so every live agent can pack up', () => {
  const control = new ControlRegistry();
  control.halt('god');
  control.halt('dev1');
  control.pause('dev1', true);
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: { isGod: true }, dev1: {} } }),
    send: () => {}
  };
  const ct = new ClosingTimeController(hive, () => ['god', 'dev1'], () => null, () => {}, control);
  assert.equal(ct.start().ok, true);
  assert.equal(control.shouldHalt('god'), false);
  assert.equal(control.shouldHalt('dev1'), false);
  assert.equal(control.snapshot('dev1').paused, true, 'a tool pause is the operator\'s, not ours to lift');
  ct.cancel();
});

test('delivered cancellation uses the same hook additionalContext as shutdown', (t) => {
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true,
    exports: { Notification: class { static isSupported() { return false; } } } };
  const { HookServer } = loadTs('src/main/hooks.ts');
  const { control, ct } = floor(t);
  const hooks = new HookServer({ isGod: () => false, appendLog() {} }, () => null,
    () => ({ notifications: false }), control);
  ct.start();
  const order = hooks.handle({ agent_id: 'dev1', hook_event_name: 'PostToolUse' });
  assert.match(order.hookSpecificOutput.additionalContext, /office is shutting down/);
  ct.cancel();
  for (const hook_event_name of ['PostToolUse', 'UserPromptSubmit']) {
    const agent_id = hook_event_name === 'PostToolUse' ? 'dev1' : 'dev2';
    const result = hooks.handle({ agent_id, hook_event_name });
    assert.equal(result.hookSpecificOutput.hookEventName, hook_event_name);
    assert.match(result.hookSpecificOutput.additionalContext, /WRAP-UP CANCELLED.*supersedes/);
  }
});

test('a worker held at a spent usage limit is excused from the ACK', () => {
  const sent = [];
  const hive = {
    registry: () => ({ godId: 'god', agents: { god: { isGod: true }, dev1: {}, dev2: {} } }),
    send: (message) => sent.push(message)
  };
  const held = new Set(['dev2']);
  let concluded = false;
  const ct = new ClosingTimeController(hive, () => ['god', 'dev1', 'dev2'], () => null, () => { concluded = true; }, undefined, (id) => held.has(id));
  ct.start();
  assert.match(sent[0].body, /dev2\) \[out of usage quota: cannot answer, do not wait for it\]/);
  assert.doesNotMatch(sent[0].body, /dev1\) \[out of usage quota/);
  ct.onRouted({ from: 'dev1', subject: 'CLOSING-TIME-ACK' }, ['god']);
  ct.onRouted({ from: 'god', subject: 'CLOSING-TIME-COMPLETE' }, ['human']);
  assert.ok(!sent.some((m) => m.act === 'refuse'), 'the held worker does not block the conclusion');
  assert.equal(concluded, true, 'the conclusion hands off at once; the app owns the teardown grace');
  ct.cancel();
});
