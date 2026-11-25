'use strict';

/**
 * Only an agent's memory files and markdown notes (palaceInputs.ts) may reach
 * the shared palace.
 *
 * Mining the whole agent folder put transcripts, html reports, json results and
 * bundled js into the index (2.7 GB, 323k chunks), and that bulk drowned real
 * memory hits in search. The fake CLI below records exactly which files the
 * directory it was handed to mine contains.
 */

process.env.MD_NO_AGENT_SCOPE = '1'; // no systemd-run wrapper around the fake CLI

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');

const AGENT = 'testy-abc123';

const FAKE_CLI = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const [cmd, dir] = process.argv.slice(2);
if (cmd !== 'mine') process.exit(0);
const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
  .sort();
fs.appendFileSync(process.env.FAKE_MINE_LOG, ['DIR ' + dir, ...files].join('\\n') + '\\n');
`;

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mine-scope-'));
  const agentDir = path.join(home, 'hive', 'agents', AGENT);
  fs.mkdirSync(path.join(agentDir, 'research'), { recursive: true });
  const write = (rel, text) => fs.writeFileSync(path.join(agentDir, rel), text);
  write('memory.md', '# digest\n');
  write('memory-archive.md', '# archive\n');
  write('settings.json', '{}');
  write('transcript.jsonl', '{"a":1}\n');
  write('bundle.js', 'console.log(1)\n');
  write('report.html', '<p>x</p>');
  write('notes.md', 'a top-level report');
  write('research/findings.md', 'nested markdown');

  const log = path.join(home, 'mine-log.txt');
  const bin = path.join(home, 'fake-mempalace');
  fs.writeFileSync(bin, FAKE_CLI);
  fs.chmodSync(bin, 0o755);
  process.env.FAKE_MINE_LOG = log;

  const memory = new MemoryManager(() => home, () => ({ enabled: true, model: 'minilm' }));
  memory.bin = () => bin; // the real one shells out to `which mempalace`
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  const runs = () => {
    if (!fs.existsSync(log)) return [];
    const out = [];
    for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
      if (line.startsWith('DIR ')) out.push({ dir: line.slice(4), files: [] });
      else out[out.length - 1].files.push(line);
    }
    return out;
  };
  return { memory, agentDir, runs };
}

/** Push a file's mtime forward so the mine loop's change check sees it. */
function touchLater(file) {
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

test('a mine sees the memory files and markdown notes and no other file', async (t) => {
  const { memory, agentDir, runs } = setup(t);

  await memory.mineNow();

  const r = runs();
  assert.equal(r.length, 1, 'one mine for the one agent');
  assert.notEqual(path.resolve(r[0].dir), path.resolve(agentDir), 'never the whole agent folder');
  assert.deepEqual(r[0].files, ['memory-archive.md', 'memory.md', 'notes.md', path.join('research', 'findings.md')]);
});

test('the mined copies carry the agent\'s current text', async (t) => {
  const { memory, runs } = setup(t);

  await memory.mineNow();

  const dir = runs()[0].dir;
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), '# digest\n');
  assert.equal(fs.readFileSync(path.join(dir, 'memory-archive.md'), 'utf8'), '# archive\n');
});

test('an archive-only change is mined again', async (t) => {
  const { memory, agentDir, runs } = setup(t);

  await memory.mineNow();
  fs.appendFileSync(path.join(agentDir, 'memory-archive.md'), 'moved here\n');
  touchLater(path.join(agentDir, 'memory-archive.md'));
  await memory.mineNow();

  assert.equal(runs().length, 2);
});

test('an archive the agent removed is not mined from a stale copy', async (t) => {
  const { memory, agentDir, runs } = setup(t);

  await memory.mineNow();
  fs.rmSync(path.join(agentDir, 'memory-archive.md'));
  touchLater(path.join(agentDir, 'memory.md'));
  await memory.mineNow();

  assert.deepEqual(runs()[1].files, ['memory.md', 'notes.md', path.join('research', 'findings.md')]);
});

test('mining never edits the agent\'s own folder', async (t) => {
  const { memory, agentDir } = setup(t);
  const before = fs.readdirSync(agentDir).sort();

  await memory.mineNow();

  assert.deepEqual(fs.readdirSync(agentDir).sort(), before);
});
