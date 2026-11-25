'use strict';

// camp-jail-blender-flatpak-launch: `flatpak run` needs a sandbox of its own, which a jailed
// agent cannot make ("Unable to allocate instance id"), so headless Blender goes through
// `<hive>/bin/runtime/hive-blender`, which runs the flatpak's own binary. A jailed shell call
// of `flatpak run org.blender.Blender` is refused at Camp's PreToolUse, naming the launcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { blenderGuardDeny } = loadTs('src/main/blenderGuard.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { agentToolsLine } = loadTs('src/shared/agentMcp.ts');
const { jailPlan, jailArgv, JAIL_BWRAP } = loadTs('src/main/agentJail.ts');

const POSIX = process.platform !== 'win32';

const CASES = [
  ['flatpak run org.blender.Blender -b --version', true, 'plain'],
  ['cd /tmp && flatpak run org.blender.Blender -b -P render.py', true, 'after &&'],
  ['flatpak run --branch=stable org.blender.Blender -b', true, 'with a flatpak option'],
  ['flatpak  run  org.blender.Blender', true, 'extra spaces'],
  ['BLENDER_USER_CONFIG=/tmp/c flatpak run org.blender.Blender -b', true, 'env prefix'],
  ['hive-blender -b --version', false, 'the launcher'],
  ['flatpak info --show-location org.blender.Blender', false, 'flatpak info'],
  ['flatpak run org.gimp.GIMP', false, 'another app'],
  ["grep -rn 'flatpak run org.blender.Blender' src", false, 'grep for the pattern'],
  ['git status', false, 'unrelated']
];

test('blenderGuardDeny refuses flatpak run of Blender and names hive-blender', () => {
  for (const [cmd, deny, label] of CASES) assert.equal(blenderGuardDeny(cmd) !== null, deny, label);
  assert.match(blenderGuardDeny('flatpak run org.blender.Blender -b'), /hive-blender/);
});

/** `base` is /var/tmp for the live test: the jail's own /tmp is a private tmpfs. */
async function hiveIn(t, prefix, base = os.tmpdir()) {
  const home = fs.mkdtempSync(path.join(base, prefix));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'char-1', name: 'Char', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'bulb-1', name: 'Bulb', provider: 'claude', cwd: home });
  return { home, hive, root: path.join(home, 'hive') };
}

test('a jailed agent running flatpak run org.blender.Blender is refused and guard-deny is logged', async (t) => {
  const { home, hive } = await hiveIn(t, 'jail-blender-');
  hive.writeTasks([{ id: 'art-1', title: 'render', status: 'doing', assignee: 'char-1' }]);
  const server = new HookServer(hive, () => null, () => ({ notifications: false, sandboxedAgents: ['char-1'] }));
  const fire = (agentId, command) => server.handle({
    hook_event_name: 'PreToolUse', agent_id: agentId, session_id: 's1', cwd: home, tool_name: 'Bash', tool_input: { command }
  });
  const out = (r) => (r && r.hookSpecificOutput) || {};

  const r = fire('char-1', 'flatpak run org.blender.Blender -b --version');
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /hive-blender/);
  assert.notEqual(out(fire('char-1', 'hive-blender -b --version')).permissionDecision, 'deny');
  assert.notEqual(out(fire('bulb-1', 'flatpak run org.blender.Blender -b')).permissionDecision, 'deny',
    'an agent outside the jail can still use flatpak run');

  await hive.flushWrites();
  const log = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.kind === 'guard-deny' && e.agentId === 'char-1' && /org\.blender\.Blender/.test(e.command)));
});

/** A fake flatpak install: `flatpak info --show-location` prints `loc`, whose files/blender/blender echoes its args. */
function fakeFlatpak(base) {
  const bin = path.join(base, 'fakebin');
  const loc = path.join(base, 'app-loc');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(loc, 'files', 'blender'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'flatpak'),
    `#!/bin/sh\n[ "$1 $2 $3" = "info --show-location org.blender.Blender" ] && echo '${loc}' && exit 0\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(loc, 'files', 'blender', 'blender'), '#!/bin/sh\necho "fake blender $*"\n', { mode: 0o755 });
  return bin;
}

test('bootstrap writes an executable hive-blender that runs the flatpak\'s own binary', { skip: !POSIX && 'flatpak is Linux only' }, async (t) => {
  const { home, hive } = await hiveIn(t, 'hive-blender-');
  const launcher = path.join(hive.runtimeBinDir(), 'hive-blender');
  assert.equal(fs.existsSync(launcher), true);
  assert.ok(fs.statSync(launcher).mode & 0o111, 'must be executable');

  const env = { PATH: `${fakeFlatpak(home)}:/usr/bin:/bin`, HOME: path.join(home, 'nohome') };
  const ran = spawnSync(launcher, ['-b', '--version'], { encoding: 'utf8', env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), 'fake blender -b --version');

  const none = spawnSync(launcher, ['-b'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(home, 'nohome') } });
  assert.notEqual(none.status, 0, 'no install is a failure, not a silent success');
  assert.match(none.stderr, /org\.blender\.Blender/);
});

test('the tools line and PROTOCOL.md name hive-blender, not flatpak run', async (t) => {
  const line = agentToolsLine({ provider: 'claude', imageGeneration: false, webSearch: null, mcpServers: ['blender'], unity: false, skills: [] });
  assert.match(line, /hive-blender -b/);
  assert.doesNotMatch(line, /flatpak run/);

  const { root } = await hiveIn(t, 'hive-blender-proto-');
  const proto = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
  assert.match(proto, /hive-blender/);
  assert.doesNotMatch(proto, /flatpak run org\.blender\.Blender -b/);
});

// Live: real bwrap and the real Blender flatpak. Skipped when nested inside another jail
// (bwrap refuses to nest) or when the flatpak is not installed.
const flatpakLoc = spawnSync('flatpak', ['info', '--show-location', 'org.blender.Blender'], { encoding: 'utf8' });
const haveBlender = flatpakLoc.status === 0 && fs.existsSync(path.join(flatpakLoc.stdout.trim(), 'files', 'blender', 'blender'));
const bwrapWorks = fs.existsSync(JAIL_BWRAP) && spawnSync(JAIL_BWRAP, ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', 'true']).status === 0;

test('live: in the jail flatpak run fails and hive-blender starts Blender', { skip: (!bwrapWorks && 'bwrap unusable here (nested jail?)') || (!haveBlender && 'no Blender flatpak'), timeout: 120000 }, async (t) => {
  const { home, hive, root } = await hiveIn(t, 'hive-blender-live-', '/var/tmp');
  const scratchRoot = path.join(home, 'scratch');
  fs.mkdirSync(path.join(scratchRoot, 'char-1'), { recursive: true });
  const r = jailPlan({
    provider: 'claude', agentId: 'char-1', home: os.homedir(), agentDir: path.join(root, 'agents', 'char-1'), hiveRoot: root,
    scratchRoot, cwd: path.join(scratchRoot, 'char-1'), extraWritable: [], runtimeDirs: []
  });
  assert.equal(r.ok, true, r.error);
  const jailed = (cmd) => spawnSync(JAIL_BWRAP, jailArgv(r.plan, ['/bin/sh', '-c', cmd]), { encoding: 'utf8', timeout: 90000 });

  const viaFlatpak = jailed('flatpak run org.blender.Blender -b --version');
  assert.ok(viaFlatpak.status !== 0 || !/^Blender \d/m.test(viaFlatpak.stdout),
    `flatpak run unexpectedly started Blender in the jail:\n${viaFlatpak.stdout}`);

  const viaLauncher = jailed(`'${path.join(hive.runtimeBinDir(), 'hive-blender')}' -b --version`);
  assert.equal(viaLauncher.status, 0, viaLauncher.stderr);
  assert.match(viaLauncher.stdout, /^Blender \d/m);
});
