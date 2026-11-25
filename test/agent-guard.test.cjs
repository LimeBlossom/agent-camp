'use strict';
/**
 * Agent hard-deny guard (card hive-sandbox-1-hard-denies). Camp's own PreToolUse
 * hook server refuses, for every agent it runs (Claude `Bash` and Codex shell
 * tools alike), any `git push` and any delete aimed outside the agent's scratch,
 * its own hive folder, the hive research folder and the temp dir, whatever the
 * prompt says. Two exceptions: a push of the ~/.claude repo, and the boss's
 * explicit, logged `HIVE_GUARD_OVERRIDE="<reason>"` prefix.
 *
 * Unit API: guardShellCommand(command, ctx) -> { deny: string|null, override: string|null }
 *           guardPatch(patchText, ctx) -> same verdict, for a Codex apply_patch body:
 *           a Delete File, or the source of a Move to, counts as a delete.
 *   ctx.cwd         working directory the command starts in
 *   ctx.home        the home dir `~` and `$HOME` expand to
 *   ctx.deleteRoots absolute dirs deletes may target inside (symlinked spellings resolve)
 *   ctx.pushRepos   repo dirs a push may target
 *   ctx.isBoss      whether the override prefix is honoured
 *
 * The hook server builds deleteRoots from <MD_HIVE_SCRATCH_ROOT>/<id>, the agent's
 * hive folder, <hive>/research and os.tmpdir(); pushRepos is ~/.claude.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-guard-')));
process.on('exit', () => rmTree(base));
const HOME = path.join(base, 'home');
const TMP = path.join(base, 'tmp');
const SCRATCH_ROOT = path.join(base, 'scratch');
const SCRATCH_LINK = path.join(base, 'scratch-link');
const SCRATCH = path.join(SCRATCH_ROOT, 'bulb-1');
const OUTSIDE = path.join(base, 'GameDev');
const CLAUDE_REPO = path.join(HOME, '.claude');
for (const d of [HOME, TMP, SCRATCH, path.join(SCRATCH, 'wt'), OUTSIDE, CLAUDE_REPO]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(SCRATCH_ROOT, SCRATCH_LINK);
// Everything here sits under the real temp dir, so the server's temp root is moved
// to TMP; otherwise OUTSIDE would count as temp and every delete would pass.
process.env.MD_HIVE_SCRATCH_ROOT = SCRATCH_LINK;
process.env.TMPDIR = TMP;

const { guardShellCommand, guardPatch } = loadTs('src/main/agentGuard.ts');

function ctx(over = {}) {
  return { cwd: SCRATCH, home: HOME, env: {}, deleteRoots: [path.join(SCRATCH_LINK, 'bulb-1'), TMP], pushRepos: [CLAUDE_REPO], isBoss: false, ...over };
}
const denied = (cmd, c) => {
  const v = guardShellCommand(cmd, ctx(c));
  assert.ok(v.deny, `expected DENY: ${cmd}`);
  assert.equal(typeof v.deny, 'string');
};
const allowed = (cmd, c) => {
  const v = guardShellCommand(cmd, ctx(c));
  assert.equal(v.deny, null, `expected allow: ${cmd} (got ${v.deny})`);
};

// git push

test('every spelling of git push is denied', () => {
  for (const cmd of [
    'git push',
    'git push origin master',
    'git push --force origin feature',
    'git push -f',
    `git -C ${OUTSIDE} push`,
    `git -C "${OUTSIDE}" push origin HEAD`,
    'git -c core.sshCommand=ssh push',
    'git -c alias.p=push p origin',
    'git -c alias.ship="!git push" ship',
    `git --git-dir=${OUTSIDE}/.git push`,
    'git --no-pager push',
    '/usr/bin/git push',
    'FOO=1 git push',
    'env GIT_TRACE=1 git push',
    'sudo git push',
    'echo hi; git push',
    'git status && git push',
    'false || git push',
    'git commit -m x\ngit push',
    `cd ${OUTSIDE} && git push`,
    'bash -c "git push origin"',
    "sh -lc 'git push'",
    'git send-pack origin master',
  ]) denied(cmd);
});

test('git commands that only mention push are allowed', () => {
  for (const cmd of [
    'git status',
    'git commit -m "push it later"',
    'echo git push',
    'git log --grep push',
    'git config --get remote.origin.pushurl',
    'grep -rn "git push" src',
  ]) allowed(cmd);
});

test('a push of the ~/.claude repo is pre-authorized', () => {
  allowed(`git -C ${CLAUDE_REPO} push`);
  allowed('git -C ~/.claude push');
  allowed('git -C "$HOME/.claude" push origin main');
  allowed(`cd ${CLAUDE_REPO} && git push`);
  allowed('git push', { cwd: CLAUDE_REPO });
  denied(`git -C ${CLAUDE_REPO} push && git -C ${OUTSIDE} push`);
  denied(`git -C ${CLAUDE_REPO}-evil push`);
});

// deletes

test('deletes outside scratch are denied', () => {
  for (const cmd of [
    `rm -rf ${OUTSIDE}`,
    `rm ${OUTSIDE}/a.txt`,
    'rm -rf ~/.claude',
    'rm -rf $HOME/.ssh',
    'rm -rf /',
    `rm -rf ${SCRATCH}/../other-agent`,
    `rm -rf ${SCRATCH_ROOT}`,
    `rm ${SCRATCH}/ok.txt ${OUTSIDE}/bad.txt`,
    `rm -- ${OUTSIDE}/x`,
    `rm ${OUTSIDE}/*`,
    'rm -rf "$UNKNOWN_VAR"',
    'rm -rf $(pwd)/x',
    `unlink ${OUTSIDE}/f`,
    `rmdir ${OUTSIDE}/d`,
    `find ${OUTSIDE} -name "*.tmp" -delete`,
    `find ${OUTSIDE} -type f -exec rm {} \\;`,
    `find ${OUTSIDE} -type f -exec rm -f {} +`,
    `cd ${OUTSIDE} && rm -rf build`,
    `cd ${OUTSIDE} && git clean -fdx`,
    `git -C ${OUTSIDE} clean -fd`,
    `bash -c "rm -rf ${OUTSIDE}"`,
    `sudo rm -rf ${OUTSIDE}`,
    `echo ok && rm -rf ${OUTSIDE}`,
  ]) denied(cmd);
});

test('relative deletes resolve against the cwd', () => {
  denied('rm -rf build', { cwd: OUTSIDE });
  denied('git clean -fdx', { cwd: OUTSIDE });
  denied('ls | xargs rm', { cwd: OUTSIDE });
  allowed('rm -rf build', { cwd: path.join(SCRATCH, 'wt') });
  allowed('git clean -fdx', { cwd: path.join(SCRATCH, 'wt') });
  allowed('ls | xargs rm', { cwd: SCRATCH });
});

test('deletes inside scratch and temp are allowed, whichever spelling of the scratch root', () => {
  for (const cmd of [
    `rm -rf ${SCRATCH}/wt/tmp.txt`,
    `rm -rf ${SCRATCH_LINK}/bulb-1/wt/build`,
    `rm ${SCRATCH}/wt/*.log`,
    `rm ${TMP}/scratch.log`,
    `find ${SCRATCH}/wt -name "*.tmp" -delete`,
    `git -C ${SCRATCH}/wt clean -fd`,
    `unlink ${SCRATCH}/wt/f`,
    `cd ${SCRATCH}/wt && rm -rf node_modules/.cache`,
    `find ${OUTSIDE} -name "*.tmp"`,
    `ls ${OUTSIDE}`,
  ]) allowed(cmd);
});

test('the scratch root itself is not deletable, only inside it', () => {
  denied(`rm -rf ${SCRATCH}`);
  denied(`rm -rf ${SCRATCH_LINK}/bulb-1`);
});

// boss override

test('the boss override lets a push or delete through and reports the reason', () => {
  const boss = { isBoss: true };
  const push = guardShellCommand('HIVE_GUARD_OVERRIDE="merge camp-x" git push origin integration', ctx(boss));
  assert.equal(push.deny, null);
  assert.equal(push.override, 'merge camp-x');
  const rm = guardShellCommand(`HIVE_GUARD_OVERRIDE=cleanup rm -rf ${OUTSIDE}`, ctx(boss));
  assert.equal(rm.deny, null);
  assert.equal(rm.override, 'cleanup');
  assert.equal(guardShellCommand('git status', ctx(boss)).override, null);
});

test('the override is ignored for workers, empty, or not leading the command that needs it', () => {
  denied('HIVE_GUARD_OVERRIDE="merge" git push');
  denied('git push', { isBoss: true });
  denied('HIVE_GUARD_OVERRIDE= git push', { isBoss: true });
  denied('HIVE_GUARD_OVERRIDE="" git push', { isBoss: true });
  denied('HIVE_GUARD_OVERRIDE=x git status && git push', { isBoss: true });
  denied('export HIVE_GUARD_OVERRIDE=x; git push', { isBoss: true });
});

// wired into Camp's hook server (Claude and Codex)

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(base, 'hive-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'bulb-1', name: 'Bulb', provider: 'claude', cwd: SCRATCH });
  await hive.ensureAgent({ id: 'willow-1', name: 'Willow', provider: 'codex', cwd: SCRATCH });
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: SCRATCH });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  const fire = (agentId, tool_name, tool_input, cwd = SCRATCH) =>
    server.handle({ hook_event_name: 'PreToolUse', agent_id: agentId, session_id: 's1', cwd, tool_name, tool_input });
  const decision = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision;
  return { home, hive, fire, decision };
}

test('Camp denies a Claude agent git push and outside delete at PreToolUse', async (t) => {
  const { fire, decision } = await floor(t);
  assert.equal(decision(fire('bulb-1', 'Bash', { command: 'git push origin master' })), 'deny');
  assert.equal(decision(fire('bulb-1', 'Bash', { command: `rm -rf ${OUTSIDE}` })), 'deny');
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: 'rm -rf wt/build' })), 'deny');
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: 'git status' })), 'deny');
  assert.notEqual(decision(fire('bulb-1', 'Write', { file_path: `${OUTSIDE}/x`, content: '' })), 'deny');
});

test('Camp denies the same for Codex shell tools, string or argv command', async (t) => {
  const { fire, decision } = await floor(t);
  assert.equal(decision(fire('willow-1', 'exec_command', { cmd: 'git push' })), 'deny');
  assert.equal(decision(fire('willow-1', 'shell', { command: ['bash', '-lc', 'git push --force'] })), 'deny');
  assert.equal(decision(fire('willow-1', 'local_shell', { command: ['rm', '-rf', OUTSIDE] })), 'deny');
  assert.notEqual(decision(fire('willow-1', 'shell', { command: ['rm', '-rf', `${SCRATCH_ROOT}/willow-1/wt/x`] })), 'deny');
  assert.equal(decision(fire('willow-1', 'shell', { command: ['rm', '-rf', `${SCRATCH}/wt/x`] })), 'deny');
});

test('an agent may delete in its own hive folder, hive research and temp, not a peer folder', async (t) => {
  const { home, fire, decision } = await floor(t);
  const agents = path.join(home, 'hive', 'agents');
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: `rm ${agents}/bulb-1/inbox/m.json` })), 'deny');
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: `rm -rf ${home}/hive/research/draft` })), 'deny');
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: `rm ${TMP}/x.log` })), 'deny');
  assert.equal(decision(fire('bulb-1', 'Bash', { command: `rm -rf ${agents}/willow-1` })), 'deny');
  assert.equal(decision(fire('bulb-1', 'Bash', { command: `rm ${home}/hive/tasks.json` })), 'deny');
});

test('the boss override passes and is written to log.jsonl; a worker using it is still denied', async (t) => {
  const { home, hive, fire, decision } = await floor(t);
  const cmd = 'HIVE_GUARD_OVERRIDE="merge camp-x" git push origin integration';
  assert.notEqual(decision(fire('god-1', 'Bash', { command: cmd })), 'deny');
  assert.equal(decision(fire('bulb-1', 'Bash', { command: cmd })), 'deny');
  await hive.flushWrites();
  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hit = log.filter((e) => e.kind === 'guard-override');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].agentId, 'god-1');
  assert.equal(hit[0].reason, 'merge camp-x');
  assert.match(hit[0].command, /git push origin integration/);
  assert.ok(log.some((e) => e.kind === 'guard-deny' && e.agentId === 'bulb-1'));
});

test('heredoc bodies, comments and redirections are data, not commands', () => {
  allowed(`cat > ${SCRATCH}/m.txt <<'EOF'\ngit push origin master\nrm -rf /\nEOF\necho done`);
  allowed(`cat <<-EOF > ${SCRATCH}/m.txt\n\trm -rf /\n\tEOF`);
  allowed('git status # then git push');
  allowed(`echo x > ${OUTSIDE}/rm.log 2>&1`);
  denied(`cat > ${SCRATCH}/m.txt <<'EOF'\nbody\nEOF\ngit push`);
  denied('echo $(git push)');
});

// Codex apply_patch (card hive-sandbox-1-live-verify, step 2)

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

test('apply_patch file deletes and moves outside scratch are denied', () => {
  const deny = (p) => assert.ok(guardPatch(p, ctx()).deny, `expected DENY: ${p}`);
  const allow = (p) => assert.equal(guardPatch(p, ctx()).deny, null, `expected allow: ${p}`);
  deny(patch(`*** Delete File: ${OUTSIDE}/a.cs`));
  deny(patch('*** Delete File: ../../GameDev/a.cs'));
  deny(patch(`*** Update File: ${OUTSIDE}/a.cs`, `*** Move to: ${SCRATCH}/a.cs`, '@@', '-x', '+y'));
  deny(patch(`*** Add File: ${SCRATCH}/n.txt`, '+hi', `*** Delete File: ${OUTSIDE}/b.cs`));
  allow(patch('*** Delete File: wt/old.cs'));
  allow(patch(`*** Delete File: ${TMP}/x.log`));
  allow(patch(`*** Update File: ${OUTSIDE}/a.cs`, '@@', '-x', '+y'));
  allow(patch(`*** Add File: ${OUTSIDE}/n.txt`, '+hi'));
  allow(patch(`*** Update File: wt/a.cs`, `*** Move to: ${OUTSIDE}/a.cs`, '@@', '-x', '+y'));
});

test('Camp denies Codex apply_patch deletes outside scratch, as a tool or a shell call, and logs guard-deny', async (t) => {
  const { home, hive, fire, decision } = await floor(t);
  const WILLOW = path.join(SCRATCH_ROOT, 'willow-1');
  fs.mkdirSync(WILLOW, { recursive: true });
  const outside = patch(`*** Delete File: ${OUTSIDE}/a.cs`);
  assert.equal(decision(fire('willow-1', 'apply_patch', { command: outside }, WILLOW)), 'deny');
  assert.equal(decision(fire('willow-1', 'apply_patch', { patch: outside }, WILLOW)), 'deny');
  assert.equal(decision(fire('willow-1', 'exec_command', { cmd: `apply_patch <<'EOF'\n${outside}\nEOF` }, WILLOW)), 'deny');
  assert.equal(decision(fire('willow-1', 'shell', { command: ['apply_patch', outside] }, WILLOW)), 'deny');
  assert.notEqual(decision(fire('willow-1', 'apply_patch', { command: patch('*** Delete File: wt/x.cs') }, WILLOW)), 'deny');
  assert.notEqual(decision(fire('willow-1', 'apply_patch', { command: patch(`*** Update File: ${OUTSIDE}/a.cs`, '@@', '-x', '+y') }, WILLOW)), 'deny');
  await hive.flushWrites();
  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.kind === 'guard-deny' && e.agentId === 'willow-1' && /a\.cs/.test(e.command)));
});

test('a Codex shell call resolves relative deletes against its workdir, not the session cwd', async (t) => {
  const { fire, decision } = await floor(t);
  const WILLOW = path.join(SCRATCH_ROOT, 'willow-1');
  assert.equal(decision(fire('willow-1', 'exec_command', { cmd: 'rm -rf build', workdir: OUTSIDE }, WILLOW)), 'deny');
  assert.equal(decision(fire('willow-1', 'shell', { command: ['rm', '-rf', 'build'], workdir: OUTSIDE }, WILLOW)), 'deny');
  assert.equal(decision(fire('willow-1', 'apply_patch', { command: patch('*** Delete File: a.cs'), workdir: OUTSIDE }, WILLOW)), 'deny');
  assert.notEqual(decision(fire('willow-1', 'exec_command', { cmd: 'rm -rf build', workdir: 'wt' }, WILLOW)), 'deny');
});

test('Camp denies the same for Antigravity run_command, resolving relative deletes against its Cwd', async (t) => {
  const { fire, decision } = await floor(t);
  const QUINCE = path.join(SCRATCH_ROOT, 'quince-1');
  assert.equal(decision(fire('quince-1', 'run_command', { CommandLine: 'git push origin master', Cwd: QUINCE })), 'deny');
  assert.equal(decision(fire('quince-1', 'run_command', { CommandLine: `rm -rf ${OUTSIDE}`, Cwd: QUINCE })), 'deny');
  assert.equal(decision(fire('quince-1', 'run_command', { CommandLine: 'rm -rf build', Cwd: OUTSIDE }, QUINCE)), 'deny');
  assert.notEqual(decision(fire('quince-1', 'run_command', { CommandLine: 'rm -rf build', Cwd: QUINCE }, OUTSIDE)), 'deny');
  assert.notEqual(decision(fire('quince-1', 'run_command', { CommandLine: 'git status', Cwd: QUINCE })), 'deny');
});

test('shellCommandOf is the one shell extractor: run_command counts, a CommandLine on another tool does not', () => {
  const { shellCommandOf } = loadTs('src/main/agentGuard.ts');
  assert.equal(shellCommandOf('run_command', { CommandLine: 'git push' }), 'git push');
  assert.equal(shellCommandOf('view_file', { CommandLine: 'git push' }), null);
  assert.equal(shellCommandOf('Bash', { command: 'ls' }), 'ls');
});

// Deny wording: the Boss is told how to lift a deny, a worker is not

test('a Boss shell deny ends with the exact override prefix form; a worker deny does not mention it', () => {
  const cmd = `rm -rf ${OUTSIDE}/x`;
  const boss = guardShellCommand(cmd, ctx({ isBoss: true }));
  assert.ok(boss.deny);
  assert.ok(boss.deny.endsWith('Lead the command with HIVE_GUARD_OVERRIDE="<reason>" to lift this (the reason is logged).'), boss.deny);
  const worker = guardShellCommand(cmd, ctx());
  assert.ok(worker.deny);
  assert.ok(!worker.deny.includes('HIVE_GUARD_OVERRIDE'), worker.deny);
});

test('a Boss apply_patch deny says to delete with rm and the override prefix; a worker deny does not', () => {
  const p = patch(`*** Delete File: ${OUTSIDE}/a.cs`);
  const boss = guardPatch(p, ctx({ isBoss: true }));
  assert.ok(boss.deny);
  assert.ok(boss.deny.includes('rm'), boss.deny);
  assert.ok(boss.deny.includes('HIVE_GUARD_OVERRIDE="<reason>"'), boss.deny);
  const worker = guardPatch(p, ctx());
  assert.ok(worker.deny);
  assert.ok(!worker.deny.includes('HIVE_GUARD_OVERRIDE'), worker.deny);
});

// Variables from the agent's spawn env (card camp-guard-delete-unresolved-var)

const HIVE = path.join(base, 'hive');
const AGENT_DIR = path.join(HIVE, 'agents', 'bulb-1');
fs.mkdirSync(path.join(AGENT_DIR, 'unity-requests'), { recursive: true });
const spawnEnv = { AGENT_ID: 'bulb-1', AGENT_NAME: 'Bulb', HIVE_ROOT: HIVE, AGENT_DIR };
const envCtx = (over = {}) => ({ env: spawnEnv, deleteRoots: [path.join(SCRATCH_LINK, 'bulb-1'), TMP, AGENT_DIR], ...over });

test('a delete through a spawn-env variable is judged on the real path', () => {
  for (const cmd of [
    'rm "$AGENT_DIR/unity-requests/.jail-canary.tmp"',
    'rm -f ${AGENT_DIR}/unity-requests/x.tmp',
    'rm -rf "${HIVE_ROOT}/agents/$AGENT_ID/unity-requests"',
    'cd "$AGENT_DIR" && rm unity-requests/x.tmp'
  ]) allowed(cmd, envCtx());
  for (const cmd of [
    'rm -rf "${HIVE_ROOT}/agents/other-agent"',
    'rm -rf "$HIVE_ROOT"',
    'rm -rf "$HOME/.config"',
    'rm -rf "$AGENT_DIR/../other-agent"'
  ]) {
    const v = guardShellCommand(cmd, ctx(envCtx()));
    assert.ok(v.deny && v.deny.includes('is outside this agent'), `expected outside-deny: ${cmd} (got ${v.deny})`);
  }
});

test('an unknown variable in a delete target is refused by name', () => {
  const v = guardShellCommand('rm -rf "$NOPE/unity-requests/x.tmp"', ctx(envCtx()));
  assert.ok(v.deny && v.deny.includes('$NOPE'), v.deny);
});

test('a spawn-env variable the command itself rebinds is not trusted', () => {
  for (const cmd of [
    'AGENT_DIR=/; rm -rf "$AGENT_DIR"',
    'export AGENT_DIR=/etc; rm -rf "$AGENT_DIR"/x',
    'AGENT_DIR=/etc bash -c \'rm -rf "$AGENT_DIR"/x\'',
    'read AGENT_DIR < f; rm -rf "$AGENT_DIR"/x',
    'for AGENT_DIR in /etc; do rm -rf "$AGENT_DIR"/x; done',
    'source ./vars.sh; rm -rf "$AGENT_DIR"/x',
    'eval "$(cat f)"; rm -rf "$AGENT_DIR"/x',
    '. ./vars.sh && rm -rf "$AGENT_DIR"/x'
  ]) denied(cmd, envCtx());
});
