'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');

const {
  BACKGROUND_PRIORITY,
  backgroundPriorityPrefix,
  wrapForBackgroundPriority,
  wrapAgentCommand,
  backgroundPriorityTools,
  inAgentScope
} = loadTs('src/main/agentScope.ts');

const TOOLS = { nice: '/usr/bin/nice', ionice: '/usr/bin/ionice' };
const IO_CLASS_REALTIME = 1;
const MAX_NICE = 19;

test('the background setting is low priority only: non-negative nice of at least 10, never realtime IO', () => {
  assert.ok(Number.isInteger(BACKGROUND_PRIORITY.nice));
  assert.ok(BACKGROUND_PRIORITY.nice >= 10 && BACKGROUND_PRIORITY.nice <= MAX_NICE);
  assert.notEqual(BACKGROUND_PRIORITY.ioClass, IO_CLASS_REALTIME);
  assert.ok([2, 3].includes(BACKGROUND_PRIORITY.ioClass));
  if (BACKGROUND_PRIORITY.ioClass === 2) assert.equal(BACKGROUND_PRIORITY.ioLevel, 7);
});

test('the prefix is nice then ionice, both read from the one setting', () => {
  assert.deepEqual(backgroundPriorityPrefix(TOOLS), [
    '/usr/bin/nice', '-n', String(BACKGROUND_PRIORITY.nice),
    '/usr/bin/ionice', '-c', String(BACKGROUND_PRIORITY.ioClass), '-n', String(BACKGROUND_PRIORITY.ioLevel)
  ]);
});

test('ionice missing: CPU nice still applies; nice missing: IO class still applies; neither: untouched', () => {
  assert.deepEqual(
    wrapForBackgroundPriority('/bin/x', ['a'], { nice: '/usr/bin/nice', ionice: null }),
    { file: '/usr/bin/nice', args: ['-n', String(BACKGROUND_PRIORITY.nice), '/bin/x', 'a'] }
  );
  assert.deepEqual(
    wrapForBackgroundPriority('/bin/x', ['a'], { nice: null, ionice: '/usr/bin/ionice' }),
    { file: '/usr/bin/ionice', args: ['-c', String(BACKGROUND_PRIORITY.ioClass), '-n', String(BACKGROUND_PRIORITY.ioLevel), '/bin/x', 'a'] }
  );
  const args = ['a'];
  const r = wrapForBackgroundPriority('/bin/x', args, { nice: null, ionice: null });
  assert.equal(r.file, '/bin/x');
  assert.equal(r.args, args);
});

test('agent command: systemd scope outermost, then priority, then the command with argv intact', () => {
  const r = wrapAgentCommand('/usr/bin/claude', ['--x', 'multi\nline'], { scope: true, tools: TOOLS });
  assert.equal(r.file, 'systemd-run');
  const dash = r.args.indexOf('--');
  assert.deepEqual(r.args.slice(dash + 1), [...backgroundPriorityPrefix(TOOLS), '/usr/bin/claude', '--x', 'multi\nline']);
  const noScope = wrapAgentCommand('/usr/bin/claude', ['--x'], { scope: false, tools: TOOLS });
  assert.equal(noScope.file, '/usr/bin/nice');
});

test('MD_NO_BACKGROUND_PRIORITY=1 turns the wrap off', () => {
  const prev = process.env.MD_NO_BACKGROUND_PRIORITY;
  process.env.MD_NO_BACKGROUND_PRIORITY = '1';
  try {
    assert.deepEqual(backgroundPriorityTools(), { nice: null, ionice: null });
  } finally {
    if (prev === undefined) delete process.env.MD_NO_BACKGROUND_PRIORITY; else process.env.MD_NO_BACKGROUND_PRIORITY = prev;
  }
});

function niceOf(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
}

async function waitForComm(pid, comm) {
  for (let i = 0; i < 100; i++) {
    try { if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === comm) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid ${pid} never became ${comm}`);
}

test('a child spawned through inAgentScope runs at the background nice and IO class, same pid', { skip: process.platform !== 'linux' }, async (t) => {
  const child = spawn(...(() => { const r = inAgentScope('sleep', ['5']); return [r.file, r.args]; })(), { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  await waitForComm(child.pid, 'sleep');
  assert.equal(niceOf(child.pid), Math.min(MAX_NICE, niceOf(process.pid) + BACKGROUND_PRIORITY.nice));
  if (backgroundPriorityTools().ionice === null) { t.diagnostic('ionice unavailable; IO class not checked'); return; }
  const io = execFileSync('ionice', ['-p', String(child.pid)], { encoding: 'utf8' }).trim();
  const expected = BACKGROUND_PRIORITY.ioClass === 3 ? /^idle/ : new RegExp(`^best-effort: prio ${BACKGROUND_PRIORITY.ioLevel}$`);
  assert.match(io, expected);
});

test('the Camp autobuild runs at background priority too', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/campBuildQueue.ts'), 'utf8');
  assert.match(src, /inBackgroundPriority\('bash'/);
});
