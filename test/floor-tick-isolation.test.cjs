'use strict';

/**
 * Snip 2026-11-21: idle agents stood frozen at their seats. Character.ts cannot
 * stay still after startWandering(), so their update() had stopped running: either
 * one character's update() threw (aborting the frame loop for every later
 * character) or the floor ticker never restarted after a pause. Neither left a
 * trace, because renderer.log kept only [theme] console lines.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { updateEachIsolated, createRateLimitedReporter } = loadTs('src/renderer/src/scene/office/tickIsolation.ts');
const { createTickerPauseGate, isFloorPaused } = loadTs('src/renderer/src/scene/office/tickerPause.ts');
const { keepRendererConsoleLine, RENDERER_ERROR_PREFIX, FLOOR_LOG_PREFIX } = loadTs('src/shared/rendererLog.ts');

test('one character whose update() throws does not stop the others ticking', () => {
  const ticked = [];
  const items = [
    { id: 'a', update: () => ticked.push('a') },
    { id: 'b', update: () => { throw new Error('boom'); } },
    { id: 'c', update: () => ticked.push('c') },
  ];
  const reports = [];
  for (let frame = 0; frame < 3; frame++) {
    updateEachIsolated(items, (it) => it.update(), (it, err) => reports.push([it.id, err.message]));
  }
  assert.deepEqual(ticked, ['a', 'c', 'a', 'c', 'a', 'c']);
  assert.deepEqual(reports[0], ['b', 'boom']);
});

test('a per-frame throw is logged once per interval with a suppressed count, not every frame', () => {
  let now = 0;
  const lines = [];
  const report = createRateLimitedReporter((line) => lines.push(line), { intervalMs: 30_000, now: () => now });
  const err = new Error('boom');
  for (let i = 0; i < 600; i++) { report('character maple', err); now += 16; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[floor\] character maple threw: .*boom/);
  now = 31_000;
  report('character maple', err);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\(\d+ more since last report\)/);
  // a different source is reported on its own clock
  report('character hazel', err);
  assert.equal(lines.length, 3);
});

test('renderer.log keeps theme lines, floor reports and forwarded renderer errors', () => {
  assert.equal(keepRendererConsoleLine('[theme] font loaded'), true);
  assert.equal(keepRendererConsoleLine(`${FLOOR_LOG_PREFIX} character x threw: y`), true);
  assert.equal(keepRendererConsoleLine(`${RENDERER_ERROR_PREFIX} TypeError: z`), true);
  assert.equal(keepRendererConsoleLine('random debug chatter'), false);
});

function fakeTicker() {
  return { started: true, start() { this.started = true; }, stop() { this.started = false; } };
}

test('pause conditions: fullscreen terminal, IDE, hidden document', () => {
  assert.equal(isFloorPaused({ fullscreenAgentId: null, ideOpen: false, docHidden: false }), false);
  assert.equal(isFloorPaused({ fullscreenAgentId: 'a', ideOpen: false, docHidden: false }), true);
  assert.equal(isFloorPaused({ fullscreenAgentId: null, ideOpen: true, docHidden: false }), true);
  assert.equal(isFloorPaused({ fullscreenAgentId: null, ideOpen: false, docHidden: true }), true);
});

test('the floor ticker restarts once every pause condition clears', () => {
  const gate = createTickerPauseGate();
  const t = fakeTicker();
  gate.attach(t);
  for (const cond of [
    { fullscreenAgentId: 'a', ideOpen: false, docHidden: false },
    { fullscreenAgentId: 'a', ideOpen: true, docHidden: false },
    { fullscreenAgentId: null, ideOpen: true, docHidden: true },
    { fullscreenAgentId: null, ideOpen: false, docHidden: true },
  ]) {
    gate.setPaused(isFloorPaused(cond));
    assert.equal(t.started, false);
  }
  gate.setPaused(isFloorPaused({ fullscreenAgentId: null, ideOpen: false, docHidden: false }));
  assert.equal(t.started, true);
});

test('a pause that begins and ends while the scene is still initialising leaves the ticker running', () => {
  const gate = createTickerPauseGate();
  gate.setPaused(true);
  gate.setPaused(false);
  const t = fakeTicker();
  gate.attach(t);           // init() finishing late
  assert.equal(t.started, true);
});

test('a pause still in force when init finishes stops the new ticker, and unpausing starts it', () => {
  const gate = createTickerPauseGate();
  gate.setPaused(true);
  const t = fakeTicker();
  gate.attach(t);
  assert.equal(t.started, false);
  gate.setPaused(false);
  assert.equal(t.started, true);
});

test('after a scene rebuild the gate drives the new ticker, not the destroyed one', () => {
  const gate = createTickerPauseGate();
  const old = fakeTicker();
  gate.attach(old);
  gate.setPaused(true);
  gate.detach(old);
  const fresh = fakeTicker();
  gate.attach(fresh);
  assert.equal(fresh.started, false);
  gate.setPaused(false);
  assert.equal(fresh.started, true);
  assert.equal(old.started, false);
});

test('uncaught renderer errors and unhandled rejections reach the kept log prefix', () => {
  const { installRendererErrorForwarding } = loadTs('src/renderer/src/rendererErrors.ts');
  const target = new EventTarget();
  const lines = [];
  installRendererErrorForwarding(target, (line) => lines.push(line));
  const e = new Event('error');
  e.error = new TypeError('cannot read x');
  e.message = 'cannot read x';
  target.dispatchEvent(e);
  const r = new Event('unhandledrejection');
  r.reason = new Error('rejected y');
  target.dispatchEvent(r);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => keepRendererConsoleLine(l)), lines.join('\n'));
  assert.match(lines[0], /cannot read x/);
  assert.match(lines[1], /rejected y/);
});
