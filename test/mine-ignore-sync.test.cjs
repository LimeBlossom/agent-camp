'use strict';

/**
 * Agent folders' .gitignore (written by hive.ts at spawn and for every agent at
 * boot) must keep Codex homes out of the hive's git repo: PR #128 found 7.5GB of
 * .git from versioned Codex transcripts. memory.ts no longer writes this file;
 * the palace mines a staged copy of the memory files instead.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the agent-folder ignore list keeps Codex homes out of git', () => {
  const m = read('src/main/hive.ts').match(/const MINE_IGNORE_LINES = (\[[^\]]*\]);/);
  assert.ok(m, 'MINE_IGNORE_LINES not found in hive.ts');
  assert.ok(JSON.parse(m[1].replace(/'/g, '"')).includes('.codex/'));
});

test('memory.ts keeps no second copy of the ignore list', () => {
  assert.doesNotMatch(read('src/main/memory.ts'), /MINE_IGNORE_LINES|ensureMineIgnore/);
});
