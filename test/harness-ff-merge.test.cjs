'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const {
  extractVerbatimTestLine,
  parseDirtyPaths,
  evaluateAndExecuteFfMerge,
  handleHarnessFfMerge,
  resolveRepo,
  extractBranchName
} = loadTs('src/main/harnessFfMerge.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const git = (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const commit = (dir, rel, text) => {
  put(dir, rel, text);
  git('-C', dir, 'add', rel);
  git('-C', dir, 'commit', '-qm', rel);
};

function makeRepos(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-harness-ff-'));
  t.after(() => rmTree(tmp));
  const mainRepo = path.join(tmp, 'main-repo');
  const wt = path.join(tmp, 'worktree');

  git('init', '-q', '-b', 'master', mainRepo);
  commit(mainRepo, 'base.txt', 'base');
  git('-C', mainRepo, 'worktree', 'add', '-q', '-b', 'worker/feature-1', wt, 'master');
  commit(wt, 'src/feature.txt', 'feature work');

  return { tmp, mainRepo, wt };
}

// ─── GATE 1 TESTS: Fast-forward check (git fetch first) ──────────────────────

test('Gate 1: passes when branch cleanly fast-forwards onto current master', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'SpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31, Duration: 75 ms'
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    const headAfter = git('-C', mainRepo, 'rev-parse', 'HEAD');
    assert.notEqual(headAfter, headBefore);
    assert.equal(headAfter, outcome.head);
    assert.equal(outcome.target, 'master');
  }
});

test('Gate 1: fails when target has diverged/moved (cannot fast-forward)', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  // Commit to mainRepo so it moves ahead
  commit(mainRepo, 'diverged.txt', 'diverged commit on master');
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'SpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 1);
    assert.match(outcome.reason, /does not fast-forward/i);
    // Main repo head must remain untouched
    assert.equal(git('-C', mainRepo, 'rev-parse', 'HEAD'), headBefore);
  }
});

test('Gate 1: fails when git fetch fails (e.g. non-existent branch)', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/non-existent-branch',
    worktree: wt,
    text: 'SpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 1);
    assert.match(outcome.reason, /git fetch failed/i);
  }
});

// ─── GATE 2 TESTS: Touches none of the human's uncommitted/dirty files ───────────

test('Gate 2: fails when incoming branch touches a modified dirty file in main tree', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  // Main tree has modified base.txt
  put(mainRepo, 'base.txt', 'dirty uncommitted change in main tree');
  // Worker branch also modified base.txt
  commit(wt, 'base.txt', 'worker modified base');

  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'Passed! - Failed: 0, Passed: 10'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 2);
    assert.match(outcome.reason, /touch dirty files.*base\.txt/);
  }
});

test('Gate 2: fails when incoming branch touches an untracked file in main tree', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  // Main tree has untracked file
  put(mainRepo, 'untracked-notes.txt', 'untracked');
  // Worker branch adds untracked-notes.txt
  commit(wt, 'untracked-notes.txt', 'worker added untracked-notes');

  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'Passed! - Failed: 0, Passed: 10'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 2);
    assert.match(outcome.reason, /touch dirty files.*untracked-notes\.txt/);
  }
});

test('Gate 2: passes when main tree has dirty files, but incoming branch touches none of them (Gamma rule)', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  // Main tree has dirty files (like Gamma's dirty settings / assets)
  put(mainRepo, 'Assets/Settings/PC_RPAsset.asset', 'dirty settings');
  put(mainRepo, 'play notes', 'untracked play notes');
  // Worker branch only touches src/feature.txt (already committed in makeRepos)

  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'Verbatim output: THRUSTERS REMOVAL ALL PASS'
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    // Dirty files in main tree are untouched
    assert.equal(fs.readFileSync(path.join(mainRepo, 'Assets/Settings/PC_RPAsset.asset'), 'utf8'), 'dirty settings');
    assert.equal(fs.readFileSync(path.join(mainRepo, 'play notes'), 'utf8'), 'untracked play notes');
    // Feature was merged
    assert.equal(fs.readFileSync(path.join(mainRepo, 'src/feature.txt'), 'utf8'), 'feature work');
  }
});

test('Gate 2: parseDirtyPaths handles quotes and renames correctly', () => {
  const porcelain = [
    ' M Assets/Settings.asset',
    '?? "play notes"',
    'R  old.txt -> new.txt',
    '?? tools/__pycache__/'
  ].join('\n');
  const dirty = parseDirtyPaths(porcelain);
  assert.ok(dirty.has('Assets/Settings.asset'));
  assert.ok(dirty.has('play notes'));
  assert.ok(dirty.has('new.txt'));
  assert.ok(dirty.has('tools/__pycache__/'));
});

// ─── GATE 3 TESTS: Verbatim test result line ────────────────────────────────

test('Gate 3: fails when done message has no test result line', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'Finished the task. Please review and merge.'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 3);
    assert.match(outcome.reason, /missing a verbatim test result line/i);
  }
});

test('Gate 3: fails when tests reported failure', (t) => {
  const { mainRepo, wt } = makeRepos(t);
  const outcome = evaluateAndExecuteFfMerge({
    repo: mainRepo,
    target: 'master',
    branch: 'worker/feature-1',
    worktree: wt,
    text: 'SpiderTests verbatim: Passed!  - Failed:     2, Passed:    29, Skipped:     0, Total:    31'
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.gate, 3);
    assert.match(outcome.reason, /tests failed/i);
  }
});

test('Gate 3: recognizes diverse real-world passing test lines', () => {
  // Dotnet test
  const r1 = extractVerbatimTestLine('SpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31, Duration: 75 ms');
  assert.equal(r1.ok, true);
  assert.match(r1.line, /Passed!\s*-\s*Failed:\s*0/);

  // Unity compile check / Tundra
  const r2 = extractVerbatimTestLine('Running compile...\n*** Tundra build success (0.42 seconds), 0 items updated\n(0 error CS)');
  assert.equal(r2.ok, true);
  assert.match(r2.line, /Tundra build success/);

  // Broker runner ALL PASS
  const r3 = extractVerbatimTestLine('Broker run complete. Verbatim output: THRUSTERS REMOVAL ALL PASS');
  assert.equal(r3.ok, true);
  assert.match(r3.line, /THRUSTERS REMOVAL ALL PASS/);

  // Checks count
  const r4 = extractVerbatimTestLine('16/16 checks PASS');
  assert.equal(r4.ok, true);

  // 0 CS errors
  const r5 = extractVerbatimTestLine('Unity EditMode run: total=9 passed=9 failed=0, 0 CS errors');
  assert.equal(r5.ok, true);
});

// ─── Gate 3: the LAST test result in a report decides ───────────────────────

const HAZEL_REPORT = "Branch hazel/alpha-dup-kit-leak, head 647b1063 (worktree Beta-gear3b, base master ba862532). Fix: GearKits.KitFor now treats a present GearInstance as authoritative.\n\nTests (Core.Tests/GearKitsDuplicateUpgradeTests.cs): red first, 'Failed: 4, Passed: 1, Total: 5'; after fix 'dotnet test --filter FullyQualifiedName~GearKits: Passed 51/51, 114 ms' and 'filter Gear|Roster|RunSerializer|Kit: Passed! Failed 0, Passed 458, 12 s'.\nCoverage map: 1 upgraded original -> clean duplicate.";

test('Gate 3: an intentional red-first run followed by a green final run passes (real Hazel report, 647b1063)', () => {
  const r = extractVerbatimTestLine(HAZEL_REPORT);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.line, /Passed! Failed 0, Passed 458/);
});

test('Gate 3: red-first then green on separate lines passes, in several formats', () => {
  assert.equal(extractVerbatimTestLine('red first: Failed: 4, Passed: 1, Total: 5\nfinal: Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5').ok, true);
  assert.equal(extractVerbatimTestLine('before fix:\n# tests 5\n# pass 1\n# fail 4\nafter fix:\n# tests 5\n# pass 5\n# fail 0').ok, true);
  assert.equal(extractVerbatimTestLine('red: total=5 passed=1 failed=4\ngreen: total=5 passed=5 failed=0').ok, true);
  assert.equal(extractVerbatimTestLine('red: 4 tests failed\ngreen: 5/5 checks PASS').ok, true);
});

test('Gate 3: a genuinely red FINAL result still fails, even after an earlier green run', () => {
  const a = extractVerbatimTestLine('first run Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31\nafter rebase: Failed: 2, Passed: 29, Total: 31');
  assert.equal(a.ok, false);
  assert.match(a.reason, /tests failed/i);
  const b = extractVerbatimTestLine('# tests 5\n# pass 5\n# fail 0\nrerun after rebase\n# tests 5\n# pass 3\n# fail 2');
  assert.equal(b.ok, false);
  const c = extractVerbatimTestLine("green 'Passed! Failed 0, Passed 458'; then final run 'Failed: 1, Passed: 457'");
  assert.equal(c.ok, false);
});

test('Gate 3: red evidence with no later green result is still refused', () => {
  assert.equal(extractVerbatimTestLine("red first, 'Failed: 4, Passed: 1, Total: 5'; fix pushed").ok, false);
  assert.equal(extractVerbatimTestLine('# pass 1\n# fail 4').ok, false);
});

test('Gate 3: node --test summary counts, green and red', () => {
  assert.equal(extractVerbatimTestLine('# tests 2042\n# pass 2042\n# fail 0').ok, true);
  assert.equal(extractVerbatimTestLine('# tests 2042\n# pass 2041\n# fail 1').ok, false);
});

// Boss-close text (brief + notes + result) carries no "Verbatim:" label, so the summary itself must be recognised.
const STRIP_CONTRACT_CLOSE = "Branch hazel/alpha-strip-contract-test head a53f02cc0. Tools/SplatSprites/tools/test_strip_contract.py + strips.py.\nCoverage: step 1 test file; step 2 KNOWN list with card ids, nothing skipped silently; step 3 'Ran 4 tests in 7.133s OK'. Limit: the goblin coverage prefix hides new alpha regressions.";
const FELT_REGISTRY_CLOSE = 'Coverage: step 1-2 felt.js + 9 scenes; step 3 gate: node --test 12/12, bakehash 1869 configs STATE IDENTICAL and PLAN IDENTICAL (negative control 1869/1869 differ), 60/60 real renders identical;';

test('Gate 3: Python unittest summaries, green and red', () => {
  const close = extractVerbatimTestLine(STRIP_CONTRACT_CLOSE);
  assert.equal(close.ok, true, close.reason);
  assert.match(close.line, /Ran 4 tests in 7\.133s OK/);
  assert.equal(extractVerbatimTestLine('......\n----------------------------------------------------------------------\nRan 6 tests in 0.412s\n\nOK').ok, true);
  assert.equal(extractVerbatimTestLine('Ran 6 tests in 0.412s\n\nOK (skipped=1)').ok, true);
  const red = extractVerbatimTestLine('Ran 6 tests in 0.412s\n\nFAILED (errors=1)');
  assert.equal(red.ok, false);
  assert.match(red.reason, /tests failed/i);
  assert.equal(extractVerbatimTestLine("result 'Ran 4 tests in 2.1s FAILED (failures=2, errors=1)'").ok, false);
  assert.equal(extractVerbatimTestLine('Ran 0 tests in 0.000s\n\nOK').ok, false, 'running no tests is no evidence');
});

test('Gate 3: dotnet/Unity counts in Boss-close text, green and red', () => {
  assert.equal(extractVerbatimTestLine('Coverage: step 3 EditMode Passed! - Failed: 0, Passed: 55, Skipped: 0').ok, true);
  assert.equal(extractVerbatimTestLine('Coverage: step 3 Unity Failed: 0, Passed: 55').ok, true);
  assert.equal(extractVerbatimTestLine('Coverage: step 3 Unity Failed: 2, Passed: 53').ok, false);
});

test('Gate 3: a bare "node --test N/N" count, green and red', () => {
  const close = extractVerbatimTestLine(FELT_REGISTRY_CLOSE);
  assert.equal(close.ok, true, close.reason);
  assert.match(close.line, /node --test 12\/12/);
  assert.equal(extractVerbatimTestLine('step 3: node --test 11/12, one flake').ok, false);
});

// ─── REPO & BRANCH EXTRACTION TESTS ─────────────────────────────────────────

test('resolveRepo identifies Beta vs Gamma from card project and text', () => {
  const repos = mergeRepos({ beta: '/r/beta', gamma: '/r/gamma', camp: '/r/camp' });
  const proj = (card, text) => resolveRepo(card, text, repos)?.project ?? null;
  assert.equal(proj({ project: 'Alpha' }, ''), 'BetaGame');
  assert.equal(proj({ project: 'BetaGame' }, ''), 'BetaGame');
  assert.equal(proj({ project: 'GammaGame' }, ''), 'GammaGame');
  assert.equal(proj({ project: 'Gamma' }, ''), 'GammaGame');
  assert.equal(proj(null, 'Fixed enemy in Beta Alpha Game'), 'BetaGame');
  assert.equal(proj(null, 'Fixed thrusters on Gamma level'), 'GammaGame');
  assert.equal(proj({ project: 'Camp' }, ''), 'Camp');
  assert.equal(proj(null, 'Beta and Gamma both touched'), null);
});

test('extractBranchName extracts branch from card or text patterns', () => {
  assert.equal(extractBranchName({ branch: 'cedar/alpha-poison-clip' }, ''), 'cedar/alpha-poison-clip');
  assert.equal(extractBranchName(null, 'Branch `hazel/gamma-thrusters-card-weak`, commit `32f4e36`'), 'hazel/gamma-thrusters-card-weak');
  assert.equal(extractBranchName(null, 'alpha-enemy-spider done: branch worker/alpha-impact-debris @ cf6b81f9'), 'worker/alpha-impact-debris');
  assert.equal(extractBranchName(null, 'Rebased cedar/alpha-enemy-spider onto master 399c62ba'), 'cedar/alpha-enemy-spider');
});

// ─── INTEGRATION TESTS VIA HIVEMANAGER: auto-merge vs decline ───────────────

test('through outbox: successful auto-merge fast-forwards main tree, logs auto-merge, card stays blocked', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-merge-'));
  t.after(() => rmTree(home));

  const { mainRepo, wt } = makeRepos(t);
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.setFfMergeDeps({
    repos: mergeRepos({ beta: mainRepo, gamma: mainRepo })
  });

  hive.writeTasks([
    {
      id: 'alpha-task-1',
      title: 'Fix Alpha spider',
      assignee: 'w1',
      status: 'doing',
      project: 'Alpha',
      brief: 'Alpha spider fixed'
    }
  ]);

  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(
    path.join(out, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'alpha-task-1 done',
      body: 'Branch worker/feature-1 (worktree ' + wt + ')\nSpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
    })
  );

  hive.routeOnce();

  // 1. Repo was fast-forwarded
  const headAfter = git('-C', mainRepo, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter, headBefore);

  // 2. Card stays blocked awaiting boss merge
  const card = hive.tasks().tasks.find((x) => x.id === 'alpha-task-1');
  assert.equal(card.status, 'blocked');

  // 3. Log event kind: 'auto-merge' was logged
  const logs = hive.logTail(100);
  const mergeEvent = logs.find((e) => e.kind === 'auto-merge');
  assert.ok(mergeEvent, 'auto-merge event must be in log');
  assert.equal(mergeEvent.ok, true);
  assert.equal(mergeEvent.branch, 'worker/feature-1');
  assert.equal(mergeEvent.head, headAfter);
  assert.equal(mergeEvent.id, 'alpha-task-1');

  // 4. No decline mail in worker inbox
  assert.equal(hive.inbox('w1').length, 0);
});

test('through outbox: decline logs auto-merge-decline, mails worker to rebuild, card stays blocked', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-decline-'));
  t.after(() => rmTree(home));

  const { mainRepo, wt } = makeRepos(t);
  // Cause Gate 1 failure by committing to master (diverged)
  commit(mainRepo, 'diverged.txt', 'diverged');
  const headBefore = git('-C', mainRepo, 'rev-parse', 'HEAD');

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.setFfMergeDeps({
    repos: mergeRepos({ beta: mainRepo, gamma: mainRepo })
  });

  hive.writeTasks([
    {
      id: 'alpha-task-2',
      title: 'Fix Alpha combo',
      assignee: 'w1',
      status: 'doing',
      project: 'Alpha',
      brief: 'Alpha combo work'
    }
  ]);

  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(
    path.join(out, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'alpha-task-2 done',
      body: 'Branch worker/feature-1 (worktree ' + wt + ')\nSpiderTests verbatim: Passed!  - Failed:     0, Passed:    31, Skipped:     0, Total:    31'
    })
  );

  hive.routeOnce();

  // 1. Repo was NOT changed
  assert.equal(git('-C', mainRepo, 'rev-parse', 'HEAD'), headBefore);

  // 2. Card stays blocked awaiting boss merge
  const card = hive.tasks().tasks.find((x) => x.id === 'alpha-task-2');
  assert.equal(card.status, 'blocked');

  // 3. Log event kind: 'auto-merge-decline' was logged
  const logs = hive.logTail(100);
  const declineEvent = logs.find((e) => e.kind === 'auto-merge-decline');
  assert.ok(declineEvent, 'auto-merge-decline event must be in log');
  assert.equal(declineEvent.ok, false);
  assert.equal(declineEvent.branch, 'worker/feature-1');
  assert.equal(declineEvent.id, 'alpha-task-2');

  // 4. Worker received mail to rebuild on top of master
  const workerInbox = hive.inbox('w1');
  assert.equal(workerInbox.length, 1);
  const mail = workerInbox[0];
  assert.equal(mail.act, 'request');
  assert.match(mail.subject, /rebuild on top of master and report again/i);
  assert.match(mail.body, /could not be fast-forward merged.*rebuild on top of master and report again/i);
});

test('non-Beta / non-Gamma tasks are ignored without auto-merge or decline', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-auto-ignore-'));
  t.after(() => rmTree(home));

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'w1', name: 'Worker', provider: 'claude', cwd: home });

  hive.writeTasks([
    {
      id: 'camp-ui-1',
      title: 'Camp UI polish',
      assignee: 'w1',
      status: 'doing',
      project: 'Camp',
      brief: 'Camp UI done'
    }
  ]);

  const out = path.join(home, 'hive', 'agents', 'w1', 'outbox');
  fs.writeFileSync(
    path.join(out, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'camp-ui-1 done',
      body: 'Branch worker/camp-ui-polish\nAll tests pass'
    })
  );

  hive.routeOnce();

  // No auto-merge or decline logs
  const logs = hive.logTail(100);
  assert.ok(!logs.some((e) => e.kind === 'auto-merge' || e.kind === 'auto-merge-decline'));
  // Worker inbox has no decline mail
  assert.equal(hive.inbox('w1').length, 0);
});

// ─── Gate 3: an NUnit results.xml <test-run> summary line counts as evidence ──

const nunitRun = (result, failed, passed = 8 - failed) =>
  `<test-run id="2" testcasecount="8" result="${result}" total="8" passed="${passed}" failed="${failed}" inconclusive="0" skipped="0" asserts="0" engine-version="3.5.0.0" start-time="2026-11-13 19:03:58Z">`;

test('Gate 3: an NUnit <test-run result="Passed" failed="0"> line passes (Cedar alpha-gear-3c-implement)', () => {
  const r = extractVerbatimTestLine(`Unity EditMode run, results.xml:\n${nunitRun('Passed', 0)}`);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.line, /<test-run id="2".*result="Passed"/);
});

test('Gate 3: an NUnit <test-run result="Failed" failed="2"> line is refused as tests failed', () => {
  const r = extractVerbatimTestLine(nunitRun('Failed', 2));
  assert.equal(r.ok, false);
  assert.match(r.reason, /tests failed/i);
});

test('Gate 3: NUnit red-first then green passes; green then red is refused', () => {
  assert.equal(extractVerbatimTestLine(`red:\n${nunitRun('Failed', 2)}\ngreen:\n${nunitRun('Passed', 0)}`).ok, true);
  const r = extractVerbatimTestLine(`green:\n${nunitRun('Passed', 0)}\nafter rebase:\n${nunitRun('Failed', 2)}`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /tests failed/i);
});

test('Gate 3: NUnit failed="0" with a non-Passed result does not pass, and prose cannot invent a pass', () => {
  assert.equal(extractVerbatimTestLine(nunitRun('Failed', 0, 6)).ok, false);
  assert.equal(extractVerbatimTestLine('the run result was Passed and failed was 0').ok, false);
});
