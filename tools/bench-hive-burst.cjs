'use strict';
// Main-thread cost of a burst of task-patches through the outbox.
// node tools/bench-hive-burst.cjs [patches=100] [cards=172]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const PATCHES = Number(process.argv[2] || 100);
const CARDS = Number(process.argv[3] || 172);
const CARD_NOTES_BYTES = 7000; // 172 cards x ~7 KB = the live 1.2 MB tasks.json

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-burst-'));
  try {
    const hive = new HiveManager(() => home);
    await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
    await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });
    const cards = Array.from({ length: CARDS }, (_, i) => ({
      id: `c${i}`, title: `Card ${i}`, assignee: 'w1', status: 'todo', dependsOn: [], priority: 'high',
      createdAt: '2026-10-11T00:00:00.000Z', notes: 'n'.repeat(CARD_NOTES_BYTES)
    }));
    for (const id of ['god-1', 'w1']) fs.writeFileSync(path.join(home, 'hive', 'agents', id, 'memory-archive.md'), 'a');
    hive.writeTasks(cards);
    await hive.flushCommits?.();
    const root = path.join(home, 'hive');
    const commits = () => Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim());
    const before = commits();
    const outbox = path.join(root, 'agents', 'w1', 'outbox');
    for (let i = 0; i < PATCHES; i++) {
      fs.writeFileSync(path.join(outbox, `p${String(i).padStart(4, '0')}.json`),
        JSON.stringify({ to: 'harness', act: 'task-patch', body: { id: `c${i % CARDS}`, status: 'doing', notesAppend: `patch ${i}` } }));
    }
    // routeOnce is synchronous: its wall time is exactly how long the main thread is blocked.
    const t0 = process.hrtime.bigint();
    const routed = hive.routeOnce();
    const blockMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // Event-loop lag while any deferred commit runs.
    let maxLag = 0;
    let last = Date.now();
    const lagTimer = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; }, 10);
    const t1 = Date.now();
    await hive.flushCommits?.();
    clearInterval(lagTimer);
    const flushMs = Date.now() - t1;
    const doing = hive.tasks().tasks.filter((c) => c.status === 'doing').length;
    console.log(JSON.stringify({ patches: PATCHES, routed, cardsDoing: doing, routeOnceBlockMs: Math.round(blockMs), commitsAdded: commits() - before, flushMs, maxEventLoopLagMsDuringFlush: maxLag }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})();
