'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { CAMP_MCP_TOOLS, handleCampMcpCall } = loadTs('src/main/campTools.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

async function hiveFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-restart-hive-'));
  const hive = new HiveManager(() => home);
  t.after(async () => {
    await hive.flushCommits();
    rmTree(home);
  });
  await hive.ensureAgent({ id: 'chief', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker', name: 'Worker', provider: 'claude', cwd: home });
  const hiveRoot = path.join(home, 'hive');
  const outbox = id => path.join(hiveRoot, 'agents', id, 'outbox');
  const call = (agentId, args = {}) => handleCampMcpCall('restart_camp', args, { hiveRoot, agentId });
  return { hive, outbox, call };
}

test('restart_camp is listed with an optional boolean force flag', () => {
  const tool = CAMP_MCP_TOOLS.find(tool => tool.name === 'restart_camp');
  assert.ok(tool, 'the Boss needs restart_camp on the Camp MCP tool list');
  assert.equal(tool.inputSchema.properties.force.type, 'boolean');
  assert.ok(!tool.inputSchema.required?.includes('force'));
});

test('Boss restart_camp reaches main with force through the normal hive router', async t => {
  const { hive, call } = await hiveFixture(t);
  const calls = [];
  const response = call('chief', { force: true });
  assert.ok(!response.isError, response.content[0].text);
  hive.setRestartCampHook((sender, body) => {
    calls.push({ sender, body });
    return { ok: true };
  });
  hive.routeOnce();
  assert.deepEqual(calls, [{ sender: 'chief', body: { force: true } }]);
});

test('MCP refuses a worker even with force and rejects non-boolean force from the Boss', async t => {
  const { call, outbox } = await hiveFixture(t);
  for (const [sender, force, expected] of [
    ['worker', true, /boss|authoriz|forbidden/i],
    ['chief', 'true', /force.*boolean/i],
  ]) {
    const response = call(sender, { force });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, expected);
    assert.deepEqual(fs.readdirSync(outbox(sender)).filter(file => file.endsWith('.json')), []);
  }
});

test('router rejects a raw worker restart request claiming to be from the Boss', async t => {
  const { hive, outbox } = await hiveFixture(t);
  const calls = [];
  hive.setRestartCampHook((...args) => {
    calls.push(args);
    return { ok: true };
  });
  fs.writeFileSync(path.join(outbox('worker'), 'request.json'), JSON.stringify({
    to: 'harness', act: 'restart-camp', from: 'chief', body: { force: true },
  }));
  hive.routeOnce();
  assert.deepEqual(calls, []);
  assert.match(JSON.stringify(hive.inbox('worker')), /boss|authoriz|forbidden/i);
});

test('router tells the Boss when main refuses a restart from a dev build', async t => {
  const { hive, call } = await hiveFixture(t);
  const response = call('chief');
  assert.ok(!response.isError, response.content[0].text);
  hive.setRestartCampHook(() => ({ ok: false, error: 'Cannot relaunch a dev build' }));
  hive.routeOnce();
  assert.ok(hive.inbox('chief').some(msg => msg.act === 'inform' &&
    /cannot relaunch a dev build/i.test(msg.subject + ' ' + msg.body)));
});

test('wrap-up started by the router preserves card edits from the same outbox pass', async t => {
  const { hive, call, outbox } = await hiveFixture(t);
  hive.writeTasks([{ id: 'card', title: 'Card', status: 'doing', assignee: 'worker', dependsOn: [] }]);
  fs.writeFileSync(path.join(outbox('chief'), '0-card.json'), JSON.stringify({
    to: 'harness', act: 'task-patch', body: { id: 'card', status: 'done' },
  }));
  assert.equal(call('chief').isError, undefined);
  hive.setRestartCampHook(() => {
    hive.parkAgentCards('worker', 'wrap-up');
    return { ok: true };
  });
  hive.routeOnce();
  assert.equal(hive.tasks().tasks[0].status, 'done');
});

function restartFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-restart-images-'));
  t.after(() => rmTree(root));
  const installDir = path.join(root, '.local/share/camp');
  const builds = path.join(installDir, 'builds');
  const launcher = path.join(installDir, 'current.AppImage');
  const oldImage = path.join(builds, `Camp-${OLD_SHA}.AppImage`);
  const newImage = path.join(builds, `Camp-${NEW_SHA}.AppImage`);
  fs.mkdirSync(builds, { recursive: true });
  for (const image of [oldImage, newImage]) fs.writeFileSync(image, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.symlinkSync(oldImage, launcher);

  const calls = [];
  const options = {
    platform: 'linux',
    packaged: true,
    appImage: oldImage,
    installDir,
    oldSha: OLD_SHA,
    args: ['argument with spaces'],
    getBlockers: () => [],
    relaunch: params => calls.push(['relaunch', params]),
    startWatchdog: request => ({
      arm(launchOnExit) { calls.push(['watchdog', { ...request, launchOnExit }]); },
      cancel() { calls.push(['watchdog cancelled']); },
    }),
    teardownAndQuit: () => calls.push(['quit']),
    ...overrides,
  };
  const { CampRestartController } = loadTs('src/main/campRestart.ts');
  const controller = new CampRestartController(options);
  const repoint = () => {
    const next = path.join(installDir, 'next.AppImage');
    fs.symlinkSync(newImage, next);
    fs.renameSync(next, launcher);
  };
  return { controller, calls, repoint, launcher, oldImage, newImage };
}

test('relaunch follows current.AppImage after repointing and uses graceful teardown once', async t => {
  const { controller, repoint, calls, launcher, oldImage } = restartFixture(t);
  repoint();
  assert.equal((await controller.request({})).ok, true);
  const relaunches = calls.filter(([action]) => action === 'relaunch');
  assert.equal(relaunches.length, 1);
  const { execPath, args } = relaunches[0][1];
  assert.equal(execPath, launcher);
  assert.notEqual(execPath, oldImage);
  assert.ok(args.includes('argument with spaces'));
  assert.deepEqual(calls.at(-1), ['quit']);
  const duplicate = await controller.request({ force: true });
  assert.equal(duplicate.ok, false);
  assert.equal(calls.filter(([action]) => action === 'quit').length, 1);
});

test('a synchronously unavailable Electron relaunch hands launch to the watchdog before quitting', async t => {
  const { controller, repoint, calls, launcher, oldImage } = restartFixture(t, {
    relaunch: () => { throw new Error('relaunch unavailable'); },
  });
  repoint();
  assert.equal((await controller.request({})).ok, true);
  const watchdog = calls.find(([action]) => action === 'watchdog')?.[1];
  assert.equal(watchdog?.launchOnExit, true);
  assert.equal(watchdog.execPath, launcher);
  assert.equal(watchdog.rollbackPath, oldImage);
  assert.deepEqual(calls.at(-1), ['quit']);
});

test('Electron returning false selects detached launch after shared wrap-up completes', async t => {
  let finish;
  const { controller, repoint, calls } = restartFixture(t, {
    relaunch: () => false,
    beginShutdown: complete => { finish = complete; return { ok: true }; },
  });
  repoint();
  assert.equal((await controller.request({})).ok, true);
  assert.deepEqual(calls, []);
  assert.equal((await finish()).ok, true);
  assert.equal(calls[0][1].launchOnExit, true);
  assert.deepEqual(calls.at(-1), ['quit']);
});

test('a cancelled wrap-up never arms a relaunch, even while a watchdog is starting', async t => {
  let finish;
  let cancel;
  let ready;
  const starting = new Promise(resolve => { ready = resolve; });
  const { controller, repoint, calls } = restartFixture(t, {
    beginShutdown: (complete, cancelRestart) => { finish = complete; cancel = cancelRestart; return { ok: true }; },
    startWatchdog: () => starting,
  });
  repoint();
  assert.equal((await controller.request({})).ok, true);
  const completion = finish();
  cancel();
  ready({ arm: () => calls.push('armed'), cancel: () => calls.push('cancelled') });
  assert.equal((await completion).ok, false);
  assert.deepEqual(calls, ['cancelled']);
});

for (const blocker of ['Worker is mid-step', 'merge in progress', 'autobuild in progress']) {
  test(`restart refuses while ${blocker} and accepts an explicit force`, async t => {
    const { controller, repoint, calls } = restartFixture(t, { getBlockers: () => [blocker] });
    repoint();
    const refused = await controller.request({});
    assert.equal(refused.ok, false);
    assert.ok(refused.error?.includes(blocker), refused.error);
    assert.deepEqual(calls, []);
    assert.equal((await controller.request({ force: true })).ok, true);
    assert.deepEqual(calls.at(-1), ['quit']);
  });
}

test('dev and packaged non-AppImage builds decline relaunch even with force', async t => {
  for (const [config, expected] of [
    [{ packaged: false }, /dev build/i],
    [{ appImage: undefined }, /appimage/i],
  ]) {
    const { controller, repoint, calls } = restartFixture(t, config);
    repoint();
    const result = await controller.request({ force: true });
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.deepEqual(calls, []);
  }
});

test('replacement startup records the embedded SHA and path and informs the Boss about the transition', () => {
  const { recordCampRestartStartup } = loadTs('src/main/campRestart.ts');
  const appPath = '/tmp/.mount_new/resources/app.asar';
  const token = 'restart-test-token';
  const events = [];
  const mail = [];
  recordCampRestartStartup({
    appStart: { kind: 'app-start', appPath, packaged: true },
    sha: NEW_SHA,
    restart: { token, oldSha: OLD_SHA },
    log: event => events.push(event),
    mailBoss: (subject, body) => mail.push({ subject, body }),
  });
  assert.deepEqual(events, [{
    kind: 'app-start', appPath, packaged: true, sha: NEW_SHA, restartToken: token,
  }]);
  assert.equal(mail.length, 1);
  const line = mail[0].subject + ' ' + mail[0].body;
  assert.match(line, new RegExp(OLD_SHA.slice(0, 8) + '.*' + NEW_SHA.slice(0, 8)));
  assert.doesNotMatch(line.trim(), /\n/);
});

test('wrong-build startup and rollback do not send a successful transition inform', () => {
  const { recordCampRestartStartup } = loadTs('src/main/campRestart.ts');
  const events = [];
  const log = event => events.push(event);
  const mailBoss = () => assert.fail('only the expected forward transition may mail success');
  const appStart = { kind: 'app-start' };
  recordCampRestartStartup({ appStart, sha: OLD_SHA, restart: { token: 'forward', oldSha: OLD_SHA, expectedSha: NEW_SHA }, log, mailBoss });
  recordCampRestartStartup({ appStart, sha: OLD_SHA, restart: { token: 'rolled-back', oldSha: OLD_SHA, expectedSha: OLD_SHA, rollback: true }, log, mailBoss });
  assert.deepEqual(events, [
    { kind: 'app-start', sha: OLD_SHA },
    { kind: 'app-start', sha: OLD_SHA, restartToken: 'rolled-back' },
  ]);
});

function watchdogFixture() {
  const calls = [];
  let now = 0;
  const token = 'restart-test-token';
  const execPath = '/fixture/current.AppImage';
  const rollbackPath = `/fixture/builds/Camp-${OLD_SHA}.AppImage`;
  const proof = { kind: 'app-start', restartToken: token, sha: NEW_SHA };
  const options = {
    token,
    execPath,
    rollbackPath,
    expectedSha: NEW_SHA,
    launchOnExit: false,
    timeoutMs: 20,
    waitForOldExit: async () => calls.push('old exited'),
    launch: async executable => calls.push(executable),
    stopReplacement: async () => calls.push('stop replacement'),
    readStartupEvents: () => [proof],
    now: () => now,
    wait: async () => { now += 10; },
    mailBoss: (subject, body) => calls.push(['mail', subject, body]),
  };
  return { options, calls, proof };
}

test('watchdog waits for old Camp to exit before it launches the fallback and accepts matching startup proof', async () => {
  const { runCampRestartWatchdog } = loadTs('src/main/campRestart.ts');
  const { options, calls } = watchdogFixture();
  await runCampRestartWatchdog({ ...options, launchOnExit: true });
  assert.deepEqual(calls, ['old exited', options.execPath]);
});

test('watchdog does not launch a second copy when Electron relaunch succeeds', async () => {
  const { runCampRestartWatchdog } = loadTs('src/main/campRestart.ts');
  const { options, calls } = watchdogFixture();
  await runCampRestartWatchdog(options);
  assert.deepEqual(calls, ['old exited']);
});

test('watchdog ignores stale or wrong-build startup and rolls back once after the timeout', async () => {
  const { runCampRestartWatchdog } = loadTs('src/main/campRestart.ts');
  const { options, calls, proof } = watchdogFixture();
  await runCampRestartWatchdog({
    ...options,
    readStartupEvents: () => [
      { ...proof, restartToken: 'earlier-restart' },
      { ...proof, sha: OLD_SHA },
    ],
  });
  assert.deepEqual(calls.slice(0, 3), ['old exited', 'stop replacement', options.rollbackPath]);
  assert.equal(calls.length, 4);
  assert.equal(calls[3][0], 'mail');
  assert.match(calls[3].slice(1).join(' '), /roll(ed)? back|rollback/i);
});

test('watchdog recognises the replacement after Chromium rewrites its process title', () => {
  const { isCampRestartReplacement } = loadTs('src/main/campRestart.ts');
  const token = '0f9e324f-454d-4f6d-8453-a5caeff64990';
  const args = ['--no-sandbox', `--camp-restart-token=${token}`, `--camp-restart-old-sha=${OLD_SHA}`];
  const launcher = ['/home/u/.local/share/camp/builds/Camp-x.AppImage', ...args].join('\0') + '\0';
  const retitled = ['/tmp/.mount_abc/munder-difflin', ...args].join(' ') + '\0';
  assert.equal(isCampRestartReplacement(launcher, token), true, 'NUL-separated launcher argv');
  assert.equal(isCampRestartReplacement(retitled, token), true, 'the Electron main process after its title rewrite');
  assert.equal(isCampRestartReplacement(`/tmp/.mount_abc/munder-difflin --type=renderer ${args.join(' ')}\0`, token), false);
  assert.equal(isCampRestartReplacement(retitled, token.replace('0f9e', '1f9e')), false);
  assert.equal(isCampRestartReplacement(retitled.replace(token, `${token}0`), token), false);
});
