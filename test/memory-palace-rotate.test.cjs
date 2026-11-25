'use strict';

/**
 * The mine loop rotates an out-of-scope palace before it mines anything, and
 * mines nothing while the rotation is refused, so no memory-only chunk ever
 * lands in the old palace.
 */

process.env.MD_NO_AGENT_SCOPE = '1'; // no systemd-run wrapper around the fake CLI

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');
const { PALACE_SCOPE, SCOPE_MARKER } = loadTs('src/main/palaceScope.ts');

const AGENT = 'testy-abc123';

const FAKE_CLI = `#!${process.execPath}
const fs = require('fs');
const [cmd] = process.argv.slice(2);
if (cmd !== 'mine') process.exit(0);
const palace = process.env.MEMPALACE_PALACE_PATH;
const marker = require('path').join(palace, '${SCOPE_MARKER}');
fs.appendFileSync(process.env.FAKE_MINE_LOG,
  'MINE ' + (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 'unmarked') + '\\n');
`;

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-palace-rotate-'));
  const agentDir = path.join(home, 'hive', 'agents', AGENT);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# digest\n');
  const palace = path.join(home, 'palace');
  fs.mkdirSync(palace);
  fs.writeFileSync(path.join(palace, 'chroma.sqlite3'), 'old bulk');

  const log = path.join(home, 'mine-log.txt');
  const bin = path.join(home, 'fake-mempalace');
  fs.writeFileSync(bin, FAKE_CLI);
  fs.chmodSync(bin, 0o755);
  process.env.FAKE_MINE_LOG = log;

  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  memory.bin = () => bin; // the real one shells out to `which mempalace`
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const mines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { memory, home, palace, mines };
}

test('the first mine pass rotates an unmarked palace, then mines into the fresh one', async (t) => {
  const { memory, home, palace, mines } = setup(t);
  memory.mempalaceLive = () => false;

  await memory.mineNow();

  const old = fs.readdirSync(home).filter((n) => n.startsWith('palace-old-'));
  assert.equal(old.length, 1);
  assert.equal(fs.readFileSync(path.join(home, old[0], 'chroma.sqlite3'), 'utf8'), 'old bulk');
  assert.equal(fs.readFileSync(path.join(palace, SCOPE_MARKER), 'utf8'), PALACE_SCOPE);
  assert.deepEqual(mines(), [`MINE ${PALACE_SCOPE}`]);
});

test('while the rotation is refused nothing is mined; the next pass rotates and mines', async (t) => {
  const { memory, home, palace, mines } = setup(t);
  let live = true;
  memory.mempalaceLive = () => live;

  await memory.mineNow();

  assert.deepEqual(mines(), []);
  assert.equal(fs.existsSync(path.join(palace, SCOPE_MARKER)), false);
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('palace-old-')), []);

  live = false;
  await memory.mineNow();

  assert.deepEqual(mines(), [`MINE ${PALACE_SCOPE}`]);
  assert.equal(fs.readdirSync(home).filter((n) => n.startsWith('palace-old-')).length, 1);
});
