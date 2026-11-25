'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { buildHandoff, codexDigest, claudeDigest, HANDOFF_CAP } = loadTs('src/main/handoff.ts');
const { takeHandoff } = loadTs('src/main/hive.ts');
const { startPromptText } = loadTs('src/shared/dormantWake.ts');

const ts = (s) => `2026-10-02T05:${String(s).padStart(2, '0')}:00.000Z`;
const item = (s, payload) => JSON.stringify({ timestamp: ts(s), type: 'response_item', payload });
const say = (s, text) => item(s, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const execCall = (s, id, cmd) => item(s, { type: 'custom_tool_call', name: 'exec', call_id: id, input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)},"max_output_tokens":4000}));\n` });
const execOut = (s, id, out, code = 0) => item(s, {
  type: 'custom_tool_call_output', call_id: id,
  output: [{ type: 'input_text', text: 'Script completed\nWall time 0.5 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: code, output: out }) }]
});

const ROLLOUT = [
  item(0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'START' }] }),
  say(1, 'I will read the card first.'),
  execCall(2, 'c1', 'cat my-tasks.md'),
  execOut(3, 'c1', '- `t1` doing: dust plume'),
  item(4, { type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify({ cmd: 'git status --short' }) }),
  item(5, { type: 'function_call_output', call_id: 'c2', output: ' M Assets/Plume.cs' }),
  say(6, 'Adding the debris burst along the impact strip.'),
  JSON.stringify({ timestamp: ts(7), type: 'event_msg', payload: { type: 'task_complete', error: { message: 'You’ve hit your usage limit.' } } })
].join('\n');

test('codexDigest keeps assistant messages and tool calls in order, with short results', () => {
  const d = codexDigest(ROLLOUT);
  assert.deepEqual(d.messages, ['I will read the card first.', 'Adding the debris burst along the impact strip.']);
  assert.equal(d.tools.length, 2);
  assert.equal(d.tools[0].call, '$ cat my-tasks.md');
  assert.equal(d.tools[0].result, 'exit 0: - `t1` doing: dust plume');
  assert.equal(d.tools[1].call, '$ git status --short');
  assert.equal(d.tools[1].result, 'M Assets/Plume.cs');
});

test('claudeDigest joins one message\'s text blocks and pairs tool results', () => {
  const rec = (o) => JSON.stringify(o);
  const text = [
    rec({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Plan: fix it.' }] } }),
    rec({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: '3 failing', is_error: true }] } }),
    rec({ type: 'assistant', isApiErrorMessage: true, message: { id: 'm2', content: [{ type: 'text', text: 'Claude AI usage limit reached' }] } })
  ].join('\n');
  const d = claudeDigest(text);
  assert.deepEqual(d.messages, ['Plan: fix it.']);
  assert.deepEqual(d.tools, [{ call: '$ npm test', result: 'error: 3 failing' }]);
});

const base = {
  agentName: 'Hazel', from: 'codex/default', to: 'claude/default',
  resetAtMs: Date.parse('2026-10-02T06:08:00.000Z'), nowMs: Date.parse('2026-10-02T05:41:00.000Z'),
  cards: [{ id: 't1', title: 'Dust plume', status: 'doing', notes: 'pylon impact' }],
  repos: [{ path: '/repo', status: ' M Assets/Plume.cs\n?? Assets/New.cs\n', diffStat: ' Assets/Plume.cs | 12 ++++\n 1 file changed\n' }]
};

test('the note carries cards, git sections and history, oldest first', () => {
  const note = buildHandoff({ ...base, digest: codexDigest(ROLLOUT) });
  assert.match(note, /# Handoff for Hazel/);
  assert.match(note, /ran on codex\/default .*; this one runs on claude\/default/);
  assert.match(note, /`t1` doing: Dust plume\n  notes: pylon impact/);
  assert.match(note, /## Git: \/repo\n`git status --short`:\n```\n M Assets\/Plume.cs\n\?\? Assets\/New.cs\n```/);
  assert.match(note, /`git diff --stat`:\n```\n Assets\/Plume.cs \| 12 \+\+\+\+\n 1 file changed\n```/);
  assert.ok(note.indexOf('I will read the card first.') < note.indexOf('Adding the debris burst'));
  assert.ok(note.indexOf('$ cat my-tasks.md') < note.indexOf('$ git status --short'));
});

test('the cap drops the oldest history first and keeps cards and git', () => {
  const digest = {
    messages: Array.from({ length: 10 }, (_, i) => `message ${i} ${'x'.repeat(500)}`),
    tools: Array.from({ length: 30 }, (_, i) => ({ call: `$ step ${i} ${'y'.repeat(150)}`, result: 'z'.repeat(150) }))
  };
  const note = buildHandoff({ ...base, digest });
  assert.ok(note.length <= HANDOFF_CAP, `note is ${note.length} chars`);
  assert.match(note, /Dust plume/);
  assert.match(note, /## Git: \/repo/);
  assert.match(note, /message 9 /);
  assert.doesNotMatch(note, /message 0 /);
  assert.match(note, /\$ step 29 /);
  assert.doesNotMatch(note, /\$ step 0 /);
});

test('the redactor runs over history', () => {
  const digest = { messages: ['key is sk-SECRET'], tools: [{ call: '$ echo sk-SECRET', result: 'sk-SECRET' }] };
  const note = buildHandoff({ ...base, digest }, HANDOFF_CAP, (s) => s.replace(/sk-SECRET/g, '[redacted]'));
  assert.doesNotMatch(note, /sk-SECRET/);
});

test('a handoff is consumed once: the next start prompt carries it, the one after does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  try {
    fs.writeFileSync(path.join(dir, 'handoff.md'), '# Handoff for Hazel\nlast step: plume');
    const first = takeHandoff(dir);
    assert.match(first, /last step: plume/);
    assert.equal(fs.existsSync(path.join(dir, 'handoff.md')), false);
    assert.equal(fs.existsSync(path.join(dir, 'handoff.consumed.md')), true);
    assert.equal(takeHandoff(dir), null);
    const work = { isGod: false, memoryPath: '/a/memory.md', archivePath: '/a/memory-archive.md', memoryChars: 10, myTasksPath: '/a/my-tasks.md', tasksPath: '/h/tasks.json', inboxDir: '/a/inbox', tasks: [{ id: 't1', title: 'Dust plume', status: 'doing' }], messages: [] };
    const prompt = startPromptText({ ...work, handoff: first });
    assert.match(prompt, /You are continuing work another session started/);
    assert.match(prompt, /<handoff>\n# Handoff for Hazel\nlast step: plume\n<\/handoff>/);
    assert.match(prompt, /check `git status` and `git diff`/);
    assert.ok(prompt.indexOf('<handoff>') < prompt.indexOf('Read /a/memory.md'));
    assert.doesNotMatch(startPromptText(work), /handoff/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repoHints names the folders recent commands worked in, newest first', () => {
  const digest = { messages: [], tools: [
    { call: "$ git -C '/a/b c' status --short" },
    { call: '$ cd /x/clone && git diff' },
    { call: '$ git -C "/a/b c" log -1 ; cd relative/dir' }
  ] };
  assert.deepEqual(loadTs('src/main/handoff.ts').repoHints(digest), ['/a/b c', '/x/clone']);
});

test('a manual model switch says so instead of blaming the usage limit', () => {
  const note = buildHandoff({ ...base, reason: 'manual', digest: codexDigest(ROLLOUT) });
  assert.match(note, /was stopped when the human switched models/);
  assert.doesNotMatch(note, /stopped at its usage limit/);
  assert.match(buildHandoff({ ...base, digest: codexDigest(ROLLOUT) }), /stopped at its usage limit/);
});

const sh = (cwd, ...args) => require('node:child_process').execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
const writeJson = (file, obj, mtimeMs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
};

test('a handoff for an agent with no session log carries its cards, mail, memory and worktrees', async () => {
  const { gatherHandoff, logGapReason } = loadTs('src/main/handoffGather.ts');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-gather-')));
  try {
    const hiveRoot = path.join(tmp, 'hive');
    const scratchRoot = path.join(tmp, 'scratch');
    const agentDir = path.join(hiveRoot, 'agents', 'fx-1');
    const nowMs = Date.parse('2026-11-02T14:28:00.000Z');
    const at = (hhmm) => Date.parse(`2026-11-02T${hhmm}:00.000Z`);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'memory.md'), '# Fixture memory\nworks in Repo-fx\n');
    writeJson(path.join(agentDir, 'inbox/.done/2026-11-02T10-00-00-000Z-aaa111.json'), { id: '2026-11-02T10-00-00-000Z-aaa111', from: 'boss', to: 'fx-1', act: 'request', subject: 'Rebase the strike branch', body: 'Rebase onto master 5a64cd63 and rebuild.', created_at: '2026-11-02T10:00:00.000Z' }, at('10:00'));
    writeJson(path.join(agentDir, 'inbox/.done/2026-11-02T14-40-00-000Z-bbb222.json'), { id: 'later', from: 'god', to: 'fx-1', act: 'inform', subject: 'Orientation after your switch', body: 'after the handoff', created_at: '2026-11-02T14:40:00.000Z' }, at('14:40'));
    writeJson(path.join(agentDir, 'outbox/.sent/strike-done.json'), { to: 'boss', act: 'done', subject: 'Strike rebased, HEAD 4a1ecd2b', body: 'Rebased and rebuilt the DLLs.' }, at('12:15'));
    writeJson(path.join(agentDir, 'outbox/.sent/strike-patch.json'), { to: 'harness', act: 'task-patch', body: { id: 'c-merge', status: 'blocked' } }, at('12:16'));

    const card = (id, status, extra = {}) => ({ id, title: `Title of ${id}`, status, assignee: 'fx-1', ...extra });
    const tasks = [
      card('c-doing', 'doing', { notes: 'first step\nsecond step\nthird step\nfourth step' }),
      card('c-todo', 'todo'),
      card('c-own', 'blocked', { notes: 'started\nbuild fails on step 2; fixing it myself' }),
      card('c-answered', 'blocked', { notes: 'awaiting boss merge; ASK ME sent', updatedAt: '2026-11-02T13:00:05.000Z', humanQA: [{ q: 'Bigger font?', askedAt: '2026-11-02T12:00:00.000Z', a: 'Make the font bigger and retry', answeredAt: '2026-11-02T13:00:00.000Z' }] }),
      card('c-human', 'blocked', { notes: 'asked the human', humanQA: [{ q: 'Which colour?', askedAt: '2026-11-02T12:00:00.000Z' }] }),
      card('c-merge', 'blocked', { notes: 'awaiting boss merge' }),
      card('c-approved', 'blocked', { notes: 'awaiting boss merge', updatedAt: '2026-11-02T13:00:00.000Z', humanQA: [{ q: 'Ship?', askedAt: '2026-11-02T12:00:00.000Z', a: 'approved', answeredAt: '2026-11-02T13:00:00.000Z' }] }),
      card('c-backlog', 'blocked', { notes: 'fixing', backloggedAt: '2026-11-01T00:00:00.000Z' }),
      card('c-dep', 'blocked', { notes: 'fixing', dependsOn: ['other-card'] }),
      card('c-finished', 'done'),
      { id: 'other-card', title: 'Someone else', status: 'todo', assignee: 'fx-2' }
    ];

    const repo = path.join(scratchRoot, 'fx-1', 'Repo-fx');
    const origin = path.join(tmp, 'origin.git');
    fs.mkdirSync(repo, { recursive: true });
    sh(tmp, 'init', '-q', '--bare', origin);
    sh(repo, 'init', '-q', '-b', 'fx/strike');
    sh(repo, 'config', 'user.email', 'fx@example.com');
    sh(repo, 'config', 'user.name', 'Fixture');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'Pushed base');
    sh(repo, 'remote', 'add', 'origin', origin);
    sh(repo, 'push', '-q', '-u', 'origin', 'fx/strike');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    sh(repo, 'commit', '-q', '-am', 'Unpushed strike fix');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    fs.mkdirSync(path.join(scratchRoot, 'fx-1', 'not-a-repo'));

    const gathered = await gatherHandoff({ hiveRoot, agentId: 'fx-1', scratchRoot, tasks, nowMs });
    const note = buildHandoff({
      agentName: 'Fixture', from: 'antigravity/Gemini 4 Argon (Medium)', to: 'claude/claude-opus-5-5', resetAtMs: at('20:51'), nowMs,
      stopDetail: 'Individual quota reached for Gemini 4 Argon',
      logGap: logGapReason({ provider: 'antigravity', hadSession: true, logPath: null, logChars: 0 }),
      digest: { messages: [], tools: [] }, ...gathered
    });

    assert.ok(note.length <= HANDOFF_CAP, `note is ${note.length} chars`);
    assert.doesNotMatch(note, /None recorded/);
    assert.match(note, /Individual quota reached for Gemini 4 Argon/);
    assert.match(note, /antigravity \(agy\) keeps no session log/);
    assert.match(note, /`c-doing` doing: Title of c-doing\n  notes: .*second step.*fourth step/);
    assert.doesNotMatch(note, /first step/);
    assert.match(note, /`c-todo` todo: Title of c-todo/);
    assert.match(note, /`c-own` blocked: Title of c-own\n  yours because: .*build fails on step 2/);
    assert.match(note, /`c-answered` blocked: .*\n  yours because: The human answered your ask: Make the font bigger and retry/);
    for (const hidden of ['c-human', 'c-merge', 'c-approved', 'c-backlog', 'c-dep', 'c-finished', 'other-card']) assert.doesNotMatch(note, new RegExp(`\`${hidden}\``));
    assert.match(note, /5 blocked cards waiting on others, not shown\./);
    assert.ok(note.indexOf('`c-doing`') < note.indexOf('`c-todo`') && note.indexOf('`c-todo`') < note.indexOf('`c-own`'));
    assert.match(note, /from boss, request: Rebase the strike branch\n  Rebase onto master 5a64cd63/);
    assert.match(note, /to boss, done: Strike rebased, HEAD 4a1ecd2b/);
    assert.ok(note.indexOf('Rebase the strike branch') < note.indexOf('Strike rebased'));
    assert.doesNotMatch(note, /Orientation after your switch|task-patch/);
    assert.match(note, new RegExp(`${path.join(agentDir, 'memory.md').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(note, new RegExp(`## Git: ${repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\nbranch fx/strike`));
    assert.match(note, /1 commit not pushed to origin\/fx\/strike:\n.*Unpushed strike fix/);
    assert.match(note, / M a\.txt\n\?\? new\.txt/);
    assert.doesNotMatch(note, /not-a-repo/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
