'use strict';
// agy and grok read their hooks from ONE per-user file. A test hive that wrote its own
// fixture paths there left every real agy agent's hooks pointing at a deleted folder:
// no Stop ever reached Camp, the agent never read as idle, and restart-camp refused
// with "<agent> is mid-step" forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { TodoNudger } = loadTs('src/main/todoNudge.ts');

const userFiles = (home) => [
  path.join(home, '.gemini', 'config', 'hooks.json'),
  path.join(home, '.gemini', 'antigravity-cli', 'hooks.json'),
  path.join(home, '.grok', 'hooks', 'munder-hive.json')
];

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-agy-user-home-')));
  t.after(() => rmTree(base));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const realHome = process.env.HOME;
  const realTmp = process.env.TMPDIR;
  process.env.HOME = home;
  // agent-guard.test.cjs moves TMPDIR under its base, so its hive no longer sits
  // "under the temp dir" and no temp-path heuristic recognises it as a fixture.
  process.env.TMPDIR = path.join(base, 'tmp');
  fs.mkdirSync(process.env.TMPDIR);
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp;
  });
  assert.equal(os.homedir(), home, 'home redirect failed; aborting before touching the real home');
  const hiveHome = path.join(base, 'hive-x');
  return { home, hiveHome, hive: new HiveManager(() => hiveHome) };
}

test('a hive not given the user home never writes the per-user agy or grok hooks', async (t) => {
  const { home, hive } = fixture(t);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: home });
  hive.installAgyHooks();
  hive.installGrokHooks();
  for (const f of userFiles(home)) assert.equal(fs.existsSync(f), false, `${f} was written by a hive that does not own it`);
});

test('the hive given the user home writes agy hooks whose commands all exist', async (t) => {
  const { home, hive } = fixture(t);
  hive.setUserConfigHome(home);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: home });
  hive.installAgyHooks();
  for (const f of userFiles(home).slice(0, 2)) {
    const group = JSON.parse(fs.readFileSync(f, 'utf8'))['munder-hive'];
    const stop = group.Stop[0].command;
    for (const p of stop.match(/"[^"]+"/g).map((q) => q.slice(1, -1))) assert.ok(fs.existsSync(p), `${p} missing`);
  }
});

test('an agy agent whose Stop hook arrives reads as idle, and its next turn as mid-step', () => {
  const nudger = new TodoNudger({
    facts: () => ({ eligible: false, hasMail: false, cards: [] }),
    nudge: () => {}, ignored: () => {}, close: () => {}
  });
  nudger.noteHook('quince-1', 'PreToolUse');
  assert.equal(nudger.isIdle('quince-1'), false);
  nudger.noteHook('quince-1', 'Stop');
  assert.equal(nudger.isIdle('quince-1'), true);
  nudger.noteHook('quince-1', 'PreInvocation');
  assert.equal(nudger.isIdle('quince-1'), false);
  nudger.cancelAll();
});
