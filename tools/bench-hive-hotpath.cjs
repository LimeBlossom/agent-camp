'use strict';
// Main-thread cost of the hive reads the app's timers repeat, on a COPY of a live hive's
// tasks.json, registry.json and log.jsonl. node tools/bench-hive-hotpath.cjs <hiveRoot>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const live = process.argv[2];
const RUNS = 20;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hotpath-'));
try {
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  for (const f of ['tasks.json', 'registry.json', 'log.jsonl']) fs.copyFileSync(path.join(live, f), path.join(root, f));
  const reg = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  for (const id of Object.keys(reg.agents)) {
    for (const sub of ['inbox', 'outbox/.sent']) fs.mkdirSync(path.join(root, 'agents', id, sub), { recursive: true });
  }
  const hive = new HiveManager(() => home);
  const time = (label, fn, cadence) => {
    fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < RUNS; i++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
    console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(7)} ms   ${cadence}`);
  };
  time('tasks() parse of tasks.json', () => hive.tasks(), 'Slack + webhook done polls, 5 s each');
  time('registry()', () => hive.registry(), 'fleet 8 s, wake/breaker beats, every route');
  time('refreshTaskViews(force) (cards changed)', () => hive.refreshTaskViews(true), 'fleet 8 s, only when tasks.json changed');
  time('routeOnce() with empty outboxes', () => hive.routeOnce(), 'router 1.5 s');
  time('logTail(200) of log.jsonl', () => hive.logTail(200), 'standup gate, hive:log IPC');
  time('inboxBacklog() for every agent', () => { for (const id of Object.keys(reg.agents)) hive.inboxBacklog(id); }, 'fleet 8 s');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
