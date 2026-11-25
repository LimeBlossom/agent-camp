'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { spawnSync } = require('node:child_process');

const { trimMemoryDigest, trimMemoryFile } = loadTs('src/main/memoryTrim.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

test('H2-first oversized digest terminates within a bounded child process', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { trimMemoryDigest } = require(${JSON.stringify(path.join(__dirname, '..', 'test-support', 'load-ts.cjs'))})('src/main/memoryTrim.ts');
    const original = '## Rules\\n' + 'x'.repeat(8000);
    const result = trimMemoryDigest(original, 8000);
    process.stdout.write(JSON.stringify({ original, result }));
  `], { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 128 * 1024 });
  assert.equal(child.error, undefined, `child must finish rather than hang: ${child.error?.message}; stderr: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  const { original, result } = JSON.parse(child.stdout);
  assert.ok(result.keep.length < 8000);
  assertLosslessPartition(original, result.keep, result.moved);
});

test('trimMemoryDigest returns null when memory text is under cap', () => {
  const short = '# Memory\n\n## 2026-11-01 Old\ntext\n\n## 2026-11-02 New\ntext\n';
  assert.equal(trimMemoryDigest(short, 1000), null);
});

test('trimMemoryDigest moves oldest dated sections first, keeping undated and newest dated sections', () => {
  const text = [
    '# Memory - Test Agent',
    '',
    '## Standing rules',
    '- Rule 1: always be careful',
    '',
    '## 2026-11-01 Oldest task',
    'Finished task one details.',
    '',
    '## 2026-11-03 Middle task',
    'Finished task two details.',
    '',
    '## 2026-11-05 Newest task',
    'Work in progress details.'
  ].join('\n');

  // Cap small enough to force moving 2026-11-01 but keep 2026-11-03 and 2026-11-05
  const cap = text.length - 20;
  const res1 = trimMemoryDigest(text, cap);
  assert.ok(res1);
  assert.match(res1.moved, /## 2026-11-01 Oldest task/);
  assert.doesNotMatch(res1.moved, /## 2026-11-03 Middle task/);
  assert.match(res1.keep, /## Standing rules/);
  assert.match(res1.keep, /## 2026-11-03 Middle task/);
  assert.match(res1.keep, /## 2026-11-05 Newest task/);
  assert.ok(res1.keep.length < cap);

  // Cap very tight: both 2026-11-01 and 2026-11-03 move, but 2026-11-05 (newest) stays
  const tightCap = 80;
  const res2 = trimMemoryDigest(text, tightCap);
  assert.ok(res2);
  assert.match(res2.moved, /## 2026-11-01 Oldest task/);
  assert.match(res2.moved, /## 2026-11-03 Middle task/);
  assert.match(res2.keep, /## Standing rules/);
  assert.match(res2.keep, /## 2026-11-05 Newest task/);
});

test('trimMemoryDigest breaks date ties by document order', () => {
  const text = [
    '# Header',
    '',
    '## 2026-11-01 First on same day',
    'Some details A.',
    '',
    '## 2026-11-01 Second on same day',
    'Some details B.',
    '',
    '## 2026-11-02 Newer day',
    'Latest work.'
  ].join('\n');

  // Cap requiring moving only 1 section
  const cap = text.length - 20;
  const res = trimMemoryDigest(text, cap);
  assert.ok(res);
  assert.match(res.moved, /## 2026-11-01 First on same day/);
  assert.doesNotMatch(res.moved, /## 2026-11-01 Second on same day/);
  assert.match(res.keep, /## 2026-11-01 Second on same day/);
  assert.match(res.keep, /## 2026-11-02 Newer day/);
});

function assertLosslessPartition(original, keep, moved) {
  assert.equal(keep.length + moved.length, original.length, 'every original character must occur exactly once');
  // Accept any split, including cuts inside lines, while preserving each stream's order.
  let positions = new Set([0]);
  for (let i = 0; i < original.length; i++) {
    const next = new Set();
    for (const k of positions) {
      const m = i - k;
      if (keep[k] === original[i]) next.add(k + 1);
      if (m < moved.length && moved[m] === original[i]) next.add(k);
    }
    assert.ok(next.size, `content or newline lost, duplicated, or changed at original offset ${i}`);
    positions = next;
  }
  assert.ok(positions.has(keep.length), 'keep and moved must account for the complete original');
}

function payload(start, length) {
  return Array.from({ length }, (_, i) => String.fromCharCode(0x3000 + start + i)).join('');
}

const losslessCases = {
  undated: '# Memory\n\n## Rules\n' + payload(0, 4300) + '\n\n## Context\n' + payload(4300, 4200) + '\n\n\n',
  'single-dated': '# Memory\n\n## Rules\n' + payload(0, 4300) + '\n\n## 2026-11-06 Only date\n' + payload(4300, 4200) + '\n\n\n',
  'undated-dominant': '# Memory\n\n## Rules\n' + payload(0, 8500) + '\n\n## 2026-11-01 Old\nold\n\n## 2026-11-06 New\nnew\n\n\n',
  'multiple-dated': '# Memory\n\n## 2026-11-01 Old\n' + payload(0, 4300) + '\n\n## 2026-11-02 Middle\n' + payload(4300, 1000) + '\n\n## 2026-11-06 New\n' + payload(5300, 3200) + '\n\n\n',
  'exact-8000': payload(0, 7997) + '\n\n\n'
};

for (const suffix of ['', 'z\n']) {
  test(`trimMemoryFile conserves astral code points through actual UTF8 disk writes (${suffix ? 'with suffix' : 'at EOF'})`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mem-unicode-'));
    t.after(() => rmTree(dir));
    const memPath = path.join(dir, 'memory.md');
    const archivePath = path.join(dir, 'memory-archive.md');
    const original = 'a'.repeat(7998) + '😀' + suffix;
    const oldArchive = 'Existing archive 🐊\n\n';
    fs.writeFileSync(memPath, original, 'utf8');
    fs.writeFileSync(archivePath, oldArchive, 'utf8');
    assert.equal(fs.readFileSync(memPath, 'utf8'), original);
    const movedChars = trimMemoryFile(dir, '2026-11-06', 8000);
    const keep = fs.readFileSync(memPath, 'utf8');
    const archive = fs.readFileSync(archivePath, 'utf8');
    const header = '\n\n## Archived from memory.md 2026-11-06 (harness digest trim)\n\n';
    assert.ok(archive.startsWith(oldArchive + header), 'old archive and framing remain exact');
    assert.ok(archive.endsWith('\n'));
    const moved = archive.slice(oldArchive.length + header.length, -1);
    assert.ok(keep.length < 8000, 'strict UTF16 digest cap');
    assert.ok(movedChars > 0);
    assert.equal(moved.length, movedChars, 'returned count describes on-disk archived text');
    assert.equal(keep + moved, original, 'UTF8 roundtrip must conserve exact text, including the whole emoji');
    assertLosslessPartition(original, keep, moved);
    assert.deepEqual(Buffer.concat([fs.readFileSync(memPath), Buffer.from(moved, 'utf8')]), Buffer.from(original, 'utf8'));
    for (const stream of [keep, moved]) {
      assert.equal(Buffer.from(stream, 'utf8').toString('utf8'), stream, 'no unpaired surrogate in either stream');
      assert.doesNotMatch(stream, /\uFFFD/);
    }
  });
}

for (const [name, original] of Object.entries(losslessCases)) {
  test(`trimMemoryDigest strictly caps ${name} text and conserves every character and newline`, () => {
    assert.ok(original.length >= 8000);
    const result = trimMemoryDigest(original, 8000);
    assert.ok(result, 'text at or above 8000 must be trimmed');
    assertLosslessPartition(original, result.keep, result.moved);
    assert.ok(result.keep.length < 8000, `digest must be <8000, got ${result.keep.length}`);
    assert.ok(result.moved.length > 0);
  });

  test(`trimMemoryFile conserves ${name} text and appends without changing the old archive`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mem-lossless-'));
    t.after(() => rmTree(dir));
    const memPath = path.join(dir, 'memory.md');
    const archivePath = path.join(dir, 'memory-archive.md');
    const oldArchive = 'Existing archive with significant trailing whitespace.  \n\n\n';
    fs.writeFileSync(memPath, original);
    fs.writeFileSync(archivePath, oldArchive);
    const movedChars = trimMemoryFile(dir, '2026-11-06', 8000);
    assert.ok(movedChars > 0, 'text at or above 8000 must be archived');
    const keep = fs.readFileSync(memPath, 'utf8');
    const archive = fs.readFileSync(archivePath, 'utf8');
    assert.equal(archive.slice(0, oldArchive.length), oldArchive, 'old archive must remain an exact prefix');
    const header = '\n\n## Archived from memory.md 2026-11-06 (harness digest trim)\n\n';
    const appended = archive.slice(oldArchive.length);
    assert.ok(appended.startsWith(header));
    assert.equal(appended.slice(header.length + movedChars), '\n', 'only the archive framing newline may follow moved content');
    const moved = appended.slice(header.length, header.length + movedChars);
    assertLosslessPartition(original, keep, moved);
    assert.ok(keep.length < 8000, `digest must be <8000, got ${keep.length}`);
  });
}

test('trimMemoryFile trims memory.md, appends to memory-archive.md, and updates atomically', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mem-file-'));
  t.after(() => rmTree(dir));

  const memPath = path.join(dir, 'memory.md');
  const arcPath = path.join(dir, 'memory-archive.md');

  // Missing memory.md returns 0
  assert.equal(trimMemoryFile(dir, '2026-11-06', 100), 0);

  const text = [
    '# Memory',
    '',
    '## 2026-11-01 Old task',
    'Older notes.',
    '',
    '## 2026-11-06 Current task',
    'Current notes.'
  ].join('\n');

  fs.writeFileSync(memPath, text, 'utf8');

  // Under cap: returns 0, no archive created
  assert.equal(trimMemoryFile(dir, '2026-11-06', 1000), 0);
  assert.equal(fs.existsSync(arcPath), false);

  // Over cap: trims
  const movedChars = trimMemoryFile(dir, '2026-11-06', 40);
  assert.ok(movedChars > 0);
  assert.equal(fs.existsSync(memPath), true);
  assert.equal(fs.existsSync(arcPath), true);

  const newMem = fs.readFileSync(memPath, 'utf8');
  const arc = fs.readFileSync(arcPath, 'utf8');

  assert.doesNotMatch(newMem, /## 2026-11-01 Old task/);
  assert.match(newMem, /## 2026-11-06 Current task/);

  assert.match(arc, /## Archived from memory\.md 2026-11-06 \(harness digest trim\)/);
  assert.match(arc, /## 2026-11-01 Old task/);
  assert.match(arc, /Older notes\./);

  // Subsequent append adds onto existing archive
  const moreMem = [
    newMem.trim(),
    '',
    '## 2026-11-07 Next day',
    'Newer notes.'
  ].join('\n');
  fs.writeFileSync(memPath, moreMem, 'utf8');

  const movedChars2 = trimMemoryFile(dir, '2026-11-07', 40);
  assert.ok(movedChars2 > 0);
  const updatedArc = fs.readFileSync(arcPath, 'utf8');
  assert.match(updatedArc, /## Archived from memory\.md 2026-11-06/);
  assert.match(updatedArc, /## Archived from memory\.md 2026-11-07/);
});

test('HiveManager startPrompt trims memory.md and logs memory-trimmed on spawn', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-mem-'));
  t.after(() => rmTree(home));

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  const agentDir = path.join(home, 'hive', 'agents', 'w1');
  const memPath = path.join(agentDir, 'memory.md');

  // Fill memory.md over 8000 chars with dated sections
  const oldSection = '## 2026-11-01 Old section\n' + 'x'.repeat(5000) + '\n\n';
  const newSection = '## 2026-11-06 New section\n' + 'y'.repeat(4000) + '\n';
  fs.writeFileSync(memPath, '# Memory\n\n' + oldSection + newSection, 'utf8');

  assert.ok(fs.readFileSync(memPath, 'utf8').length > 8000);

  // Spawning / starting prompt should trim memory.md
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  const trimmedMem = fs.readFileSync(memPath, 'utf8');
  assert.ok(trimmedMem.length < 8000, `expected trimmed size < 8000, got ${trimmedMem.length}`);
  assert.doesNotMatch(trimmedMem, /## 2026-11-01 Old section/);
  assert.match(trimmedMem, /## 2026-11-06 New section/);

  const archive = fs.readFileSync(path.join(agentDir, 'memory-archive.md'), 'utf8');
  assert.match(archive, /## 2026-11-01 Old section/);

  const log = hive.logTail(100);
  assert.ok(log.some((e) => e.kind === 'memory-trimmed' && e.agentId === 'w1' && e.chars > 0));
});
