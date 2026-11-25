'use strict';

/**
 * Lazy agent loading: app launch starts only the Boss, and every other roster
 * agent stays dormant until it has work. These pin what counts as work, which
 * registry agents go dormant, and that a dormant agent still gets mail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { dormantWakeReason, tasksOf, planDormancy, rosterIdsOf, startPromptText, MEMORY_DIGEST_CAP } = loadTs('src/shared/dormantWake.ts');
const { selectBroadcastTargets } = loadTs('src/shared/broadcast.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// ── has-work predicate ────────────────────────────────────────────────────────

test('a todo or doing card assigned to the agent wakes it', () => {
  for (const status of ['todo', 'doing']) {
    const why = dormantWakeReason('pam', [{ id: 't1', assignee: 'pam', status }], []);
    assert.deepEqual(why, { taskIds: ['t1'], messageIds: [] }, status);
  }
});

test('a blocked card never wakes the agent, with or without humanQA', () => {
  assert.equal(dormantWakeReason('pam', [{ id: 't1', assignee: 'pam', status: 'blocked' }], []), null);
  const asked = { id: 't2', assignee: 'pam', status: 'blocked', humanQA: [{ q: 'which art?', askedAt: '2026-10-01T00:00:00Z' }] };
  assert.equal(dormantWakeReason('pam', [asked], []), null);
  const answered = { ...asked, humanQA: [{ ...asked.humanQA[0], a: 'the blue one' }] };
  assert.equal(dormantWakeReason('pam', [answered], []), null, 'an answered ask still goes to the Boss, not the worker');
});

test('a done card never wakes the agent', () => {
  assert.equal(dormantWakeReason('pam', [{ id: 't1', assignee: 'pam', status: 'done' }], []), null);
});

test("another agent's card does not wake this one", () => {
  assert.equal(dormantWakeReason('pam', [{ id: 't1', assignee: 'jim', status: 'todo' }], []), null);
  assert.equal(dormantWakeReason('pam', [{ id: 't1', status: 'todo' }], []), null, 'unassigned');
});

test('direct mail wakes the agent; a broadcast alone does not', () => {
  assert.equal(dormantWakeReason('pam', [], [{ id: 'm1', to: 'broadcast' }]), null);
  assert.deepEqual(
    dormantWakeReason('pam', [], [{ id: 'm1', to: 'broadcast' }, { id: 'm2', to: 'pam' }]),
    { taskIds: [], messageIds: ['m2'] }
  );
});

test('tasksOf accepts the ledger object, a bare array, and junk', () => {
  assert.deepEqual(tasksOf({ tasks: [{ id: 'a' }, null] }), [{ id: 'a' }]);
  assert.deepEqual(tasksOf([{ id: 'b' }]), [{ id: 'b' }]);
  assert.deepEqual(tasksOf(undefined), []);
  assert.deepEqual(tasksOf({ tasks: 'nope' }), []);
});

// ── which registry agents go dormant ──────────────────────────────────────────

const none = new Set();

test('at boot every roster worker goes dormant and stale entries archive', () => {
  const agents = {
    god: { isGod: true },
    pam: {},                          // live last session, still archived:false
    jim: { archived: true },          // restorable from an older boot
    dwight: { isAssistant: true },    // prep assistant on the roster
    ghost: {},                        // not on the roster at all
    old: { archived: true }           // already archived, not on the roster
  };
  const plan = planDormancy(agents, {
    godId: 'god', liveIds: none, boot: true,
    rosterIds: new Set(['god', 'pam', 'jim', 'dwight']), restorableIds: new Set(['jim'])
  });
  assert.deepEqual(plan.dormant.sort(), ['jim', 'pam']);
  assert.deepEqual(plan.archived.sort(), ['dwight', 'ghost']);
});

test('after boot only settled states move, and live or mid-spawn agents are left alone', () => {
  const agents = {
    reopened: { archived: true },     // put back on the restorable list
    dismissed: { dormant: true },     // removed from the roster
    spawning: {},                     // registered, PTY not mapped yet
    live: { dormant: true }           // woken: has a PTY
  };
  const plan = planDormancy(agents, {
    godId: 'god', liveIds: new Set(['live']), boot: false,
    rosterIds: new Set(['reopened', 'spawning']), restorableIds: new Set(['reopened', 'spawning'])
  });
  assert.deepEqual(plan, { dormant: ['reopened'], archived: ['dismissed'] });
});

test('rosterIdsOf reads ids out of opaque roster entries', () => {
  assert.deepEqual(rosterIdsOf([{ id: 'a' }, { name: 'x' }, null, { id: '' }, { id: 'b' }]), ['a', 'b']);
  assert.deepEqual(rosterIdsOf(undefined), []);
});

test('a broadcast skips a dormant agent unless the message opts in', () => {
  const roster = { god: {}, jim: {}, pam: { dormant: true } };
  assert.deepEqual(selectBroadcastTargets(roster, 'god'), ['jim']);
  assert.deepEqual(selectBroadcastTargets(roster, 'god', null, true), ['jim', 'pam']);
});

test('with a live set, only agents holding a PTY get a broadcast', () => {
  // ghost: not archived and not dormant, but no PTY (left behind by a hard quit).
  const roster = { god: {}, jim: {}, ghost: {}, pam: { dormant: true } };
  const live = new Set(['god', 'jim']);
  assert.deepEqual(selectBroadcastTargets(roster, 'god', live), ['jim']);
  assert.deepEqual(selectBroadcastTargets(roster, 'god', live, true), ['jim', 'pam']);
  assert.deepEqual(selectBroadcastTargets({ god: {}, pam: { dormant: true } }, 'god', new Set(['god', 'pam'])), ['pam'],
    'a live PTY wins over a stale dormant flag');
});

// ── on disk: mail, fleet roster line, and respawn ─────────────────────────────

test('a dormant agent gets direct mail on disk, no broadcast unless opted in, and wakes clean', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dormant-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Maple', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home });

  hive.setDormancy({ dormant: ['pam'], archived: [] });
  assert.equal(hive.registry().agents.pam.dormant, true);
  assert.equal(hive.registry().agents.pam.archived, false);

  hive.setLiveAgentSource(() => ['god']);
  hive.send({ to: 'broadcast', subject: 'CLOSING TIME', body: 'wrap up' }, 'god');
  assert.equal(hive.inbox('pam').length, 0, 'a plain broadcast never touches a dormant inbox');
  hive.send({ to: 'broadcast', subject: 'new rule', body: 'read this', includeDormant: true }, 'god');
  assert.equal(hive.inbox('pam').length, 1, 'includeDormant lands it in the dormant inbox');
  assert.equal(hive.inbox('pam')[0].includeDormant, true);
  assert.equal(dormantWakeReason('pam', [], hive.inbox('pam')), null, 'but does not wake it');

  hive.send({ to: 'pam', subject: 'please do X', body: 'details' }, 'god');
  assert.equal(dormantWakeReason('pam', [], hive.inbox('pam')).messageIds.length, 1, 'direct mail wakes it');

  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [
      { id: 'god', name: 'Maple', isGod: true, lastActiveSecAgo: 3 },
      { id: 'pam', name: 'Pam', role: 'artist', dormant: true, inboxBacklog: 2 }
    ]
  });
  const line = hive.rosterContext();
  assert.match(line, /pam "Pam" \(artist, DORMANT, inbox 2\)/);
  assert.match(line, /not stalled/);
  assert.match(line, /wake-requests/);

  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home });
  assert.equal(hive.registry().agents.pam.dormant, false, 'a spawn clears dormant');

  hive.setDormancy({ dormant: ['pam'], archived: [] });
  hive.setArchived('pam', true);
  assert.equal(hive.registry().agents.pam.dormant, false, 'archiving clears dormant');
  assert.equal(hive.registry().agents.pam.archived, true);
});

// ── start prompt ──────────────────────────────────────────────────────────────

const base = {
  isGod: false, memoryPath: '/h/a/memory.md', archivePath: '/h/a/memory-archive.md', memoryChars: 100,
  myTasksPath: '/h/a/my-tasks.md', tasksPath: '/h/tasks.json', inboxDir: '/h/a/inbox', tasks: [], messages: []
};

test('a woken worker is handed its cards and mail by id, not told to read everything', () => {
  const text = startPromptText({ ...base,
    tasks: [{ id: 'alpha-1', title: 'Fix lights', status: 'todo' }],
    messages: [{ id: 'm-1', from: 'god', subject: 'GO' }] });
  assert.match(text, /Task `alpha-1` \(todo\): Fix lights/);
  assert.match(text, /Message `m-1\.json` in \/h\/a\/inbox from god: GO/);
  assert.match(text, /not the rest of your inbox/);
  assert.doesNotMatch(text, /EVERY file|PROTOCOL\.md|archive/i);
});

test('with nothing assigned the worker waits instead of exploring', () => {
  assert.match(startPromptText(base), /Nothing is assigned to you yet\. Reply "ready"/);
});

test('memory.md over the cap makes archiving the first step, append-only', () => {
  const text = startPromptText({ ...base, memoryChars: MEMORY_DIGEST_CAP + 1, bossReason: 'check the build' });
  const lines = text.split('\n');
  assert.match(lines[1], /^1\. Your memory\.md is \d+ chars, over the 8000-char cap/);
  assert.match(lines[1], /APPEND the moved text there verbatim \(never delete it/);
  assert.match(text, /The Boss woke you: check the build/);
  assert.doesNotMatch(startPromptText(base), /over the/);
});

test('the boss boot reads memory and pending mail only', () => {
  const text = startPromptText({ ...base, isGod: true, messages: [{ id: 'm-2', subject: 'hi' }] });
  assert.match(text, /^START \(boss boot\)/);
  assert.match(text, /Do not read board\.md, tasks\.json, fleet\.json, registry\.json, COMMANDS\.md or PROTOCOL-BOSS\.md now/);
  assert.match(text, /m-2\.json/);
});

test('a Codex spawn carries its work on argv; a Claude spawn returns it as the kickoff', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-start-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const root = path.join(home, 'hive');
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'c1', title: 'Codex card', status: 'doing', assignee: 'cx' },
    { id: 'c2', title: 'Old card', status: 'done', assignee: 'cx' },
    { id: 'k1', title: 'Claude card', status: 'todo', assignee: 'kl', description: 'Do the thing', brief: 'Prior work on branch b1' }
  ] }));
  const cx = await hive.ensureAgent({ id: 'cx', name: 'Cx', provider: 'codex', cwd: home });
  const argv = cx.args[cx.args.length - 1];
  assert.match(argv, /HIVE PROTOCOL/);
  assert.match(argv, /Task `c1` \(doing\): Codex card/);
  assert.equal(cx.kickoff, undefined);
  assert.equal(cx.startDelivered, true);
  const view = fs.readFileSync(path.join(root, 'agents', 'cx', 'my-tasks.md'), 'utf8');
  assert.match(view, /`c1` doing: Codex card/);
  assert.match(view, /1 done card\(s\) not listed/);
  assert.doesNotMatch(view, /k1|c2/);

  const kl = await hive.ensureAgent({ id: 'kl', name: 'Kl', provider: 'claude', cwd: home });
  assert.match(kl.kickoff, /Task `k1` \(todo\): Claude card/);
  assert.match(kl.kickoff, /Card `k1` description:\nDo the thing/);
  assert.match(kl.kickoff, /Card `k1` handoff brief:\nPrior work on branch b1/);
  const sys = kl.args[kl.args.indexOf('--append-system-prompt') + 1];
  assert.doesNotMatch(sys, /k1/, 'the system prompt stays volatile-free');

  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [] }));
  const idle = await hive.ensureAgent({ id: 'kl', name: 'Kl', provider: 'claude', cwd: home });
  assert.equal(idle.kickoff, undefined, 'nothing to do: a Claude agent is not typed to');
});

test('the Boss wake reason reaches only the next spawn of that agent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reason-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  hive.noteWakeReason('w1', 'rerun the capture');
  const first = await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'codex', cwd: home });
  assert.match(first.args[first.args.length - 1], /The Boss woke you: rerun the capture/);
  const second = await hive.ensureAgent({ id: 'w1', name: 'W', provider: 'codex', cwd: home });
  assert.doesNotMatch(second.args[second.args.length - 1], /rerun the capture/);
});

test('a worker is not sent to PROTOCOL.md or told to read its whole inbox; the boss gets PROTOCOL-BOSS.md', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-proto-'));
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  const w = await hive.ensureAgent({ id: 'w2', name: 'W', provider: 'claude', cwd: home });
  const sys = w.args[w.args.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /PROTOCOL\.md restates the rules below at length; you do not need to read it/);
  assert.doesNotMatch(sys, /EVERY file|PROTOCOL-BOSS/);
  assert.match(sys, /never reply to inform or done/);
  assert.match(sys, /Never read the whole .*tasks\.json/);
  const root = path.join(home, 'hive');
  const proto = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
  assert.doesNotMatch(proto, /## (Fleet monitoring|Spawning a worker|Dormant agents)/);
  assert.match(fs.readFileSync(path.join(root, 'PROTOCOL-BOSS.md'), 'utf8'), /## Spawning a worker/);
});

// ── editing a dormant agent ───────────────────────────────────────────────────

const { patchAgentById } = loadTs('src/renderer/src/store/agentPatch.ts');
const VOLATILE = new Set(['status', 'action', 'progress']);

test('editing a dormant agent rewrites its restorable entry and leaves it dormant', () => {
  const live = [{ id: 'jim', name: 'Jim' }];
  const restorable = [{ id: 'pam', name: 'Pam', provider: 'claude', model: 'opus', command: 'claude --model opus', cwd: '/a', worktreePath: '/a-wt' }];
  const edit = { name: 'Pamela', provider: 'codex', model: 'gpt-5', command: 'codex -m gpt-5', tier: 'light', cwd: '/b', worktreePath: undefined, note: 'art pass' };
  const next = patchAgentById(live, restorable, 'pam', edit, VOLATILE);
  assert.equal(next.agents, live, 'the live roster is untouched, so the agent was not moved there');
  assert.equal(next.agents.some((a) => a.id === 'pam'), false);
  assert.equal(next.restorable.length, 1);
  const pam = next.restorable[0];
  assert.equal(pam.command, 'codex -m gpt-5', 'the next fresh start spawns the edited recipe');
  assert.equal(pam.tier, 'light');
  assert.equal(pam.cwd, '/b');
  assert.equal(pam.worktreePath, undefined, 'a cwd move drops the old worktree');
  assert.equal(pam.note, 'art pass');
});

test('run-state for a dormant agent is dropped, and a live agent still takes the whole patch', () => {
  const restorable = [{ id: 'pam', name: 'Pam' }];
  const late = patchAgentById([], restorable, 'pam', { status: 'working', action: 'typing' }, VOLATILE);
  assert.equal(late.restorable, restorable, 'a late pty chunk does not rewrite the spawn recipe');
  const live = [{ id: 'jim', name: 'Jim' }];
  const both = patchAgentById(live, restorable, 'jim', { status: 'working', name: 'James' }, VOLATILE);
  assert.deepEqual(both.agents, [{ id: 'jim', name: 'James', status: 'working' }]);
  assert.equal(both.restorable, restorable);
  const nobody = patchAgentById(live, restorable, 'ghost', { name: 'x' }, VOLATILE);
  assert.equal(nobody.agents, live);
  assert.equal(nobody.restorable, restorable);
});

test('a worker\'s start names the card to start with, and says to continue one already "doing"', () => {
  const todo = startPromptText({ ...base, tasks: [{ id: 'alpha-2', title: 'Next', status: 'todo' }, { id: 'alpha-3', title: 'Later', status: 'todo' }] });
  assert.match(todo, /Start with `alpha-2`, the first card above; work one card at a time\./);
  const doing = startPromptText({ ...base, tasks: [{ id: 'alpha-1', title: 'Half done', status: 'doing' }] });
  assert.match(doing, /Start with `alpha-1`, the first card above \(it is already "doing": continue it\)/);
  assert.doesNotMatch(startPromptText({ ...base, messages: [{ id: 'm-1', subject: 'hi' }] }), /Start with/);
});

test('a worker\'s start includes the card description and brief for its starting card', () => {
  const text = startPromptText({
    ...base,
    tasks: [{
      id: 'task-1',
      title: 'First task',
      status: 'todo',
      description: 'Implement hidden brief on cards',
      brief: 'Previous attempt explored taskPatch.ts'
    }]
  });
  assert.match(text, /Card `task-1` description:\nImplement hidden brief on cards/);
  assert.match(text, /Card `task-1` handoff brief:\nPrevious attempt explored taskPatch\.ts/);
});
