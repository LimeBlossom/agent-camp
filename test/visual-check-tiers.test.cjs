'use strict';

// A worker's standing rules carry the three visual-check tiers;
// the Boss (who dispatches, never checks frames) and the prep assistant do not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function prompt(t, meta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-visual-tiers-'));
  t.after(() => rmTree(dir));
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  const root = hive.root();
  return hive.injectedPrompt({ provider: 'claude', cwd: dir, ...meta }, path.join(root, 'agents', meta.id), root, false, false, undefined, '');
}

test('a worker prompt carries the three visual-check tiers', (t) => {
  const p = prompt(t, { id: 'w1', name: 'W' });
  const line = p.split('\n').find((l) => l.startsWith('VISUAL CHECKS'));
  assert.ok(line, 'worker prompt has a VISUAL CHECKS line');
  assert.match(line, /\(1\) measurable.*script guard that exits 1/);
  assert.match(line, /\(2\) factual yes\/no.*Read the image.*own subagent.*not route through Camp.*codex/);
  assert.match(line, /\(3\) taste.*Willow/);
});

test('the Boss and the prep assistant prompts do not carry it', (t) => {
  assert.doesNotMatch(prompt(t, { id: 'god', name: 'Boss', isGod: true }), /VISUAL CHECKS/);
  assert.doesNotMatch(prompt(t, { id: 'prep', name: 'Prep', isAssistant: true }), /VISUAL CHECKS/);
});

test('the visual-check line is overridable like the other sections', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-visual-tiers-'));
  t.after(() => rmTree(dir));
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  const root = hive.root();
  fs.mkdirSync(path.join(root, 'prompts', 'sections'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts', 'sections', 'visualChecksLine.md'), 'VISUAL CHECKS for {{name}}: custom.');
  const p = hive.injectedPrompt({ id: 'w1', name: 'W', provider: 'claude', cwd: dir }, path.join(root, 'agents', 'w1'), root, false, false, undefined, '');
  assert.match(p, /^VISUAL CHECKS for W: custom\.$/m);
});

test('the Boss-facing kind guide and spawn prose point at the tiers instead of sending a yes/no check to Willow', () => {
  const { WORK_KIND_GUIDE } = loadTs('src/shared/workKind.ts');
  const { formatEnginePromptProse, DEFAULT_ENGINES } = loadTs('src/main/engineChoice.ts');
  for (const text of [WORK_KIND_GUIDE, formatEnginePromptProse(DEFAULT_ENGINES)]) {
    assert.match(text, /VISUAL CHECKS tiers: a script guard first, its own eyes or subagent next, Willow only for taste/);
    assert.doesNotMatch(text, /vision subagent or Willow/);
  }
});
