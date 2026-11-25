'use strict';

/**
 * Hive log/ledger appends and the fleet snapshot no longer block the Electron main
 * thread (which forwards keystrokes): they go through asyncFileWriter. These pin that
 * the async path keeps order, loses nothing, and that readers still see queued lines.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { AppendQueue, LatestWriter } = loadTs('src/main/asyncFileWriter.ts');
const { HiveManager, readTailLines } = loadTs('src/main/hive.ts');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-asyncw-'));
  t.after(() => rmTree(d));
  return d;
}

test('appends are queued, not written on the calling tick, and land in order', async (t) => {
  const p = path.join(tmpDir(t), 'log.jsonl');
  const q = new AppendQueue();
  for (let i = 0; i < 500; i++) q.append(p, `${i}\n`);
  assert.equal(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '', '', 'nothing written synchronously');
  await q.flush();
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').map(Number);
  assert.deepEqual(lines, Array.from({ length: 500 }, (_, i) => i));
  assert.equal(q.unwritten(p), '');
});

test('flushSync writes what is still queued (process exit)', (t) => {
  const p = path.join(tmpDir(t), 'cost-ledger.jsonl');
  const q = new AppendQueue();
  q.append(p, 'a\n');
  q.append(p, 'b\n');
  q.flushSync();
  assert.ok(fs.readFileSync(p, 'utf8').endsWith('b\n'));
});

test('a snapshot burst writes the newest content and leaves no temp file', async (t) => {
  const dir = tmpDir(t);
  const p = path.join(dir, 'fleet.json');
  const w = new LatestWriter();
  for (let i = 0; i < 50; i++) w.write(p, JSON.stringify({ i }));
  await w.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { i: 49 });
  assert.deepEqual(fs.readdirSync(dir), ['fleet.json']);
});

test('readTailLines returns whole trailing lines from a file bigger than one chunk', (t) => {
  const p = path.join(tmpDir(t), 'log.jsonl');
  const rows = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(40) }));
  fs.writeFileSync(p, rows.join('\n') + '\n');
  const tail = readTailLines(p, 200).trim().split('\n');
  assert.ok(tail.length >= 200 && tail.length < 5000, 'reads only the end');
  assert.deepEqual(JSON.parse(tail[0]), JSON.parse(rows[rows.length - tail.length]), 'first line is whole');
  assert.equal(JSON.parse(tail[tail.length - 1]).i, 4999);
  assert.equal(readTailLines(p, 10000).trim().split('\n').length, 5000, 'short file: everything');
});

test('logTail sees an event appended this tick, before it reaches disk', async (t) => {
  const home = tmpDir(t);
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  const hive = new HiveManager(() => home);
  hive.appendLog({ kind: 'probe-a' });
  hive.appendLog({ kind: 'probe-b' });
  assert.deepEqual(hive.logTail(2).map((e) => e.kind), ['probe-a', 'probe-b']);
  await hive.flushWrites();
  assert.deepEqual(hive.logTail(2).map((e) => e.kind), ['probe-a', 'probe-b']);
});
