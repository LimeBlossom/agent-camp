'use strict';

/**
 * What of an agent's folder reaches the palace: its memory files plus the
 * notes it wrote (top-level reports, research/**, reviews/**), never task
 * state, tool homes, scratch, backups or art workspaces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { minedNoteFiles, stageNoteFiles, noteSignature } = loadTs('src/main/palaceInputs.ts');
const { PALACE_SCOPE } = loadTs('src/main/palaceScope.ts');

const MINED = [
  'memory.md',
  'memory-archive.md',
  'alpha-unrewarded-action-gear.md',
  'research/camp-search/report.md',
  'research/deep/nested/notes.md',
  'research/memory-search/memory-findings.md',
  'reviews/alpha-dialog/verdict.md'
];
const NOT_MINED = [
  'transcript.jsonl',
  'research/data.jsonl',
  'research/page.html',
  'notes.txt',
  '.codex/skills/x/SKILL.md',
  '.claude/skills/y/SKILL.md',
  'research/.cache/hidden.md',
  'my-tasks.md',
  'handoff.md',
  'handoff.consumed.md',
  'research/handoff-old.md',
  'scratch-audit-20261112.md',
  'scratch/plan.md',
  'research/scratch-run/plan.md',
  'planner-complete-sphere-backup.md',
  'memory-before-wind-swap-20261116.md',
  'memory.pre-dinos-20261112T145028Z.md',
  'memory-checkpoint-1791130451338359043.md',
  'research/memory-before-story-block-20261006T093949578929.md',
  'reviews/alpha-dialog/memory-before-6c5eef.md',
  'research/title-3d-backup/notes.md',
  'reviews/task-backups/old.md',
  'jam-sphere-art/README.md',
  'reports/summary.md',
  'shots/notes.md'
];

function agent(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-palace-inputs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const rel of [...MINED, ...NOT_MINED]) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `# ${rel}\n`);
  }
  return dir;
}

test('memory files, top-level reports, research and reviews notes are mined', (t) => {
  const got = minedNoteFiles(agent(t));
  for (const rel of MINED) assert.ok(got.includes(rel), `${rel} should be mined`);
});

test('task state, dot-folders, scratch, backups, art workspaces and non-markdown are not mined', (t) => {
  const got = minedNoteFiles(agent(t));
  for (const rel of NOT_MINED) assert.ok(!got.includes(rel), `${rel} should not be mined`);
  assert.deepEqual([...got].sort(), [...MINED].sort());
});

test('a symlinked directory is not followed', (t) => {
  const dir = agent(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md-palace-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'leak.md'), 'x');
  fs.symlinkSync(outside, path.join(dir, 'research', 'linked'));
  assert.ok(!minedNoteFiles(dir).some((rel) => rel.includes('leak.md')));
});

test('staging copies exactly the mined files at their relative paths and drops stale ones', (t) => {
  const dir = agent(t);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'md-palace-stage-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stage, 'stale.md'), 'old');
  stageNoteFiles(dir, stage);
  const staged = [];
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel); else staged.push(rel);
    }
  };
  walk(stage, '');
  assert.deepEqual(staged.sort(), [...MINED].sort());
  assert.equal(fs.readFileSync(path.join(stage, 'reviews/alpha-dialog/verdict.md'), 'utf8'), '# reviews/alpha-dialog/verdict.md\n');
});

test('the change signature moves when a mined note changes and ignores unmined files', (t) => {
  const dir = agent(t);
  const before = noteSignature(dir);
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), 'more');
  fs.utimesSync(path.join(dir, 'transcript.jsonl'), new Date(), new Date(Date.now() + 5000));
  assert.equal(noteSignature(dir), before);
  fs.utimesSync(path.join(dir, 'research/camp-search/report.md'), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(noteSignature(dir), before);
  fs.writeFileSync(path.join(dir, 'new-report.md'), 'x');
  const withNew = noteSignature(dir);
  fs.rmSync(path.join(dir, 'new-report.md'));
  assert.notEqual(noteSignature(dir), withNew);
});

test('memory.ts mines through palaceInputs, with no private file list', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/memory.ts'), 'utf8');
  assert.match(src, /from '\.\/palaceInputs'/);
  assert.doesNotMatch(src, /MINED_FILES/);
});

test('the scope marker moved on, so the memory-only palace is rebuilt with notes', () => {
  assert.equal(PALACE_SCOPE, 'agent-notes-v1');
});
