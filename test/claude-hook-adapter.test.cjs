'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { CLAUDE_HOOK_ADAPTER, codexClaudeHookCommands, PORTED_PRE_TOOL_USE } = loadTs('src/main/claudeHookAdapter.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-adapter-'));
const file = path.join(dir, 'claude-hook-adapter.cjs');
fs.writeFileSync(file, CLAUDE_HOOK_ADAPTER);
const A = require(file);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The character the em-dash guard looks for, built so this file never carries it.
const DASH = String.fromCharCode(0x2014);

test('the script and the TS side port the same PreToolUse hooks', () => {
  assert.deepEqual(A.PORTED_PRE, PORTED_PRE_TOOL_USE);
});

test('a Codex shell call becomes a Claude Bash call, string or argv form', () => {
  const [a] = A.translate({ tool_name: 'Bash', cwd: '/r', tool_input: { command: 'git status' } });
  assert.equal(a.tool_name, 'Bash');
  assert.deepEqual(a.tool_input, { command: 'git status' });
  const [b] = A.translate({ tool_name: 'exec_command', cwd: '/r', tool_input: { cmd: 'ls -la' } });
  assert.deepEqual(b.tool_input, { command: 'ls -la' });
  const [c] = A.translate({ tool_name: 'shell', cwd: '/r', tool_input: { command: ['bash', '-lc', 'git commit -m x'] } });
  assert.deepEqual(c.tool_input, { command: 'git commit -m x' });
  assert.deepEqual(A.translate({ tool_name: 'Bash', tool_input: {} }), []);
  assert.deepEqual(A.translate({ tool_name: 'web_search', tool_input: { q: 'x' } }), []);
});

test('apply_patch becomes one Write per added file and one Edit per updated file', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: notes/new.md',
    '+first ' + DASH + ' line',
    '+second',
    '*** Update File: src/a.ts',
    '@@ function x',
    ' keep',
    '-old line',
    '+new line',
    '*** Delete File: gone.txt',
    '*** Update File: b.ts',
    '*** Move to: c.ts',
    '+moved',
    '*** End Patch'
  ].join('\n');
  const calls = A.translate({ tool_name: 'apply_patch', cwd: '/repo', tool_input: { command: patch } });
  assert.deepEqual(calls.map((c) => [c.tool_name, c.tool_input]), [
    ['Write', { file_path: '/repo/notes/new.md', content: 'first ' + DASH + ' line\nsecond' }],
    ['Edit', { file_path: '/repo/src/a.ts', old_string: 'old line', new_string: 'new line' }],
    ['Edit', { file_path: '/repo/c.ts', old_string: '', new_string: 'moved' }]
  ]);
  assert.ok(calls.every((c) => c.hook_event_name === 'PreToolUse'));
});

test('a deny (JSON or exit 2) blocks; allow and ask never reach Codex, context passes', () => {
  assert.deepEqual(A.interpret({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }) }), { deny: 'no' });
  assert.deepEqual(A.interpret({ status: 2, stdout: '', stderr: 'stop it\n' }), { deny: 'stop it' });
  assert.deepEqual(A.interpret({ status: 0, stdout: JSON.stringify({ decision: 'block', reason: 'r' }) }), { deny: 'r' });
  assert.deepEqual(A.interpret({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) }), {});
  assert.deepEqual(A.interpret({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'q' } }) }), {});
  assert.deepEqual(A.interpret({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'heads up' } }) }), { context: 'heads up' });
  assert.deepEqual(A.interpret({ status: 0, stdout: 'not json' }), {});
});

test('preToolUse runs only matching hooks, returns the first deny in Codex shape', () => {
  const ran = [];
  const hooks = [
    { matcher: 'Write|Edit', command: 'em' },
    { matcher: 'Bash', command: 'git' },
    { matcher: '*', command: 'all' }
  ];
  const run = (cmd, input) => {
    const call = JSON.parse(input);
    ran.push(cmd + ':' + call.tool_name);
    if (cmd === 'em' && String(call.tool_input.content || call.tool_input.new_string).includes(DASH)) {
      return { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Em dash blocked' } }) };
    }
    if (cmd === 'git') return { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'warned' } }) };
    return { status: 0, stdout: '' };
  };
  const denied = A.preToolUse({ tool_name: 'apply_patch', cwd: os.tmpdir(), tool_input: { command: '*** Add File: a.md\n+x ' + DASH + ' y' } }, hooks, run);
  assert.deepEqual(denied, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Em dash blocked' } });
  assert.deepEqual(ran, ['em:Write']);
  ran.length = 0;
  const warned = A.preToolUse({ tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command: 'git add -A' } }, hooks, run);
  assert.deepEqual(warned, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'warned' } });
  assert.deepEqual(ran, ['git:Bash', 'all:Bash']);
  assert.equal(A.preToolUse({ tool_name: 'apply_patch', cwd: os.tmpdir(), tool_input: { command: '*** Add File: a.md\n+plain' } }, hooks, run), null);
});

test('hooksFor keeps only allowed scripts from Claude settings', () => {
  const settings = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/git-guard.sh"' }, { type: 'command', command: 'bash x/usage-hard-stop.sh' }] },
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/no-em-dashes.sh"' }] }
  ] } };
  assert.deepEqual(A.hooksFor(settings, 'PreToolUse', A.PORTED_PRE).map((h) => [h.matcher, A.scriptName(h.command)]),
    [['Bash', 'git-guard.sh'], ['Write|Edit', 'no-em-dashes.sh']]);
});

test('SessionStart output: hookSpecificOutput passes through, plain text is wrapped, empty is nothing', () => {
  assert.deepEqual(A.sessionStartOutput(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'MACHINE IDENTITY' } })),
    { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'MACHINE IDENTITY' } });
  assert.deepEqual(A.sessionStartOutput('plain context\n'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'plain context' } });
  assert.equal(A.sessionStartOutput(''), null);
  assert.equal(A.sessionStartOutput(JSON.stringify({ hookSpecificOutput: { additionalContext: '' } })), null);
});

test('registration: machine identity is the only SessionStart hook, side-effect hooks excluded, one PreToolUse entry', () => {
  const settings = { hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/vault-sync.sh"' }] },
      { hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/inject-machine-identity.sh" SessionStart' }] },
      { hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/inject-global-memory.sh" SessionStart 2' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/config-sync.sh" pull' }] }
    ],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "$HOME/.claude/hooks/git-guard.sh"' }] }]
  } };
  assert.deepEqual(codexClaudeHookCommands(settings, '"node" "/a.cjs"'), [
    { event: 'PreToolUse', command: '"node" "/a.cjs" pre-tool-use' },
    { event: 'SessionStart', command: '"node" "/a.cjs" session-start bash "$HOME/.claude/hooks/inject-machine-identity.sh" SessionStart' }
  ]);
  assert.deepEqual(codexClaudeHookCommands({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash usage-hard-stop.sh' }] }] } }, 'n'), []);
  assert.deepEqual(codexClaudeHookCommands(null, 'n'), []);
});
