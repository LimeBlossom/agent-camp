'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const {
  applyCodexNetwork,
  applyCodexSandbox,
  cleanExtraDirs,
  setSandboxWorkspaceWrite,
  codexSandboxMode,
  isCodexSandboxLevel,
  normalizeCodexSandbox,
  setTopLevelTomlKey,
  mergeHookTrust,
  trustOwnHooks,
  DEFAULT_CODEX_SANDBOX
} = loadTs('src/shared/codexSandbox.ts');

test('the default level is sandboxed, and only sandboxed and full are valid', () => {
  assert.equal(DEFAULT_CODEX_SANDBOX, 'sandboxed');
  for (const lv of ['sandboxed', 'full']) assert.equal(isCodexSandboxLevel(lv), true);
  for (const bad of ['', 'hive', 'projects', 'danger-full-access', null, 3]) assert.equal(isCodexSandboxLevel(bad), false);
  assert.equal(codexSandboxMode('sandboxed'), 'workspace-write');
  assert.equal(codexSandboxMode('full'), 'danger-full-access');
});

test('a stored retired level reads as sandboxed; only full stays full', () => {
  assert.equal(normalizeCodexSandbox('projects'), 'sandboxed');
  assert.equal(normalizeCodexSandbox('hive'), 'sandboxed');
  assert.equal(normalizeCodexSandbox(undefined), 'sandboxed');
  assert.equal(normalizeCodexSandbox('garbage'), 'sandboxed');
  assert.equal(normalizeCodexSandbox('full'), 'full');
});

test('sandboxed leaves the auto-mode flags as they are', () => {
  const args = ['-a', 'never', '-s', 'workspace-write', '--add-dir', '/hive'];
  assert.deepEqual(applyCodexSandbox(args, 'sandboxed'), args);
});

test('full rewrites an existing sandbox flag in place', () => {
  assert.deepEqual(
    applyCodexSandbox(['-a', 'never', '-s', 'workspace-write', 'resume', 'x'], 'full'),
    ['-a', 'never', '-s', 'danger-full-access', 'resume', 'x']);
  assert.deepEqual(applyCodexSandbox(['--sandbox', 'read-only'], 'full'), ['--sandbox', 'danger-full-access']);
  assert.deepEqual(applyCodexSandbox(['--sandbox=workspace-write'], 'full'), ['--sandbox=danger-full-access']);
});

test('full adds a sandbox flag when none is present, and leaves the full bypass alone', () => {
  assert.deepEqual(applyCodexSandbox(['--model', 'm'], 'full'), ['-s', 'danger-full-access', '--model', 'm']);
  const bypass = ['--dangerously-bypass-approvals-and-sandbox'];
  assert.deepEqual(applyCodexSandbox(bypass, 'full'), bypass);
});

test('setTopLevelTomlKey rewrites a stale top-level value instead of keeping it', () => {
  const cfg = 'model = "gpt"\nsandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a"]\n';
  const next = setTopLevelTomlKey(cfg, 'sandbox_mode', 'danger-full-access');
  assert.match(next, /^sandbox_mode = "danger-full-access"$/m);
  assert.doesNotMatch(next, /"workspace-write"/);
  assert.equal((next.match(/sandbox_mode/g) || []).length, 1);
});

test('setTopLevelTomlKey prepends when the key is absent, and ignores keys inside tables', () => {
  const cfg = '[profile]\nsandbox_mode = "read-only"\n';
  const next = setTopLevelTomlKey(cfg, 'sandbox_mode', 'workspace-write');
  assert.ok(next.startsWith('sandbox_mode = "workspace-write"\n[profile]'));
  assert.match(next, /\[profile\]\nsandbox_mode = "read-only"/);
});

test('cleanExtraDirs keeps absolute or home paths, once each', () => {
  assert.deepEqual(cleanExtraDirs(' /a \n\nrelative\n~/b\n/a\nC:\\x'), ['/a', '~/b', 'C:\\x']);
  assert.deepEqual(cleanExtraDirs(['/a', 3, '', '/b']), ['/a', '/b']);
  assert.deepEqual(cleanExtraDirs(undefined), []);
});

test('network on puts the override first; off strips a stale one; full leaves args alone', () => {
  const args = ['-a', 'never', '-s', 'workspace-write', 'resume', 'x'];
  assert.deepEqual(applyCodexNetwork(args, 'sandboxed', true),
    ['-c', 'sandbox_workspace_write.network_access=true', ...args]);
  assert.deepEqual(applyCodexNetwork(args, 'sandboxed', false), args);
  const stale = ['-c', 'sandbox_workspace_write.network_access=true', '-c', 'model="m"', ...args];
  assert.deepEqual(applyCodexNetwork(stale, 'sandboxed', false), ['-c', 'model="m"', ...args]);
  assert.deepEqual(applyCodexNetwork(stale, 'sandboxed', true),
    ['-c', 'sandbox_workspace_write.network_access=true', '-c', 'model="m"', ...args], 'never twice');
  assert.deepEqual(applyCodexNetwork(args, 'full', true), args);
});

test('config.toml table: added with roots and the network value', () => {
  const on = setSandboxWorkspaceWrite('model = "m"\n', ['/a', '/b'], true);
  assert.equal(on, 'model = "m"\n\n[sandbox_workspace_write]\nwritable_roots = ["/a","/b"]\nnetwork_access = true\n');
  const off = setSandboxWorkspaceWrite('', [], false);
  assert.equal(off, '\n[sandbox_workspace_write]\nnetwork_access = false\n');
});

test('config.toml table: toggling off rewrites a stale true, once, inside the right table', () => {
  const cfg = '[sandbox_workspace_write]\nwritable_roots = ["/u"]\nnetwork_access = true\n\n[other]\nnetwork_access = true\n';
  const next = setSandboxWorkspaceWrite(cfg, ['/ignored'], false);
  assert.equal(next, '[sandbox_workspace_write]\nwritable_roots = ["/u"]\nnetwork_access = false\n\n[other]\nnetwork_access = true\n');
  assert.equal(setSandboxWorkspaceWrite(next, [], true).match(/network_access = true/g).length, 2, 'only our table flips back');
  const userTable = '[sandbox_workspace_write]\nwritable_roots = ["/u"]\n';
  assert.equal(setSandboxWorkspaceWrite(userTable, ['/x'], true), '[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/u"]\n');
});

test('mergeHookTrust gives one agent the approvals another agent already holds', () => {
  const hazel = [
    '[[hooks.Stop]]', '[[hooks.Stop.hooks]]', 'command = "x"', '',
    '[hooks.state]', '',
    '[hooks.state."/a/hazel/.codex/config.toml:stop:0:0"]', 'trusted_hash = "sha256:aaa"', '',
    '[hooks.state."/a/hazel/.codex/config.toml:session_start:1:0"]', 'trusted_hash = "sha256:bbb"', '',
    '[sandbox_workspace_write]', 'network_access = true', ''
  ].join('\n');
  const next = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "x"\n';
  const out = mergeHookTrust([{ text: hazel, mtimeMs: 1 }], '/a/pine/.codex/config.toml', next);
  assert.ok(out.startsWith(next));
  assert.match(out, /\[hooks\.state\."\/a\/pine\/\.codex\/config\.toml:stop:0:0"\]\ntrusted_hash = "sha256:aaa"/);
  assert.match(out, /\[hooks\.state\."\/a\/pine\/\.codex\/config\.toml:session_start:1:0"\]\ntrusted_hash = "sha256:bbb"/);
  assert.doesNotMatch(out, /hazel/);
  assert.doesNotMatch(out, /sandbox_workspace_write/);
  // Repeated spawns add nothing: the agent's own file is one of the sources next time.
  assert.equal(mergeHookTrust([{ text: hazel, mtimeMs: 1 }, { text: out, mtimeMs: 2 }], '/a/pine/.codex/config.toml', out), out);
});

test('mergeHookTrust takes the newest approval when agents disagree on a slot', () => {
  const old = '[hooks.state."/a/x/config.toml:stop:0:0"]\ntrusted_hash = "sha256:old"\n';
  const fresh = '[hooks.state."/a/y/config.toml:stop:0:0"]\ntrusted_hash = "sha256:new"\n';
  const out = mergeHookTrust([{ text: fresh, mtimeMs: 2 }, { text: old, mtimeMs: 1 }], '/a/z/config.toml', '');
  assert.match(out, /sha256:new/);
  assert.doesNotMatch(out, /sha256:old/);
});

test('mergeHookTrust leaves the config alone when nothing was trusted yet', () => {
  const next = 'model = "gpt"\n';
  assert.equal(mergeHookTrust([], '/a/z/config.toml', next), next);
  assert.equal(mergeHookTrust([{ text: 'model = "old"\n', mtimeMs: 1 }], '/a/z/config.toml', next), next);
});

test('trustOwnHooks approves only the hive own hooks, with the fingerprint Codex reported', () => {
  const hooks = [
    { key: '/h/config.toml:stop:0:0', command: '"/hive/bin/hive-node" "/hive/bin/cth-hook.cjs"', currentHash: 'sha256:own', trustStatus: 'untrusted' },
    { key: '/h/config.toml:stop:1:0', command: 'curl evil.example', currentHash: 'sha256:theirs', trustStatus: 'untrusted' },
    { key: '/h/config.toml:pre_tool_use:0:0', command: '"/hive/bin/cth-hook.cjs"', currentHash: 'sha256:done', trustStatus: 'trusted' }
  ];
  const out = trustOwnHooks('model = "gpt"\n', hooks, (c) => c.includes('/hive/bin/'));
  assert.match(out, /\[hooks\.state\."\/h\/config\.toml:stop:0:0"\]\ntrusted_hash = "sha256:own"/);
  assert.doesNotMatch(out, /sha256:theirs/);
  assert.doesNotMatch(out, /sha256:done/);
});

test('trustOwnHooks replaces a stale fingerprint instead of adding a second table', () => {
  const cfg = '[hooks.state."/h/config.toml:stop:0:0"]\ntrusted_hash = "sha256:stale"\n\n[other]\nx = 1\n';
  const hooks = [{ key: '/h/config.toml:stop:0:0', command: '/hive/bin/cth-hook.cjs', currentHash: 'sha256:fresh', trustStatus: 'modified' }];
  const out = trustOwnHooks(cfg, hooks, () => true);
  assert.equal(out.match(/hooks\.state\."\/h\/config\.toml:stop:0:0"/g).length, 1);
  assert.match(out, /trusted_hash = "sha256:fresh"/);
  assert.doesNotMatch(out, /sha256:stale/);
  assert.match(out, /\[other\]\nx = 1/);
});
