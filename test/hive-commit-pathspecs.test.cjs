'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The constant is read from source so this test does not load hive.ts and Electron.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
const literal = src.match(/export const HIVE_COMMIT_PATHSPECS: string\[\]\[\] = (\[[\s\S]*?\n\]);/)[1];
const SPECS = JSON.parse(literal.replace(/'/g, '"'));

test('the hive commit stages hive files and agent memory, not agent workspace output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-commit-'));
  const write = (rel, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    write('board.md'); write('research/r.md');
    write('agents/a/memory.md'); write('agents/a/identity.md'); write('agents/a/memory-archive.md');
    write('agents/a/notes.md'); write('agents/a/art/big.png'); write('agents/a/my-tasks.md');
    write('agents/b/memory.md');
    for (const spec of SPECS) assert.equal(git('add', '-A', '--', ...spec).status, 0);
    const staged = git('diff', '--cached', '--name-only').stdout.trim().split('\n').sort();
    assert.deepEqual(staged, ['agents/a/identity.md', 'agents/a/memory-archive.md', 'agents/a/memory.md', 'agents/b/memory.md', 'board.md', 'research/r.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
