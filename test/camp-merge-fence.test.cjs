'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
delete process.env.HIVE_ROOT; // validate projects against the bundled list, not the ambient hive
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const {
  mergeBranch,
  createCard,
  patchCard,
  CAMP_MCP_TOOLS,
  handleCampMcpCall
} = loadTs('src/main/campTools.ts');

const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

function git(...args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  return res;
}

function commitFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  git('-C', dir, 'add', relPath);
  git('-C', dir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-m', `touch ${relPath}`);
}

function setupRepos(tmpDir) {
  const repoDir = path.join(tmpDir, 'repo');
  const worktreeDir = path.join(tmpDir, 'worktree');
  fs.mkdirSync(repoDir, { recursive: true });
  git('init', '-b', 'main', repoDir);
  git('-C', repoDir, 'config', 'user.name', 'Tester');
  git('-C', repoDir, 'config', 'user.email', 'tester@example.com');
  commitFile(repoDir, 'init.txt', 'initial commit');

  git('-C', repoDir, 'worktree', 'add', '-b', 'feature', worktreeDir, 'main');
  git('-C', worktreeDir, 'config', 'user.name', 'Tester');
  git('-C', worktreeDir, 'config', 'user.email', 'tester@example.com');

  return { repoDir, worktreeDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: no fence = unchanged behavior (merges successfully)
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: no fence behaves as today (merges successfully)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-1-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);

    commitFile(worktreeDir, 'src/code.ts', 'export const x = 1;');
    commitFile(worktreeDir, 'docs/notes.md', '# Notes');

    const res = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main'
    });

    assert.equal(res.ok, true, `Expected merge to succeed without fence, got error: ${res.error}`);
    assert.ok(fs.existsSync(path.join(repoDir, 'src/code.ts')), 'src/code.ts should exist in repo after merge');
    assert.ok(fs.existsSync(path.join(repoDir, 'docs/notes.md')), 'docs/notes.md should exist in repo after merge');
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: all inside fence = merges
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: all changed files inside fence merges successfully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-2-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);

    commitFile(worktreeDir, 'src/feature.ts', 'export const f = 2;');
    commitFile(worktreeDir, 'src/utils/calc.ts', 'export const c = 3;');

    const res = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      fence: ['src/**']
    });

    assert.equal(res.ok, true, `Expected merge to succeed when all changes inside fence, got error: ${res.error}`);
    assert.ok(fs.existsSync(path.join(repoDir, 'src/feature.ts')));
    assert.ok(fs.existsSync(path.join(repoDir, 'src/utils/calc.ts')));
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: one outside fence = refused and named
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: changed file outside fence is refused and offending path is named', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-3-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);

    const mainHeadBefore = git('-C', repoDir, 'rev-parse', 'HEAD').stdout.trim();

    // Inside fence
    commitFile(worktreeDir, 'src/valid.ts', 'export const v = 1;');
    // Outside fence
    commitFile(worktreeDir, 'config/secret.json', '{"key": "outside"}');

    const res = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      fence: ['src/**']
    });

    assert.equal(res.ok, false, 'Expected merge to be refused when changed path is outside fence');
    assert.ok(res.error, 'Result must contain an error message');
    assert.match(res.error, /outside|fence/i, 'Error message should mention fence violation');
    assert.ok(
      res.error.includes('config/secret.json'),
      `Error message must name the offending path config/secret.json: ${res.error}`
    );

    // Verify target branch was NOT modified
    const mainHeadAfter = git('-C', repoDir, 'rev-parse', 'HEAD').stdout.trim();
    assert.equal(mainHeadAfter, mainHeadBefore, 'Target branch HEAD must not move on fence refusal');
    assert.equal(fs.existsSync(path.join(repoDir, 'config/secret.json')), false, 'Offending file must not be in repo');
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: a rename across the fence = refused
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: rename across the fence is refused and names the offending path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-4-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);

    // Initial files present on both branches
    commitFile(repoDir, 'src/inside.ts', 'console.log("inside");');
    commitFile(repoDir, 'docs/outside.md', '# Outside Doc');
    // Fast-forward worktree to match repo
    git('-C', worktreeDir, 'merge', '--ff-only', 'main');

    // Case 4A: Rename from inside fence to outside fence (new name violates fence)
    fs.mkdirSync(path.join(worktreeDir, 'dist'), { recursive: true });
    git('-C', worktreeDir, 'mv', 'src/inside.ts', 'dist/moved-outside.ts');
    git('-C', worktreeDir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-m', 'mv inside to outside');

    const resA = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      fence: ['src/**']
    });

    assert.equal(resA.ok, false, 'Rename to outside fence must be refused');
    assert.match(resA.error || '', /outside|fence/i);
    assert.ok(
      resA.error && resA.error.includes('dist/moved-outside.ts'),
      `Error must name the new path dist/moved-outside.ts: ${resA.error}`
    );

    // Reset worktree back to main for Case 4B
    git('-C', worktreeDir, 'reset', '--hard', 'main');

    // Case 4B: Rename from outside fence to inside fence (old name violates fence)
    git('-C', worktreeDir, 'mv', 'docs/outside.md', 'src/moved-inside.md');
    git('-C', worktreeDir, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-m', 'mv outside to inside');

    const resB = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      fence: ['src/**']
    });

    assert.equal(resB.ok, false, 'Rename from outside fence must be refused');
    assert.match(resB.error || '', /outside|fence/i);
    assert.ok(
      resB.error && resB.error.includes('docs/outside.md'),
      `Error must name the old path docs/outside.md: ${resB.error}`
    );
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: the override works (allowOutsideFence: true)
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: allowOutsideFence override allows merge even when files are outside fence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-5-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);

    commitFile(worktreeDir, 'src/code.ts', 'export const x = 10;');
    commitFile(worktreeDir, 'outside/override.txt', 'override content');

    const res = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      fence: ['src/**'],
      allowOutsideFence: true
    });

    assert.equal(res.ok, true, `Expected allowOutsideFence: true to bypass fence refusal, got: ${res.error}`);
    assert.ok(fs.existsSync(path.join(repoDir, 'src/code.ts')));
    assert.ok(fs.existsSync(path.join(repoDir, 'outside/override.txt')));
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5B: card lookup in tasks.json supplies fence or inherits no-fence
// ─────────────────────────────────────────────────────────────────────────────

test('mergeBranch: card lookup from tasks.json enforces card fence, or allows when card has no fence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-5b-'));
  try {
    const { repoDir, worktreeDir } = setupRepos(tmpDir);
    const hiveRoot = path.join(tmpDir, 'hive');
    fs.mkdirSync(hiveRoot, { recursive: true });

    const tasksJson = {
      tasks: [
        { id: 'fenced-task', title: 'Fenced Task', fence: ['src/**'] },
        { id: 'unfenced-task', title: 'Unfenced Task' }
      ]
    };
    fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify(tasksJson, null, 2), 'utf8');

    commitFile(worktreeDir, 'outside/violator.txt', 'violator');

    // Case 5B-1: Card with fence refuses outside changes
    const resFenced = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      cardId: 'fenced-task',
      hiveRoot
    });
    assert.equal(resFenced.ok, false, 'Card with fence must refuse outside changes');
    assert.ok(resFenced.error && resFenced.error.includes('outside/violator.txt'));

    // Case 5B-2: Card without fence behaves as today (merges)
    const resUnfenced = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature',
      target: 'main',
      cardId: 'unfenced-task',
      hiveRoot
    });
    assert.equal(resUnfenced.ok, true, 'Card without fence must merge as today');
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: a bad fence value is refused by patch_card and create_card
// ─────────────────────────────────────────────────────────────────────────────

test('card schema/validation: bad fence value is refused by patch_card and create_card', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fence-test-6-'));
  try {
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });

    // --- patchCard refusals ---
    // Non-array fence
    const resString = patchCard({ id: 'card-1', fence: 'src/**', outboxDir });
    assert.equal(resString.ok, false, 'patchCard must refuse string fence');
    assert.match(resString.error || '', /fence.*non-empty string/i);

    // Array containing empty string
    const resEmpty = patchCard({ id: 'card-1', fence: ['src/**', ''], outboxDir });
    assert.equal(resEmpty.ok, false, 'patchCard must refuse empty string in fence');
    assert.match(resEmpty.error || '', /fence.*non-empty string/i);

    // Array containing whitespace-only string
    const resWhitespace = patchCard({ id: 'card-1', fence: ['   '], outboxDir });
    assert.equal(resWhitespace.ok, false, 'patchCard must refuse whitespace string in fence');
    assert.match(resWhitespace.error || '', /fence.*non-empty string/i);

    // Array containing non-string items
    const resNumber = patchCard({ id: 'card-1', fence: [123], outboxDir });
    assert.equal(resNumber.ok, false, 'patchCard must refuse non-string item in fence');
    assert.match(resNumber.error || '', /fence.*non-empty string/i);

    // Valid fence on patchCard succeeds
    const resValidPatch = patchCard({ id: 'card-1', fence: ['src/**', 'test/*.cjs'], outboxDir });
    assert.equal(resValidPatch.ok, true, `Valid fence should succeed: ${resValidPatch.error}`);
    assert.deepEqual(resValidPatch.patchPayload.body.fence, ['src/**', 'test/*.cjs']);

    // --- createCard refusals ---
    // Non-array fence on createCard
    const resCreateBad = createCard({
      title: 'New Task',
      assignee: 'quince-mvnvoaig',
      project: 'General',
      fence: 'not-an-array',
      outboxDir
    });
    assert.equal(resCreateBad.ok, false, 'createCard must refuse non-array fence');
    assert.match(resCreateBad.error || '', /fence.*non-empty string/i);

    // Valid fence on createCard succeeds
    const resCreateValid = createCard({
      title: 'New Task',
      assignee: 'quince-mvnvoaig',
      project: 'General',
      fence: ['src/main/campTools.ts'],
      outboxDir
    });
    assert.equal(resCreateValid.ok, true, `createCard with valid fence must succeed: ${resCreateValid.error}`);
    assert.deepEqual(resCreateValid.createPayload.body.fence, ['src/main/campTools.ts']);
  } finally {
    rmTree(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: taskPatch planTaskMessage validates fence on task-patch and task-create
// ─────────────────────────────────────────────────────────────────────────────

test('taskPatch: planTaskMessage validates fence and refuses non-list of non-empty strings', () => {
  const tasks = [{ id: 'card-1', title: 'Existing card', assignee: 'quince-mvnvoaig', status: 'todo' }];
  const now = '2026-10-29T00:00:00.000Z';

  // Bad fence in task-patch from Boss
  const planBadPatch = planTaskMessage({
    act: 'task-patch',
    body: { id: 'card-1', fence: 'not-an-array' },
    sender: 'boss',
    isBoss: true,
    tasks,
    now
  });
  assert.equal(planBadPatch.ok, false);
  assert.match(planBadPatch.reason, /fence.*non-empty string/i);

  // Array with empty string
  const planEmptyItem = planTaskMessage({
    act: 'task-patch',
    body: { id: 'card-1', fence: ['valid/glob', ''] },
    sender: 'boss',
    isBoss: true,
    tasks,
    now
  });
  assert.equal(planEmptyItem.ok, false);
  assert.match(planEmptyItem.reason, /fence.*non-empty string/i);

  // Valid fence in task-patch from Boss
  const planValidPatch = planTaskMessage({
    act: 'task-patch',
    body: { id: 'card-1', fence: ['src/**', 'test/**'] },
    sender: 'boss',
    isBoss: true,
    tasks,
    now
  });
  assert.equal(planValidPatch.ok, true);
  assert.deepEqual(planValidPatch.patch.fence, ['src/**', 'test/**']);

  // Bad fence in task-create from Boss
  const planBadCreate = planTaskMessage({
    act: 'task-create',
    body: { id: 'card-new', title: 'New', assignee: 'quince-mvnvoaig', fence: [123] },
    sender: 'boss',
    isBoss: true,
    tasks,
    now
  });
  assert.equal(planBadCreate.ok, false);
  assert.match(planBadCreate.reason, /fence.*non-empty string/i);

  // Valid fence in task-create from Boss
  const planValidCreate = planTaskMessage({
    act: 'task-create',
    body: { id: 'card-new', title: 'New', assignee: 'quince-mvnvoaig', fence: ['src/**'] },
    sender: 'boss',
    isBoss: true,
    tasks,
    now
  });
  assert.equal(planValidCreate.ok, true);
  assert.deepEqual(planValidCreate.card.fence, ['src/**']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: CAMP_MCP_TOOLS schema exposes fence and allowOutsideFence
// ─────────────────────────────────────────────────────────────────────────────

test('CAMP_MCP_TOOLS schema exposes fence on create_card and patch_card, and fence + allowOutsideFence on merge', () => {
  const createTool = CAMP_MCP_TOOLS.find((t) => t.name === 'create_card');
  assert.ok(createTool.inputSchema.properties.fence, 'create_card must expose fence in inputSchema');

  const patchTool = CAMP_MCP_TOOLS.find((t) => t.name === 'patch_card');
  assert.ok(patchTool.inputSchema.properties.fence, 'patch_card must expose fence in inputSchema');

  const mergeTool = CAMP_MCP_TOOLS.find((t) => t.name === 'merge');
  assert.ok(mergeTool.inputSchema.properties.fence, 'merge must expose fence in inputSchema');
  assert.ok(mergeTool.inputSchema.properties.allowOutsideFence, 'merge must expose allowOutsideFence in inputSchema');
});
