'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');
const { mergeRepos } = require('../test-support/merge-repos.cjs');

const { planTaskMessage, taskCardHowToBoss } = loadTs('src/main/taskPatch.ts');
const { handleHarnessFfMerge } = loadTs('src/main/harnessFfMerge.ts');
const { CAMP_MCP_TOOLS, patchCard, handleCampMcpCall } = loadTs('src/main/campTools.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { CampBuildQueue } = loadTs('src/main/campBuildQueue.ts');

function git(repo, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8' }
  ).trim();
}

function makeCampFloor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-drop-no-merge-'));
  t.after(() => rmTree(root));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'camp-repo');
  const wt = path.join(root, 'worker-wt');
  const installDir = path.join(root, 'install');
  const builds = path.join(installDir, 'builds');
  const launcher = path.join(installDir, 'current.AppImage');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(builds, { recursive: true });

  git(repo, 'init', '-q', '-b', 'integration');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'worktree', 'add', '-q', '-b', 'birch/camp-restart-close-inherited-fds', wt, 'integration');
  fs.writeFileSync(path.join(wt, 'fix.txt'), 'bash shim close fds\n');
  git(wt, 'add', 'fix.txt');
  git(wt, 'commit', '-qm', 'fix: close fds');
  const branchTip = git(wt, 'rev-parse', 'HEAD');

  const image = (sha) => path.join(builds, `Camp-${sha}.AppImage`);
  fs.writeFileSync(image(base), 'installed package');
  fs.symlinkSync(image(base), launcher);

  return { root, home, repo, wt, installDir, base, branchTip, image };
}

test('a done patch carrying merge:false leaves the target branch untouched and triggers no autobuild', async (t) => {
  const f = makeCampFloor(t);
  const hive = new HiveManager(() => f.home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: f.home, isGod: true });
  await hive.ensureAgent({ id: 'birch', name: 'Birch', provider: 'claude', cwd: f.home });
  hive.setFfMergeDeps({ repos: mergeRepos({ camp: f.repo }) });

  hive.writeTasks([
    {
      id: 'camp-restart-close-inherited-fds',
      title: 'Camp restart watchdog: close inherited fds',
      assignee: 'birch',
      status: 'blocked',
      project: 'Camp',
      dependsOn: [],
      createdAt: '2026-11-19T20:20:29.318Z',
      brief: `Branch birch/camp-restart-close-inherited-fds @ ${f.branchTip} (worktree ${f.wt}), base integration ${f.base}.`,
      notes: '11-19 birch: ready; awaiting boss merge',
      testsReady: {
        branch: 'birch/camp-restart-close-inherited-fds',
        worktree: f.wt,
        head: f.branchTip,
        then: 'implement',
        uncovered: 'Step 4: autobuild after merge',
        declaredAt: '2026-11-19T20:30:00Z'
      }
    }
  ]);

  const builtShas = [];
  const buildEvents = [];
  const buildQueue = new CampBuildQueue({
    repo: f.repo,
    branch: 'integration',
    installDir: f.installDir,
    settleMs: 1000,
    packageTip: async (sha) => {
      builtShas.push(sha);
      return f.image(sha);
    },
    log: (evt) => buildEvents.push(evt),
    mailBoss: () => {}
  });
  await buildQueue.poll(0);

  // Boss closes the card with merge: false via patch_card, and worker has a green done message in flight
  const bossOutbox = path.join(f.home, 'hive', 'agents', 'god', 'outbox');
  const patchRes = patchCard({
    hiveRoot: path.join(f.home, 'hive'),
    id: 'camp-restart-close-inherited-fds',
    status: 'done',
    merge: false,
    result: 'Dropped as not-a-bug; branch kept unmerged.',
    outboxDir: bossOutbox
  });
  assert.equal(patchRes.ok, true, patchRes.error);
  assert.equal(patchRes.patchPayload.body.merge, false);

  const workerOutbox = path.join(f.home, 'hive', 'agents', 'birch', 'outbox');
  fs.writeFileSync(
    path.join(workerOutbox, 'done.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'camp-restart-close-inherited-fds done',
      body: `Branch birch/camp-restart-close-inherited-fds (worktree ${f.wt})\n# tests 42\n# pass 42\n# fail 0`
    })
  );

  hive.routeOnce();

  // Card is closed with merge: false recorded
  const closed = hive.tasks().tasks.find((c) => c.id === 'camp-restart-close-inherited-fds');
  assert.equal(closed.status, 'done');
  assert.equal(closed.merge, false);

  // Target branch integration is untouched
  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/integration'), f.base);

  // A subsequent late worker done re-report also skips without merging
  fs.writeFileSync(
    path.join(workerOutbox, 'done-late.json'),
    JSON.stringify({
      to: 'boss',
      act: 'done',
      subject: 'camp-restart-close-inherited-fds re-report',
      body: `Branch birch/camp-restart-close-inherited-fds (worktree ${f.wt})\n# tests 42\n# pass 42\n# fail 0`
    })
  );
  hive.routeOnce();
  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/integration'), f.base);
  assert.equal(hive.inbox('birch').length, 0, 'no retry/rebase mail sent');

  // Autobuild queue polls across settle window and triggers no build
  await buildQueue.poll(500);
  await buildQueue.poll(1500);
  await buildQueue.poll(3000);
  assert.deepEqual(builtShas, []);
  assert.deepEqual(buildEvents, []);
});

test('a done patch without merge:false auto-merges the card branch from its brief/notes', async (t) => {
  const f = makeCampFloor(t);
  const hive = new HiveManager(() => f.home);
  await hive.ensureAgent({ id: 'god', name: 'Boss', provider: 'claude', cwd: f.home, isGod: true });
  await hive.ensureAgent({ id: 'birch', name: 'Birch', provider: 'claude', cwd: f.home });
  hive.setFfMergeDeps({ repos: mergeRepos({ camp: f.repo }) });

  hive.writeTasks([
    {
      id: 'camp-restart-close-inherited-fds',
      title: 'Camp restart watchdog: close inherited fds',
      assignee: 'birch',
      status: 'blocked',
      project: 'Camp',
      dependsOn: [],
      createdAt: '2026-11-19T20:20:29.318Z',
      brief: `Branch birch/camp-restart-close-inherited-fds @ ${f.branchTip} (worktree ${f.wt}), base integration ${f.base}.\n# tests 42\n# pass 42\n# fail 0`,
      notes: '11-19 birch: ready (# tests 42 / # pass 42 / # fail 0); awaiting boss merge'
    }
  ]);

  const bossOutbox = path.join(f.home, 'hive', 'agents', 'god', 'outbox');
  patchCard({
    hiveRoot: path.join(f.home, 'hive'),
    id: 'camp-restart-close-inherited-fds',
    status: 'done',
    result: 'Merged as hygiene.',
    outboxDir: bossOutbox
  });
  hive.routeOnce();

  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/integration'), f.branchTip);
});

test('handleHarnessFfMerge skips a card with merge:false even while open', (t) => {
  const f = makeCampFloor(t);
  const card = {
    id: 'camp-restart-close-inherited-fds',
    title: 'Camp restart',
    assignee: 'birch',
    status: 'blocked',
    project: 'Camp',
    merge: false,
    brief: `Branch birch/camp-restart-close-inherited-fds (worktree ${f.wt})`
  };
  const msg = {
    act: 'done',
    to: 'boss',
    subject: 'camp-restart-close-inherited-fds done',
    body: `Branch birch/camp-restart-close-inherited-fds (worktree ${f.wt})\n# tests 42\n# pass 42\n# fail 0`
  };
  const out = handleHarnessFfMerge('birch', msg, [card], { repos: mergeRepos({ camp: f.repo }) });
  assert.ok(out);
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(out.reason, /dropped|merge:\s*false|unmerged/i);
  assert.equal(git(f.repo, 'rev-parse', 'refs/heads/integration'), f.base);
});

test('planTaskMessage validates merge field: boolean for Boss only, clears approveAction on merge:false', () => {
  const card = {
    id: 'c1',
    title: 'Card',
    assignee: 'w1',
    status: 'blocked',
    approveAction: {
      type: 'merge',
      repo: '/r',
      worktree: '/w',
      branch: 'w1/b',
      target: 'integration',
      head: '0123456789abcdef0123456789abcdef01234567'
    },
    testsReady: {
      branch: 'w1/b',
      worktree: '/w',
      head: '0123456789abcdef0123456789abcdef01234567',
      then: 'implement',
      uncovered: 'Step 4: autobuild after merge',
      declaredAt: '2026-11-19T20:00:00Z'
    }
  };

  // Worker cannot set merge
  const workerAttempt = planTaskMessage({
    act: 'task-patch',
    sender: 'w1',
    isBoss: false,
    tasks: [card],
    now: '2026-11-19T21:00:00Z',
    body: { id: 'c1', status: 'blocked', merge: false }
  });
  assert.equal(workerAttempt.ok, false);
  assert.match(workerAttempt.reason, /not allowed.*merge/);

  // Non-boolean merge is refused
  const badType = planTaskMessage({
    act: 'task-patch',
    sender: 'god',
    isBoss: true,
    tasks: [card],
    now: '2026-11-19T21:00:00Z',
    body: { id: 'c1', status: 'done', merge: 'no' }
  });
  assert.equal(badType.ok, false);
  assert.match(badType.reason, /merge must be a boolean/i);

  // Boss closing with merge:false succeeds without Coverage line even when testsReady had uncovered steps, and clears approveAction
  const bossDrop = planTaskMessage({
    act: 'task-patch',
    sender: 'god',
    isBoss: true,
    tasks: [card],
    now: '2026-11-19T21:00:00Z',
    body: { id: 'c1', status: 'done', merge: false, result: 'Dropped as not-a-bug' }
  });
  assert.equal(bossDrop.ok, true, bossDrop.reason);
  assert.equal(bossDrop.patch.merge, false);
  assert.equal(bossDrop.patch.approveAction, undefined);
  assert.ok('approveAction' in bossDrop.patch);
});

test('patch_card tool schema, handler, and PROTOCOL-BOSS.md document merge:false', (t) => {
  const patchTool = CAMP_MCP_TOOLS.find((tool) => tool.name === 'patch_card');
  assert.ok(patchTool.inputSchema.properties.merge, 'patch_card schema must expose merge');
  assert.equal(patchTool.inputSchema.properties.merge.type, 'boolean');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-drop-docs-'));
  t.after(() => rmTree(tmp));
  const outboxDir = path.join(tmp, 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });

  const mcpResp = handleCampMcpCall(
    'patch_card',
    { id: 'c1', status: 'done', merge: false, result: 'Dropped' },
    { hiveRoot: tmp, agentId: 'god', outboxDir }
  );
  assert.equal(mcpResp.isError, undefined);
  const parsed = JSON.parse(mcpResp.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patchPayload.body.merge, false);

  const badResp = handleCampMcpCall(
    'patch_card',
    { id: 'c1', status: 'done', merge: 'false' },
    { hiveRoot: tmp, agentId: 'god', outboxDir }
  );
  assert.equal(badResp.isError, true);
  assert.match(badResp.content[0].text, /merge/i);

  assert.match(taskCardHowToBoss('/out'), /merge/);

  const hive = new HiveManager(() => tmp);
  hive.ensureHive();
  const protoBoss = fs.readFileSync(path.join(hive.root(), 'PROTOCOL-BOSS.md'), 'utf8');
  const closingSection = protoBoss.split('## Closing a card')[1]?.split('\n## ')[0] ?? '';
  assert.match(closingSection, /merge:\s*false/);
});
