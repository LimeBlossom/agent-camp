'use strict';

// hive-sandbox-3: a jailed (research) agent fetches only hosts on its task's allowlist.
// Any other host is refused at PreToolUse with an "ask for it" reason, and the harness
// mails boss a request naming the host and the task.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { netDecision, urlHostsOf, hostAllowed } = loadTs('src/main/netAllow.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');

test('a host matches itself and its subdomains, never a lookalike', () => {
  assert.equal(hostAllowed('docs.unity3d.com', ['unity3d.com']), true);
  assert.equal(hostAllowed('unity3d.com', ['unity3d.com']), true);
  assert.equal(hostAllowed('evilunity3d.com', ['unity3d.com']), false);
  assert.equal(hostAllowed('UNITY3D.com', ['unity3d.com']), true);
  assert.equal(hostAllowed('example.org', []), false);
});

test('loopback is always allowed (Chrome devtools, Blender MCP)', () => {
  for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) assert.equal(hostAllowed(h, []), true, h);
});

test('urls are read from fetch, browser and shell tool input', () => {
  assert.deepEqual(urlHostsOf('read_url_content', { Url: 'https://docs.unity3d.com/Manual/x.html' }), ['docs.unity3d.com']);
  assert.deepEqual(urlHostsOf('browser_navigate', { url: 'http://Evil.Example:8080/a' }), ['evil.example']);
  assert.deepEqual(urlHostsOf('run_command', { CommandLine: 'curl -s https://a.test/x && wget http://b.test/y' }), ['a.test', 'b.test']);
  assert.deepEqual(urlHostsOf('Bash', { command: 'git status' }), []);
});

test('shell punctuation after a bare host is not part of the host (live canary 11-22: github.com; was denied)', () => {
  const cmd = "curl -sS https://github.com; echo $?; curl https://a.test|cat; curl https://b.test&& true; curl https://c.test,https://d.test";
  assert.deepEqual(urlHostsOf('run_command', { CommandLine: cmd }), ['github.com', 'a.test', 'b.test', 'c.test', 'd.test']);
  assert.deepEqual(netDecision({ toolName: 'run_command', input: { CommandLine: 'curl https://github.com; echo exit=$?' }, allow: ['github.com'], taskId: 't' }).blocked, []);
});

test('file writes are not fetches: a cited URL in a note is not checked', () => {
  assert.deepEqual(urlHostsOf('write_to_file', { TargetFile: '/x.md', CodeContent: 'see https://evil.example' }), []);
  assert.deepEqual(urlHostsOf('Write', { file_path: '/x.md', content: 'https://evil.example' }), []);
  assert.deepEqual(urlHostsOf('replace_file_content', { ReplacementContent: 'https://evil.example' }), []);
});

test('a disallowed host is refused with an ask-for-it reason naming host and task', () => {
  const d = netDecision({ toolName: 'read_url_content', input: { Url: 'https://evil.example/p' }, allow: ['unity3d.com'], taskId: 'res-1' });
  assert.deepEqual(d.blocked, ['evil.example']);
  assert.match(d.deny, /ask for it/i);
  assert.match(d.deny, /evil\.example/);
  assert.match(d.deny, /res-1/);
  const ok = netDecision({ toolName: 'read_url_content', input: { Url: 'https://docs.unity3d.com/p' }, allow: ['unity3d.com'], taskId: 'res-1' });
  assert.equal(ok.deny, undefined);
});

test('only the Boss can set a card allowlist', () => {
  const tasks = [{ id: 'res-1', title: 'r', status: 'doing', assignee: 'quince-1' }];
  const now = '2026-11-21T06:00:00.000Z';
  const worker = planTaskMessage({ act: 'task-patch', sender: 'quince-1', isBoss: false, tasks, now, body: { id: 'res-1', netAllow: ['evil.example'] } });
  assert.equal(worker.ok, false);
  const boss = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'res-1', netAllow: ['unity3d.com'] } });
  assert.equal(boss.ok, true);
  const bad = planTaskMessage({ act: 'task-patch', sender: 'god-1', isBoss: true, tasks, now, body: { id: 'res-1', netAllow: 'unity3d.com' } });
  assert.equal(bad.ok, false);
});

// wired into Camp's hook server

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t, cfg = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'net-allow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: home });
  await hive.ensureAgent({ id: 'bulb-1', name: 'Bulb', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  hive.writeTasks([{ id: 'res-1', title: 'research', status: 'doing', assignee: 'quince-1', netAllow: ['unity3d.com'] }]);
  const config = { notifications: false, sandboxedAgents: ['quince-1'], ...cfg };
  const server = new HookServer(hive, () => null, () => config);
  const fire = (agentId, tool_name, tool_input) =>
    server.handle({ hook_event_name: 'PreToolUse', agent_id: agentId, session_id: 's1', cwd: home, tool_name, tool_input });
  const decision = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision;
  const reason = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecisionReason;
  const bossMail = () => {
    const dir = path.join(home, 'hive', 'agents', 'god-1', 'inbox');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
  };
  return { home, hive, fire, decision, reason, bossMail };
}

test('a jailed agent fetches an allowed host', async (t) => {
  const { fire, decision, bossMail } = await floor(t);
  assert.notEqual(decision(fire('quince-1', 'read_url_content', { Url: 'https://docs.unity3d.com/Manual' })), 'deny');
  assert.notEqual(decision(fire('quince-1', 'search_web', { query: 'unity urp decals' })), 'deny');
  assert.equal(bossMail().filter((m) => /evil|allow/i.test(m.subject)).length, 0);
});

test('a jailed agent is refused a disallowed host and boss gets one request naming host and task', async (t) => {
  const { fire, decision, reason, bossMail } = await floor(t);
  const r = fire('quince-1', 'read_url_content', { Url: 'https://evil.example/page' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /ask for it/i);
  const asks = () => bossMail().filter((m) => m.act === 'request' && /evil\.example/.test(`${m.subject} ${m.body}`));
  assert.equal(asks().length, 1);
  assert.match(asks()[0].body, /res-1/);
  assert.match(asks()[0].body, /quince-1/);
  // The same host again is still refused but does not mail boss a second time.
  assert.equal(decision(fire('quince-1', 'run_command', { CommandLine: 'curl https://evil.example/other' })), 'deny');
  assert.equal(asks().length, 1);
});

test('the allowlist is read per fetch: a granted host works on the next call', async (t) => {
  const { hive, fire, decision } = await floor(t);
  assert.equal(decision(fire('quince-1', 'read_url_content', { Url: 'https://wiki.example/a' })), 'deny');
  hive.writeTasks([{ id: 'res-1', title: 'research', status: 'doing', assignee: 'quince-1', netAllow: ['unity3d.com', 'wiki.example'] }]);
  assert.notEqual(decision(fire('quince-1', 'read_url_content', { Url: 'https://wiki.example/a' })), 'deny');
});

test('config netAllowDefault applies on top of the card list', async (t) => {
  const { fire, decision } = await floor(t, { netAllowDefault: ['wikipedia.org'] });
  assert.notEqual(decision(fire('quince-1', 'read_url_content', { Url: 'https://en.wikipedia.org/wiki/X' })), 'deny');
  assert.notEqual(decision(fire('quince-1', 'read_url_content', { Url: 'https://docs.unity3d.com/x' })), 'deny');
});

test('an agent outside the jail list is not restricted', async (t) => {
  const { fire, decision } = await floor(t);
  assert.notEqual(decision(fire('bulb-1', 'WebFetch', { url: 'https://evil.example/x', prompt: 'p' })), 'deny');
});

// camp-net-hook-unresolved-var: Quince's `H=example.com; curl https://$H` filed a boss
// netAllow request for "$h". A host built at runtime cannot be granted by name.

test('a URL host built from a shell variable or substitution is denied as unresolvable, not as a host', () => {
  for (const cmd of ['H=example.com; curl https://$H/x', 'curl https://${H}/x', 'curl https://$(echo example.com)/x', 'curl https://api.$H.com', 'curl https://`echo a.test`/x']) {
    const d = netDecision({ toolName: 'run_command', input: { CommandLine: cmd }, allow: ['unity3d.com'], taskId: 'res-1' });
    assert.deepEqual(d.blocked, [], cmd);
    assert.ok(d.deny, cmd);
    assert.match(d.deny, /not resolvable statically; the proxy decides at runtime/, cmd);
    assert.doesNotMatch(d.deny, /ask for it/i, cmd);
  }
  // A literal host beside a variable one is still named and still asked for.
  const mixed = netDecision({ toolName: 'run_command', input: { CommandLine: 'curl https://$H/x https://evil.example/y' }, allow: [], taskId: 'res-1' });
  assert.deepEqual(mixed.blocked, ['evil.example']);
  assert.match(mixed.deny, /ask for it/i);
  assert.match(mixed.deny, /not resolvable statically/);
  // A variable in the path or query is fine: the host is literal.
  assert.equal(netDecision({ toolName: 'run_command', input: { CommandLine: 'curl https://docs.unity3d.com/$P?q=${Q}' }, allow: ['unity3d.com'], taskId: 'res-1' }).deny, undefined);
});

test('an unresolvable host is denied without a boss netAllow request or a host in the log', async (t) => {
  const { home, hive, fire, decision, reason, bossMail } = await floor(t);
  const r = fire('quince-1', 'run_command', { CommandLine: 'H=example.com; curl https://$H' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /not resolvable statically/);
  assert.equal(bossMail().filter((m) => /net allow/i.test(m.subject)).length, 0);
  await hive.flushWrites();
  const logged = fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'net-deny');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].hosts, []);
});
