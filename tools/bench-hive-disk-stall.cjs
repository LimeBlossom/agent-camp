'use strict';
// Main-thread stall from the hive's per-beat writes while another process loads the
// disk. node tools/bench-hive-disk-stall.cjs <dir-on-the-hive-disk> [seconds]
// Runs the fleet snapshot (8 s), log.jsonl and cost-ledger appends at a compressed
// cadence, first with the old sync calls, then through asyncFileWriter, while `dd`
// streams writes to the same disk. Reports event-loop lag from a 10 ms heartbeat.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { AppendQueue, LatestWriter } = loadTs('src/main/asyncFileWriter.ts');
const dir = process.argv[2];
const secs = Number(process.argv[3] ?? 10);
const fleet = JSON.stringify({ agents: Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, pad: 'x'.repeat(1500) })) }, null, 2);
const line = JSON.stringify({ ts: Date.now(), kind: 'route', pad: 'x'.repeat(180) }) + '\n';

function load() {
  return spawn('dd', ['if=/dev/zero', `of=${path.join(dir, 'load.bin')}`, 'bs=1M', `count=${secs * 60}`, 'conv=fdatasync'], { stdio: 'ignore' });
}

async function run(label, ops) {
  const work = fs.mkdtempSync(path.join(dir, 'hive-'));
  const dd = load();
  const lags = [];
  let due = performance.now() + 10;
  const beat = setInterval(() => { const t = performance.now(); lags.push(t - due); due = t + 10; }, 10);
  const tick = setInterval(() => ops(work), 100);
  await new Promise((r) => setTimeout(r, secs * 1000));
  clearInterval(tick); clearInterval(beat);
  await ops.flush?.();
  if (dd.exitCode === null && dd.signalCode === null) {
    dd.kill();
    await new Promise((r) => dd.once('exit', r));
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'load.bin'), { force: true });
  lags.sort((a, b) => a - b);
  const pct = (p) => lags[Math.min(lags.length - 1, Math.floor(lags.length * p))].toFixed(0);
  const over = (ms) => lags.filter((l) => l >= ms).length;
  console.log(`${label.padEnd(6)} heartbeat lag p50 ${pct(0.5)} ms  p99 ${pct(0.99)} ms  max ${lags[lags.length - 1].toFixed(0)} ms  beats >=100 ms: ${over(100)}  >=250 ms: ${over(250)}`);
}

(async () => {
  let n = 0;
  await run('sync', (w) => {
    if (n++ % 8 === 0) fs.writeFileSync(path.join(w, 'fleet.json'), fleet, 'utf8');
    fs.appendFileSync(path.join(w, 'log.jsonl'), line, 'utf8');
    fs.appendFileSync(path.join(w, 'cost-ledger.jsonl'), line, 'utf8');
  });
  const q = new AppendQueue();
  const s = new LatestWriter();
  n = 0;
  const asyncOps = (w) => {
    if (n++ % 8 === 0) s.write(path.join(w, 'fleet.json'), fleet);
    q.append(path.join(w, 'log.jsonl'), line);
    q.append(path.join(w, 'cost-ledger.jsonl'), line);
  };
  asyncOps.flush = () => Promise.all([q.flush(), s.flush()]);
  await run('async', asyncOps);
})();
