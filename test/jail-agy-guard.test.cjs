'use strict';

// hive-jail-agy-guard: a jailed agent's shell call of raw `agy -p` or `--model gemini-3.1-pro`
// is refused at Camp's PreToolUse, the same rule set as ~/.claude/hooks/agy-guard.sh (which
// only ever sees Claude Code's Bash tool, never Antigravity's run_command).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { agyGuardDeny } = loadTs('src/main/agyGuard.ts');

// Mirrors ~/.claude/hooks/agy-guard.test.py CASES: [command, shouldDeny, label].
const CASES = [
  ["agy -p 'what is X'", true, 'raw -p'],
  ['agy --print "what is X"', true, 'raw --print'],
  ["agy --prompt 'x' --output-format json", true, 'raw --prompt'],
  ["cd /tmp && agy -p 'x'", true, 'raw -p after &&'],
  ["agy -p 'x' --model gemini-3.8-flash-high", true, 'raw -p with a fine model'],
  ["agy-ask 'what is X'", false, 'wrapper'],
  ["agy-ask 'x' --model gemini-3.8-flash-low", false, 'wrapper with a fine model'],
  ['agy models', false, 'models subcommand'],
  ['agy mcp list', false, 'mcp list'],
  ['agy --version', false, 'version'],
  ["agy-ask 'x' --model gemini-3.1-pro-high", true, 'wrapper selecting 3.1-pro'],
  ["agy-ask 'x' --model gemini-3.1-pro-low", true, 'wrapper selecting 3.1-pro-low'],
  ["echo 'never run agy -p directly, use agy-ask'", false, 'prose mentioning agy -p'],
  ["grep -rn 'agy -p' ~/.claude", false, 'grep for the pattern'],
  ['cat ~/.claude/hooks/agy-guard.sh', false, 'reading the guard'],
  ['ls ~/.local/bin', false, 'unrelated'],
  ['git status', false, 'unrelated git']
];

test('agyGuardDeny matches the agy-guard.sh case table', () => {
  for (const [cmd, deny, label] of CASES) {
    assert.equal(agyGuardDeny(cmd) !== null, deny, label);
  }
  assert.match(agyGuardDeny("agy -p 'x'"), /Use agy-ask/);
  assert.match(agyGuardDeny("agy-ask 'x' --model gemini-3.1-pro-high"), /gemini-3\.1-pro/);
});

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'quince-1', name: 'Quince', provider: 'antigravity', cwd: home });
  await hive.ensureAgent({ id: 'bulb-1', name: 'Bulb', provider: 'claude', cwd: home });
  hive.writeTasks([{ id: 'res-1', title: 'research', status: 'doing', assignee: 'quince-1' }]);
  const config = { notifications: false, sandboxedAgents: ['quince-1'] };
  const server = new HookServer(hive, () => null, () => config);
  const fire = (agentId, tool_name, tool_input) =>
    server.handle({ hook_event_name: 'PreToolUse', agent_id: agentId, session_id: 's1', cwd: home, tool_name, tool_input });
  const decision = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision;
  const reason = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecisionReason;
  const log = async () => {
    await hive.flushWrites();
    const f = path.join(home, 'hive', 'log.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { fire, decision, reason, log };
}

test('a jailed agent running raw agy -p through run_command is refused and guard-deny is logged', async (t) => {
  const { fire, decision, reason, log } = await floor(t);
  const r = fire('quince-1', 'run_command', { CommandLine: "agy -p 'summarise the page'", Cwd: '/tmp' });
  assert.equal(decision(r), 'deny');
  assert.match(reason(r), /Use agy-ask/);
  assert.ok((await log()).some((e) => e.kind === 'guard-deny' && e.agentId === 'quince-1' && /agy -p/.test(e.command)));
});

test('a jailed agent selecting gemini-3.1-pro through agy-ask is refused; plain agy-ask runs', async (t) => {
  const { fire, decision } = await floor(t);
  assert.equal(decision(fire('quince-1', 'run_command', { CommandLine: "agy-ask 'x' --model gemini-3.1-pro-high" })), 'deny');
  assert.notEqual(decision(fire('quince-1', 'run_command', { CommandLine: "agy-ask 'what is X'" })), 'deny');
  assert.notEqual(decision(fire('quince-1', 'run_command', { CommandLine: 'agy models' })), 'deny');
});

test('a jailed agent on a Bash-style shell tool is refused too', async (t) => {
  const { fire, decision } = await floor(t);
  assert.equal(decision(fire('quince-1', 'Bash', { command: "cd /tmp && agy --print 'x'" })), 'deny');
});

test('an agent outside the jail list is left to its own engine hooks', async (t) => {
  const { fire, decision } = await floor(t);
  assert.notEqual(decision(fire('bulb-1', 'Bash', { command: "agy -p 'x'" })), 'deny');
});
