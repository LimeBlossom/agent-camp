'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { StallProbe, STALL_REPORT_MS } = loadTs('src/main/stallProbe.ts');
const { inputLagReport } = loadTs('src/renderer/src/perf/inputLagProbe.ts');

function clockProbe() {
  let now = 0;
  const reports = [];
  const probe = new StallProbe((r) => reports.push(r), () => now);
  return { probe, reports, advance: (ms) => { now += ms; } };
}

test('a slow wrapped run is reported with its label; a fast one is not', () => {
  const { probe, reports, advance } = clockProbe();
  probe.timed('ipc:hive:tasks', () => advance(5));
  probe.timed('timer:writeFleetSnapshot', () => advance(STALL_REPORT_MS + 20));
  assert.deepEqual(reports, [{ kind: 'main-stall', what: 'timer:writeFleetSnapshot', ms: STALL_REPORT_MS + 20 }]);
});

test('a heartbeat gap nobody wrapped is reported; one a wrapped run explains is not', () => {
  const { probe, reports, advance } = clockProbe();
  probe.heartbeatGap(0, 400);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].what, 'heartbeat');

  reports.length = 0;
  advance(1000);
  probe.timed('timer:limitBeat', () => advance(300));
  reports.length = 0;
  probe.heartbeatGap(1000, 320);
  assert.deepEqual(reports, []);
});

test('input lag: a key that waited is reported, a prompt one is not', () => {
  assert.equal(inputLagReport({ name: 'keydown', startTime: 0, processingStart: 8, processingEnd: 9, duration: 16 }), null);
  assert.deepEqual(
    inputLagReport({ name: 'keydown', startTime: 0, processingStart: 640, processingEnd: 642, duration: 656 }),
    { what: 'keydown', waitMs: 640, handleMs: 2 }
  );
});
