'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Project validation reads <hive>/projects.json; give it a known board instead of the ambient hive.
const projectsHive = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-projects-'));
fs.writeFileSync(path.join(projectsHive, 'projects.json'), JSON.stringify(['Camp', 'Alpha', 'GammaGame']));
process.env.HIVE_ROOT = projectsHive;
process.on('exit', () => rmTree(projectsHive));

const {
  validateAskHumanQuestion,
  copyAndEmbedImages,
  askHuman,
  createCard,
  patchCard,
  dispatchTask,
  sendMsg,
  floorSummary,
  mergeBranch,
  VALID_PROJECTS,
  CAMP_MCP_TOOLS,
  handleCampMcpCall
} = loadTs('src/main/campTools.ts');

test('validateAskHumanQuestion refuses an ask that points at media elsewhere', () => {
  const pointers = [
    'Stills and video are in the previous question on this card.',
    'See the earlier question for the clip.',
    'The screenshots are above.',
    'Look at the last ask for the video.'
  ];
  for (const p of pointers) {
    const res = validateAskHumanQuestion(`**Which look?**\n\n${p}\n\n- A\n- B`);
    assert.equal(res.valid, false, p);
    assert.match(res.error, /embed/i);
  }
  const own = validateAskHumanQuestion('**Which look?**\n\nSame as the previous question.\n\n![a](/x/a.png)');
  assert.equal(own.valid, true);
  const withMedia = validateAskHumanQuestion('**Which look?**\n\nSee the previous question.', true);
  assert.equal(withMedia.valid, true);
  const plain = validateAskHumanQuestion('**Pick one?**\n\nThe above plan is fine.');
  assert.equal(plain.valid, true);
});

test('validateAskHumanQuestion enforces bold first sentence and under ~700 char length', () => {
  // Valid ask
  const validAsk = '**Which button color should we use for the primary CTA?**\n\n- Option A: Coral (`#FF6B6B`)\n- Option B: Amber (`#F59E0B`)';
  const res1 = validateAskHumanQuestion(validAsk);
  assert.equal(res1.valid, true);

  // Missing bold opener
  const noBold = 'Which button color should we use for the primary CTA?\n\n- Option A: Coral';
  const res2 = validateAskHumanQuestion(noBold);
  assert.equal(res2.valid, false);
  assert.match(res2.error, /bold/i, 'Error must indicate first sentence must be bold');

  // Too long (> 700 chars)
  const longAsk = '**Which approach do you prefer?**\n\n' + 'A'.repeat(750);
  const res3 = validateAskHumanQuestion(longAsk);
  assert.equal(res3.valid, false);
  assert.match(res3.error, /700|too long|short/i, 'Error must indicate ask is too long');

  // Empty question
  const emptyRes = validateAskHumanQuestion('   ');
  assert.equal(emptyRes.valid, false);
});

test('copyAndEmbedImages copies files to hive/agents/<id>/shots and embeds markdown images and backticked video paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-tools-'));
  try {
    const hiveRoot = path.join(tmpDir, 'hive');
    const agentId = 'quince-mvnvoaig';
    const shotsDir = path.join(hiveRoot, 'agents', agentId, 'shots');

    // Create a dummy source screenshot and video
    const srcShot = path.join(tmpDir, 'before_after.png');
    fs.writeFileSync(srcShot, Buffer.from('fake-png-data'));
    const srcVideo = path.join(tmpDir, 'demo_gameplay.mp4');
    fs.writeFileSync(srcVideo, Buffer.from('fake-mp4-data'));

    const questionMd = '**Do these pulse colors look right?**\n\nCheck the contrast against the background.';
    const result = copyAndEmbedImages({
      hiveRoot,
      agentId,
      questionMd,
      images: [srcShot],
      videos: [srcVideo]
    });

    // Verify copy destinations
    const destShot = path.join(shotsDir, 'before_after.png');
    assert.ok(fs.existsSync(destShot), 'Image must be copied to hive/agents/<id>/shots/before_after.png');
    assert.deepEqual(fs.readFileSync(destShot), Buffer.from('fake-png-data'));

    const destVideo = path.join(shotsDir, 'demo_gameplay.mp4');
    assert.ok(fs.existsSync(destVideo), 'Video must be copied to hive/agents/<id>/shots/demo_gameplay.mp4');
    assert.deepEqual(fs.readFileSync(destVideo), Buffer.from('fake-mp4-data'));

    // Verify markdown embed for image: ![label](path)
    assert.ok(result.formattedMd.includes(`![before_after](${destShot})`), 'Image embed must use ![label](path)');

    // Verify video is backticked absolute path, NEVER [label](path)
    assert.ok(result.formattedMd.includes(`\`${destVideo}\``), 'Video embed must be backticked absolute path');
    assert.ok(!result.formattedMd.includes(`](${destVideo})`), 'Video embed must never be markdown link syntax');
  } finally {
    rmTree(tmpDir);
  }
});

test('askHuman generates status: blocked and humanQAAppend task-patch with images and videos', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-human-'));
  try {
    const hiveRoot = path.join(tmpDir, 'hive');
    const agentId = 'quince-mvnvoaig';
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });

    const srcShot = path.join(tmpDir, 'overlay.png');
    fs.writeFileSync(srcShot, Buffer.from('fake-overlay-png'));
    const srcVideo = path.join(tmpDir, 'preview.mp4');
    fs.writeFileSync(srcVideo, Buffer.from('fake-video-mp4'));

    const question = '**Should the overlay darken the background?**\n\n- Option 1: 50% black\n- Option 2: 70% blur';
    const res = askHuman({
      kind: 'decision',
      answers: ['Option 1', 'Option 2'],
      hiveRoot,
      agentId,
      cardId: 'camp-feedback-board',
      questionMd: question,
      images: [srcShot],
      videos: [srcVideo],
      outboxDir
    });

    assert.equal(res.ok, true);
    assert.ok(res.patchPayload, 'Must return patchPayload');
    assert.equal(res.patchPayload.to, 'harness');
    assert.equal(res.patchPayload.act, 'task-patch');
    assert.equal(res.patchPayload.body.id, 'camp-feedback-board');
    assert.equal(res.patchPayload.body.status, 'blocked');
    assert.ok(res.patchPayload.body.humanQAAppend, 'Must set humanQAAppend');
    assert.ok(res.patchPayload.body.humanQAAppend.q.includes('overlay.png'), 'Question must embed image');
    assert.ok(res.patchPayload.body.humanQAAppend.q.includes('`' + path.join(hiveRoot, 'agents', agentId, 'shots', 'preview.mp4') + '`'), 'Question must embed backticked video');

    // Check outbox file written
    assert.ok(res.outboxPath && fs.existsSync(res.outboxPath), 'Outbox patch file must be written');
    const written = JSON.parse(fs.readFileSync(res.outboxPath, 'utf8'));
    assert.equal(written.body.id, 'camp-feedback-board');
    assert.equal(written.body.status, 'blocked');
  } finally {
    rmTree(tmpDir);
  }
});

test('createCard enforces required assignee and valid project from VALID_PROJECTS', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-create-card-'));
  try {
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });

    // Missing assignee
    const missingAssignee = createCard({
      title: 'Fix health bar jitter',
      project: 'Camp',
      outboxDir
    });
    assert.equal(missingAssignee.ok, false);
    assert.match(missingAssignee.error, /assignee/i);

    // Missing project
    const missingProject = createCard({
      title: 'Fix health bar jitter',
      assignee: 'cedar-xyz',
      outboxDir
    });
    assert.equal(missingProject.ok, false);
    assert.match(missingProject.error, /project/i);

    // Invalid project
    const invalidProject = createCard({
      title: 'Fix health bar jitter',
      project: 'InvalidProjectName',
      assignee: 'cedar-xyz',
      outboxDir
    });
    assert.equal(invalidProject.ok, false);
    assert.match(invalidProject.error, /Invalid project/i);

    // Valid create
    const res = createCard({
      title: 'Fix health bar jitter on boss encounter',
      description: 'Clamp interpolation delta time when frame rate drops',
      project: 'Camp',
      priority: 'high',
      assignee: 'cedar-xyz',
      difficulty: 'normal',
      outboxDir
    });

    assert.equal(res.ok, true);
    assert.ok(res.createPayload, 'Must return createPayload');
    assert.equal(res.createPayload.to, 'harness');
    assert.equal(res.createPayload.act, 'task-create');
    assert.equal(res.createPayload.body.title, 'Fix health bar jitter on boss encounter');
    assert.equal(res.createPayload.body.project, 'Camp');
    assert.equal(res.createPayload.body.assignee, 'cedar-xyz');
    assert.equal(res.createPayload.body.priority, 'high');

    assert.ok(res.outboxPath && fs.existsSync(res.outboxPath), 'Outbox create file must be written');
  } finally {
    rmTree(tmpDir);
  }
});

test('patchCard validates project and prevents clearing assignee', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-patch-card-'));
  try {
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });

    // Missing id
    const missingId = patchCard({
      status: 'doing',
      outboxDir
    });
    assert.equal(missingId.ok, false);
    assert.match(missingId.error, /id/i);

    // Invalid project
    const invalidProj = patchCard({
      id: 'gamma-123',
      project: 'BadProject',
      outboxDir
    });
    assert.equal(invalidProj.ok, false);
    assert.match(invalidProj.error, /Invalid project/i);

    // Clearing assignee
    const clearedAssignee = patchCard({
      id: 'gamma-123',
      assignee: '',
      outboxDir
    });
    assert.equal(clearedAssignee.ok, false);
    assert.match(clearedAssignee.error, /assignee/i);

    // Valid patch
    const res = patchCard({
      id: 'gamma-123',
      status: 'doing',
      project: 'GammaGame',
      notesAppend: 'Investigating jump curves',
      outboxDir
    });
    assert.equal(res.ok, true);
    assert.equal(res.patchPayload.to, 'harness');
    assert.equal(res.patchPayload.act, 'task-patch');
    assert.equal(res.patchPayload.body.id, 'gamma-123');
    assert.equal(res.patchPayload.body.status, 'doing');
    assert.equal(res.patchPayload.body.project, 'GammaGame');
    assert.equal(res.patchPayload.body.notesAppend, 'Investigating jump curves');
    assert.ok(res.outboxPath && fs.existsSync(res.outboxPath));
  } finally {
    rmTree(tmpDir);
  }
});

test('dispatchTask writes contract into card description/brief and sends NO direct message', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dispatch-'));
  try {
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });

    const contractObj = {
      objective: 'Add pulse bloom',
      output: 'Shader update',
      tools: 'Batch Unity broker',
      boundaries: 'No gameplay script changes'
    };

    // Dispatch with new card object
    const newCard = {
      id: 'mana-vein-bloom',
      title: 'Add pulse bloom to mana veins',
      project: 'Alpha',
      priority: 'medium'
    };

    const res = dispatchTask({
      card: newCard,
      assignee: 'cedar-xyz',
      contract: contractObj,
      project: 'Alpha',
      outboxDir
    });

    assert.equal(res.ok, true);
    assert.equal(res.cardId, 'mana-vein-bloom');
    // NO direct message: exactly 1 action (task-create)
    assert.equal(res.actions.length, 1, 'Must generate exactly 1 action (card write, NO direct message)');
    assert.equal(res.actions[0].kind, 'create');
    assert.equal(res.actions[0].payload.to, 'harness');
    assert.equal(res.actions[0].payload.act, 'task-create');
    assert.equal(res.actions[0].payload.body.assignee, 'cedar-xyz');
    assert.equal(res.actions[0].payload.body.project, 'Alpha');
    assert.ok(res.actions[0].payload.body.brief.includes('OBJECTIVE'), 'brief must contain contract');
    assert.ok(res.actions[0].payload.body.description.includes('OBJECTIVE'), 'description must contain contract');

    // Only 1 file written to outbox (task-create), NO request message
    const files = fs.readdirSync(outboxDir).sort();
    assert.equal(files.length, 1, 'Must write only 1 outbox file');
    const msg = JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf8'));
    assert.equal(msg.act, 'task-create');

    // Dispatch existing card ID
    const res2 = dispatchTask({
      card: 'existing-card-456',
      assignee: 'birch-abc',
      contract: '(1) OBJECTIVE: Rebake maps\n(2) OUTPUT: Prefabs\n(3) TOOLS: Unity\n(4) BOUNDARIES: No scene edits',
      project: 'Camp',
      outboxDir
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.actions.length, 1);
    assert.equal(res2.actions[0].kind, 'patch');
    assert.equal(res2.actions[0].payload.act, 'task-patch');
    assert.equal(res2.actions[0].payload.body.assignee, 'birch-abc');
    assert.equal(res2.actions[0].payload.body.brief, '(1) OBJECTIVE: Rebake maps\n(2) OUTPUT: Prefabs\n(3) TOOLS: Unity\n(4) BOUNDARIES: No scene edits');
  } finally {
    rmTree(tmpDir);
  }
});

test('sendMsg writes outbox JSON, refuses "scheduler", and refuses reply to inform or done', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-send-'));
  try {
    const hiveRoot = path.join(tmpDir, 'hive');
    const agentId = 'god';
    const inboxDir = path.join(hiveRoot, 'agents', agentId, 'inbox');
    const inboxDoneDir = path.join(inboxDir, '.done');
    const outboxDir = path.join(hiveRoot, 'agents', agentId, 'outbox');
    fs.mkdirSync(inboxDoneDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });

    // Seed messages in inbox and inbox/.done
    fs.writeFileSync(path.join(inboxDoneDir, 'inform-msg-1.json'), JSON.stringify({
      id: 'inform-msg-1',
      act: 'inform',
      from: 'worker-1',
      subject: 'build finished',
      body: 'everything green'
    }));
    fs.writeFileSync(path.join(inboxDoneDir, 'done-msg-2.json'), JSON.stringify({
      id: 'done-msg-2',
      act: 'done',
      from: 'quince-mvnvoaig',
      subject: 'tests done',
      body: 'commit 12345'
    }));
    fs.writeFileSync(path.join(inboxDir, 'request-msg-3.json'), JSON.stringify({
      id: 'request-msg-3',
      act: 'request',
      from: 'birch-abc',
      subject: 'clarification needed',
      body: 'which prefab to bake?'
    }));

    // 1. Refuse to scheduler
    const resScheduler = sendMsg({
      to: 'scheduler',
      act: 'inform',
      subject: 'Standup done',
      body: 'All good',
      hiveRoot,
      agentId,
      outboxDir,
      inboxDir
    });
    assert.equal(resScheduler.ok, false);
    assert.match(resScheduler.error, /scheduler/i);

    // 2. Refuse reply to inform
    const resInform = sendMsg({
      to: 'worker-1',
      act: 'inform',
      subject: 'Re: build finished',
      body: 'thanks',
      in_reply_to: 'inform-msg-1',
      hiveRoot,
      agentId,
      outboxDir,
      inboxDir
    });
    assert.equal(resInform.ok, false);
    assert.match(resInform.error, /inform/i);

    // 3. Refuse reply to done
    const resDone = sendMsg({
      to: 'quince-mvnvoaig',
      act: 'inform',
      subject: 'Re: tests done',
      body: 'acknowledged',
      in_reply_to: 'done-msg-2',
      hiveRoot,
      agentId,
      outboxDir,
      inboxDir
    });
    assert.equal(resDone.ok, false);
    assert.match(resDone.error, /done/i);

    // 4. Valid reply to request
    const resValid = sendMsg({
      to: 'birch-abc',
      act: 'inform',
      subject: 'Re: clarification needed',
      body: 'Bake Prefab A',
      in_reply_to: 'request-msg-3',
      hiveRoot,
      agentId,
      outboxDir,
      inboxDir
    });
    assert.equal(resValid.ok, true);
    assert.equal(resValid.payload.to, 'birch-abc');
    assert.equal(resValid.payload.in_reply_to, 'request-msg-3');
    assert.ok(resValid.outboxPath && fs.existsSync(resValid.outboxPath));
  } finally {
    rmTree(tmpDir);
  }
});

test('floorSummary returns compact roster and open cards in a few hundred tokens', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-floor-'));
  try {
    const hiveRoot = tmpDir;
    fs.writeFileSync(path.join(hiveRoot, 'fleet.json'), JSON.stringify({
      agents: [
        { id: 'god', name: 'Maple', role: 'orchestrator (boss)', status: 'idle', dormant: false, model: 'claude-opus-5-5[1m]', breaker: 'healthy', inboxBacklog: 1 },
        { id: 'worker-1', name: 'Cedar', role: 'gameplay code', status: 'busy', dormant: false, model: 'codex', breaker: 'healthy', inboxBacklog: 0 },
        { id: 'worker-2', name: 'Birch', role: 'level design', status: 'idle', dormant: true, model: 'claude-haiku', breaker: 'healthy', inboxBacklog: 0 }
      ]
    }));
    fs.writeFileSync(path.join(hiveRoot, 'registry.json'), JSON.stringify({
      agents: {
        god: { id: 'god', name: 'Maple', role: 'orchestrator (boss)' },
        'worker-1': { id: 'worker-1', name: 'Cedar', role: 'gameplay code' },
        'worker-2': { id: 'worker-2', name: 'Birch', role: 'level design' }
      }
    }));
    fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify({
      tasks: [
        { id: 'card-1', title: 'Fix bug', status: 'doing', project: 'Camp', assignee: 'worker-1' },
        { id: 'card-2', title: 'Add feature', status: 'todo', project: 'Alpha', assignee: 'worker-2' },
        { id: 'card-3', title: 'Old completed task', status: 'done', project: 'Studio', assignee: 'worker-1' }
      ]
    }));

    const res = floorSummary({ hiveRoot });
    assert.equal(res.ok, true);
    assert.ok(typeof res.summary === 'string');
    assert.ok(res.summary.includes('Maple'));
    assert.ok(res.summary.includes('Cedar'));
    assert.ok(res.summary.includes('Birch'));
    assert.ok(res.summary.includes('card-1'));
    assert.ok(res.summary.includes('card-2'));
    assert.ok(!res.summary.includes('Old completed task'), 'Must not list done tasks');
    // Ensure concise (under 2000 chars, ~500 tokens)
    assert.ok(res.summary.length < 2000, `Summary too long: ${res.summary.length} chars`);
  } finally {
    rmTree(tmpDir);
  }
});

test('mergeBranch merges worktree into target via ff-only or cherry-pick, refusing on dirty target paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-merge-'));
  try {
    const repoDir = path.join(tmpDir, 'main-repo');
    const worktreeDir = path.join(tmpDir, 'worktree-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize main repo with initial commit
    spawnSync('git', ['init', '-b', 'main', repoDir], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User']);
    spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(repoDir, 'fileA.txt'), 'version 1');
    spawnSync('git', ['-C', repoDir, 'add', 'fileA.txt']);
    spawnSync('git', ['-C', repoDir, 'commit', '-m', 'initial commit']);

    // Clone or create worktree branch
    spawnSync('git', ['clone', repoDir, worktreeDir], { encoding: 'utf8' });
    spawnSync('git', ['-C', worktreeDir, 'config', 'user.name', 'Worker User']);
    spawnSync('git', ['-C', worktreeDir, 'config', 'user.email', 'worker@example.com']);
    spawnSync('git', ['-C', worktreeDir, 'checkout', '-b', 'feature-branch']);

    // 1. Worker commits a change
    fs.writeFileSync(path.join(worktreeDir, 'fileB.txt'), 'feature B added');
    spawnSync('git', ['-C', worktreeDir, 'add', 'fileB.txt']);
    spawnSync('git', ['-C', worktreeDir, 'commit', '-m', 'add feature B']);

    // Case A: Dirty target path conflicts with incoming commit
    fs.writeFileSync(path.join(repoDir, 'fileB.txt'), 'local dirty uncommitted changes');
    const dirtyRes = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature-branch',
      target: 'main'
    });
    assert.equal(dirtyRes.ok, false);
    assert.match(dirtyRes.error, /dirty/i);
    // Clean up dirty file
    fs.unlinkSync(path.join(repoDir, 'fileB.txt'));

    // Case B: Clean fast-forward merge
    const ffRes = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature-branch',
      target: 'main'
    });
    assert.equal(ffRes.ok, true);
    assert.equal(ffRes.mode, 'fast-forward');
    assert.ok(ffRes.newHead, 'Must return newHead sha');
    assert.ok(fs.existsSync(path.join(repoDir, 'fileB.txt')));

    // Case C: Target moved (cherry-pick needed)
    // Worker adds commit in worktree
    fs.writeFileSync(path.join(worktreeDir, 'fileC.txt'), 'feature C added');
    spawnSync('git', ['-C', worktreeDir, 'add', 'fileC.txt']);
    spawnSync('git', ['-C', worktreeDir, 'commit', '-m', 'add feature C']);

    // Main repo adds its own commit
    fs.writeFileSync(path.join(repoDir, 'fileD.txt'), 'main diverged with feature D');
    spawnSync('git', ['-C', repoDir, 'add', 'fileD.txt']);
    spawnSync('git', ['-C', repoDir, 'commit', '-m', 'add main feature D']);

    // Merge when target moved
    const cpRes = mergeBranch({
      repo: repoDir,
      worktree: worktreeDir,
      branch: 'feature-branch',
      target: 'main'
    });
    assert.equal(cpRes.ok, true);
    assert.equal(cpRes.mode, 'cherry-pick');
    assert.ok(cpRes.newHead);
    assert.ok(fs.existsSync(path.join(repoDir, 'fileC.txt')));
    assert.ok(fs.existsSync(path.join(repoDir, 'fileD.txt')));
    assert.equal(cpRes.push, 'no-upstream');
  } finally {
    rmTree(tmpDir);
  }
});

test('mergeBranch pushes the target to its upstream and reports a rejected push without undoing the merge', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-merge-push-'));
  const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
  const commit = (dir, file, text) => {
    fs.writeFileSync(path.join(dir, file), text);
    git('-C', dir, 'add', file);
    git('-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', file);
  };
  try {
    const remoteDir = path.join(tmpDir, 'remote.git');
    const repoDir = path.join(tmpDir, 'main-repo');
    const worktreeDir = path.join(tmpDir, 'worktree-repo');
    const otherDir = path.join(tmpDir, 'other-machine');
    git('init', '--bare', '-b', 'main', remoteDir);
    git('clone', remoteDir, repoDir);
    git('-C', repoDir, 'checkout', '-b', 'main');
    commit(repoDir, 'fileA.txt', 'v1');
    git('-C', repoDir, 'push', '-u', 'origin', 'main');
    git('clone', repoDir, worktreeDir);
    git('-C', worktreeDir, 'checkout', '-b', 'feature');
    commit(worktreeDir, 'fileB.txt', 'B');

    const pushed = mergeBranch({ repo: repoDir, worktree: worktreeDir, branch: 'feature', target: 'main' });
    assert.equal(pushed.ok, true);
    assert.equal(pushed.push, 'pushed');
    assert.equal(git('-C', remoteDir, 'rev-parse', 'main').stdout.trim(), pushed.newHead);

    git('clone', remoteDir, otherDir);
    commit(otherDir, 'fileD.txt', 'remote moved');
    git('-C', otherDir, 'push', 'origin', 'main');
    commit(worktreeDir, 'fileC.txt', 'C');

    const rejected = mergeBranch({ repo: repoDir, worktree: worktreeDir, branch: 'feature', target: 'main' });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.push, 'failed');
    assert.ok(rejected.pushError);
    assert.equal(git('-C', repoDir, 'rev-parse', 'main').stdout.trim(), rejected.newHead);
    assert.ok(fs.existsSync(path.join(repoDir, 'fileC.txt')));
  } finally {
    rmTree(tmpDir);
  }
});

test('CAMP_MCP_TOOLS exposes every tool with correct schemas', () => {
  const toolNames = CAMP_MCP_TOOLS.map((t) => t.name).sort();
  const expectedTools = [
    'ask_human',
    'create_card',
    'patch_card',
    'dispatch',
    'send',
    'floor',
    'merge',
    'merge_preflight',
    'swap_screenshots',
    'who',
    'restart_agent',
    'restart_camp',
    'archive_agent',
    'unity_hold'
  ].sort();
  assert.deepEqual(toolNames, expectedTools);

  const createCardTool = CAMP_MCP_TOOLS.find((t) => t.name === 'create_card');
  assert.ok(createCardTool.inputSchema.required.includes('title'));
  assert.ok(createCardTool.inputSchema.required.includes('assignee'));
  assert.ok(createCardTool.inputSchema.required.includes('project'));

  const patchCardTool = CAMP_MCP_TOOLS.find((t) => t.name === 'patch_card');
  assert.deepEqual(patchCardTool.inputSchema.required, ['id']);

  const sendTool = CAMP_MCP_TOOLS.find((t) => t.name === 'send');
  assert.deepEqual(sendTool.inputSchema.required.sort(), ['to', 'act', 'subject', 'body'].sort());

  const mergeTool = CAMP_MCP_TOOLS.find((t) => t.name === 'merge');
  assert.deepEqual(mergeTool.inputSchema.required.sort(), ['repo', 'worktree', 'branch', 'target'].sort());
});

test('handleCampMcpCall dispatches to all tools correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-call-'));
  try {
    const hiveRoot = path.join(tmpDir, 'hive');
    const outboxDir = path.join(tmpDir, 'outbox');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(hiveRoot, { recursive: true });
    fs.copyFileSync(path.join(projectsHive, 'projects.json'), path.join(hiveRoot, 'projects.json'));

    const context = { hiveRoot, agentId: 'god', outboxDir };

    // create_card
    const createResp = handleCampMcpCall('create_card', {
      title: 'MCP card title',
      assignee: 'quince-mvnvoaig',
      project: 'Camp'
    }, context);
    assert.equal(createResp.isError, undefined);
    assert.equal(JSON.parse(createResp.content[0].text).ok, true);

    // patch_card
    const patchResp = handleCampMcpCall('patch_card', {
      id: 'some-card',
      status: 'blocked'
    }, context);
    assert.equal(patchResp.isError, undefined);
    assert.equal(JSON.parse(patchResp.content[0].text).ok, true);

    // send
    const sendResp = handleCampMcpCall('send', {
      to: 'scheduler',
      act: 'inform',
      subject: 'hi',
      body: 'hello'
    }, context);
    assert.equal(sendResp.isError, true);
    assert.match(sendResp.content[0].text, /scheduler/i);
  } finally {
    rmTree(tmpDir);
  }
});

test('create_card and patch_card describe kind from the shared list: a visual check is code', () => {
  const { WORK_KINDS } = loadTs('src/shared/workKind.ts');
  for (const name of ['create_card', 'patch_card']) {
    const tool = CAMP_MCP_TOOLS.find((t) => t.name === name);
    const desc = tool.inputSchema.properties.kind.description;
    for (const k of WORK_KINDS) assert.ok(desc.includes(k), `${name} names ${k}`);
    assert.doesNotMatch(desc, /\bvisual,/);
    assert.match(desc, /a visual check is code/i);
  }
});

function mediaAsk(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-media-'));
  const hiveRoot = path.join(dir, 'hive');
  fs.mkdirSync(path.join(hiveRoot, 'research', 'c1'), { recursive: true });
  const base = { hiveRoot, agentId: 'a-1', cardId: 'c1', kind: 'decision', answers: 'yes_no', outboxDir: path.join(dir, 'out') };
  return { dir, hiveRoot, run: (o) => askHuman({ ...base, ...extra, ...o }) };
}

test('an ask embedding a video from research/ is copied into card-attachments/<card>/ and relinked', () => {
  const { dir, hiveRoot, run } = mediaAsk();
  try {
    const mp4 = path.join(hiveRoot, 'research', 'c1', 'clip.mp4');
    const png = path.join(hiveRoot, 'research', 'c1', 'still.png');
    fs.writeFileSync(mp4, 'mp4-bytes');
    fs.writeFileSync(png, 'png-bytes');
    const res = run({ questionMd: `**Keep it?**\n\n![still](${png})\n\n\`${mp4}\`` });
    assert.equal(res.ok, true, res.error);
    const dest = path.join(hiveRoot, 'card-attachments', 'c1');
    assert.equal(fs.readFileSync(path.join(dest, 'clip.mp4'), 'utf8'), 'mp4-bytes');
    assert.equal(fs.readFileSync(path.join(dest, 'still.png'), 'utf8'), 'png-bytes');
    assert.ok(res.formattedQuestion.includes(`![still](${path.join(dest, 'still.png')})`));
    assert.ok(res.formattedQuestion.includes('`' + path.join(dest, 'clip.mp4') + '`'));
    assert.ok(!res.formattedQuestion.includes('research'));
  } finally { rmTree(dir); }
});

test('media already under card-attachments/ or the agent shots folder is left alone', () => {
  const { dir, hiveRoot, run } = mediaAsk();
  try {
    const att = path.join(hiveRoot, 'card-attachments', 'c1');
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, 'a.png'), 'x');
    const res = run({ questionMd: `**Keep it?**\n\n![a](${path.join(att, 'a.png')})` });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.formattedQuestion.includes(path.join(att, 'a.png')));
    assert.deepEqual(fs.readdirSync(att), ['a.png']);
  } finally { rmTree(dir); }
});

test('an ask whose embedded media file does not exist is refused, naming card-attachments/', () => {
  const { dir, hiveRoot, run } = mediaAsk();
  try {
    const res = run({ questionMd: `**Keep it?**\n\n\`${path.join(hiveRoot, 'research', 'c1', 'gone.mp4')}\`` });
    assert.equal(res.ok, false);
    assert.match(res.error, /card-attachments/);
    assert.match(res.error, /gone\.mp4/);
  } finally { rmTree(dir); }
});

test('a relative media path resolves under the hive root and is copied', () => {
  const { dir, hiveRoot, run } = mediaAsk();
  try {
    fs.writeFileSync(path.join(hiveRoot, 'research', 'c1', 'rel.mp4'), 'r');
    const res = run({ questionMd: '**Keep it?**\n\n`research/c1/rel.mp4`' });
    assert.equal(res.ok, true, res.error);
    assert.ok(fs.existsSync(path.join(hiveRoot, 'card-attachments', 'c1', 'rel.mp4')));
    assert.ok(res.formattedQuestion.includes(path.join(hiveRoot, 'card-attachments', 'c1', 'rel.mp4')));
  } finally { rmTree(dir); }
});
