'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { hardestOpenDifficulty, engineOrderFor, difficultyEffort, ledgerEffort, isDifficulty } = loadTs('src/shared/difficulty.ts');
const { tierWalk } = loadTs('src/shared/modelTiers.ts');
const { capEffort } = loadTs('src/shared/effort.ts');
const { planTaskMessage } = loadTs('src/main/taskPatch.ts');
const { summarizeLedger } = loadTs('src/main/engineLedger.ts');

const card = (id, status, extra = {}) => ({ id, title: `T ${id}`, status, assignee: 'bulb', dependsOn: [], ...extra });

test('the hardest open card wins; done, blocked, unset and other agents\' cards do not count', () => {
  const tasks = [
    card('a', 'todo', { difficulty: 'easy' }),
    card('b', 'doing', { difficulty: 'normal' }),
    card('c', 'done', { difficulty: 'hard' }),
    card('d', 'blocked', { difficulty: 'hard' }),
    card('e', 'todo', { difficulty: 'hard', assignee: 'hazel' }),
    card('f', 'todo'),
    card('g', 'todo', { difficulty: 'bogus' })
  ];
  assert.equal(hardestOpenDifficulty(tasks, 'bulb'), 'normal');
  assert.equal(hardestOpenDifficulty([...tasks, card('h', 'todo', { difficulty: 'hard' })], 'bulb'), 'hard');
  assert.equal(hardestOpenDifficulty([card('f', 'todo')], 'bulb'), undefined, 'no field anywhere: picks as before');
});

test('spawn engines keep the request order; hard only sends weak engines to the back', () => {
  const engines = ['claude', 'codex', 'antigravity'];
  const isWeak = (e) => e === 'antigravity';
  assert.deepEqual(engineOrderFor(engines, 'hard', isWeak), ['claude', 'codex', 'antigravity']);
  assert.deepEqual(engineOrderFor(['antigravity', 'claude'], 'hard', isWeak), ['claude', 'antigravity']);
  assert.deepEqual(engineOrderFor(engines, 'easy'), engines);
  assert.deepEqual(engineOrderFor(engines, undefined), engines);
});

test('effort: easy is medium, hard is xhigh without lowering a higher own setting, normal keeps own', () => {
  assert.equal(difficultyEffort('easy', 'claude', undefined, 'high'), 'medium');
  assert.equal(difficultyEffort('hard', 'claude', undefined, 'high'), 'xhigh');
  assert.equal(difficultyEffort('hard', 'claude', undefined, 'max'), 'max');
  assert.equal(difficultyEffort('normal', 'claude', undefined, 'low'), 'low');
  assert.equal(difficultyEffort(undefined, 'codex', 'gpt-6.1-sol', 'low'), 'low');
  assert.equal(difficultyEffort('hard', 'codex', 'gpt-6.1-sol', undefined), 'medium');
  assert.equal(difficultyEffort('hard', 'antigravity', undefined, undefined), undefined, 'agy takes no effort');
});

test('codex never runs above medium: an agent-level high, xhigh or max clamps down', () => {
  for (const own of ['high', 'xhigh', 'max']) {
    for (const d of [undefined, 'normal', 'hard']) assert.equal(difficultyEffort(d, 'codex', 'gpt-6.1-sol', own), 'medium', `${d} ${own}`);
    assert.equal(capEffort('codex', own), 'medium');
    assert.equal(capEffort('claude', own), own, 'claude is not capped');
  }
  assert.equal(difficultyEffort('easy', 'codex', 'gpt-6.1-sol', 'xhigh'), 'medium');
  assert.equal(capEffort('codex', 'low'), 'low');
  assert.equal(capEffort('codex', undefined), undefined);
});

test('the Boss may set or clear difficulty; a worker may not; a bad value is refused', () => {
  const tasks = [card('a', 'todo')];
  const boss = (body) => planTaskMessage({ act: 'task-patch', body, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.equal(boss({ id: 'a', difficulty: 'hard' }).patch.difficulty, 'hard');
  const cleared = boss({ id: 'a', difficulty: null });
  assert.ok(cleared.ok && 'difficulty' in cleared.patch && cleared.patch.difficulty === undefined);
  assert.match(boss({ id: 'a', difficulty: 'brutal' }).reason, /difficulty must be one of easy, normal, hard/);
  const worker = planTaskMessage({ act: 'task-patch', body: { id: 'a', difficulty: 'easy' }, sender: 'bulb', isBoss: false, tasks, now: 'n' });
  assert.equal(worker.ok, false);
  const created = planTaskMessage({ act: 'task-create', body: { id: 'n', title: 'x', difficulty: 'easy' }, sender: 'god', isBoss: true, tasks, now: 'n' });
  assert.equal(created.card.difficulty, 'easy');
  assert.equal(isDifficulty('normal'), true);
});

test('ledger summary splits rows by difficulty', () => {
  const text = [
    { ts: 1, kind: 'start', workerId: 'w1', provider: 'codex', chosenBy: 'ladder', difficulty: 'hard' },
    { ts: 2, kind: 'start', workerId: 'w2', provider: 'codex', chosenBy: 'ladder' }
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(summarizeLedger(text).map((r) => r.engine).sort(), ['codex [ladder, hard]', 'codex [ladder]']);
});


test('fresh session difficulty follows the next card, including priority and doing order', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ts = require('typescript');
  const vm = require('node:vm');
  const { openCards } = loadTs('src/main/todoNudge.ts');
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const fn = source.match(/function cardDifficulty\(agentId: string\): Difficulty \| undefined \{[\s\S]*?\n\}/)[0];
  let ledger = [card('easy-first', 'todo', { priority: 'high', difficulty: 'easy' }), card('hard-later', 'todo', { priority: 'low', difficulty: 'hard' })];
  const ctx = { openCards, isDifficulty, tasksOf: x => x, hive: { tasks: () => ledger } };
  vm.createContext(ctx);
  vm.runInContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  assert.equal(ctx.cardDifficulty('bulb'), 'easy');
  assert.equal(difficultyEffort(ctx.cardDifficulty('bulb'), 'claude', undefined, 'high'), 'medium');
  assert.deepEqual(tierWalk('strong', ctx.cardDifficulty('bulb')), ['light', 'medium', 'strong']);
  ledger[1].status = 'doing';
  assert.equal(ctx.cardDifficulty('bulb'), 'hard');
  ledger[1].status = 'done';
  delete ledger[0].difficulty;
  assert.equal(ctx.cardDifficulty('bulb'), undefined, 'later cards cannot override an unset current card');
});

test('ledgerEffort records the capped level: hard is medium on Codex, xhigh on Claude, default when none', () => {
  assert.equal(ledgerEffort('hard', 'codex', undefined, undefined), 'medium');
  assert.equal(ledgerEffort('hard', 'claude', undefined, undefined), 'xhigh');
  assert.equal(ledgerEffort('hard', 'codex', undefined, 'max'), 'medium');
  assert.equal(ledgerEffort(undefined, 'claude', undefined, undefined), 'default');
  assert.equal(ledgerEffort('normal', 'claude', undefined, 'high'), 'high');
});
