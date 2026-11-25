'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');
const { advanceHoldClock, idleOutsideHold } = loadTs('src/shared/limitHold.ts');
const MIN = 60_000;

// Run the shipped controller without starting Electron or touching real workers.
const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const tickNode = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ephemeralWorkerTick');
assert.ok(tickNode, 'production ephemeralWorkerTick must exist');
const tickJs = ts.transpileModule(tickNode.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function harness({ held = true, alias = false, wait = { provider: 'claude' }, done = false, tokenCap = 0, tokens = 0 } = {}) {
  let now = 3 * 60 * MIN;
  let idle = now;
  const id = 'worker-quota';
  const agent = alias ? 'registered-quota-agent' : id;
  const rec = { spawnedAt: 0, tokenCap };
  const killed = [], tornDown = [], notices = [], errors = [];
  const waits = new Map(held ? [[agent, wait]] : []);
  const context = vm.createContext({
    workerTickRunning: false,
    readConfig: () => ({ workerIdleTimeoutMinutes: 20, orchestratorMaySpawn: false }),
    liveWorkers: new Map([[id, rec]]),
    workerSignaledDone: () => done,
    workerTokensUsed: () => tokens,
    ptyManager: { idleFor: () => idle, kill: worker => killed.push(worker) },
    teardownPty: worker => tornDown.push(worker),
    ptyToAgent: new Map(alias ? [[id, agent]] : []),
    limitWaits: waits,
    advanceHoldClock, idleOutsideHold,
    Date: { now: () => now },
    informGod: (...args) => notices.push(args),
    hive: { root: () => '/unused-test-root' },
    renderMessageTemplate: () => 'worker lifecycle notice',
    BUNDLED_MESSAGE_TEMPLATES: {},
    preservedWorktrees: new Map(),
    console: { log() {}, warn() {}, error: (...args) => errors.push(args) }
  });
  vm.runInContext(tickJs, context);
  return {
    rec, killed, tornDown, notices, waits,
    async tick(at = now, quiet = idle) {
      now = at; idle = quiet;
      await context.ephemeralWorkerTick();
      assert.deepEqual(errors, [], 'controller must complete without swallowed errors');
    },
    assertAlive() {
      assert.deepEqual(killed, [], 'quota-held worker must not be killed for idle');
      assert.deepEqual(tornDown, []);
      assert.deepEqual(notices, []);
      assert.equal(rec.releasing, undefined);
      assert.equal(rec.outcome, undefined);
    }
  };
}

test('first observed tick preserves a Claude quota-held worker already quiet for three hours', async () => {
  const h = harness();
  await h.tick();
  h.assertAlive();
});

test('registered agent ID holds protect a worker whose PTY ID differs', async () => {
  const h = harness({ alias: true });
  await h.tick();
  h.assertAlive();
});

test('a past reset estimate does not make an existing quota hold reapable', async () => {
  const h = harness({ wait: { provider: 'claude', resetAtMs: MIN } });
  await h.tick();
  h.assertAlive();
});

test('entering hold after an earlier tick protects idle time that crossed the threshold', async () => {
  const h = harness({ held: false });
  await h.tick(19 * MIN, 19 * MIN);
  h.waits.set('worker-quota', { provider: 'claude' });
  await h.tick(21 * MIN, 21 * MIN);
  h.assertAlive();
});

test('a hold observed before the idle deadline survives three hours', async () => {
  const h = harness();
  await h.tick(MIN, MIN);
  await h.tick(181 * MIN, 181 * MIN);
  h.assertAlive();
});

test('after hold release, fresh output gets the normal idle allowance', async () => {
  const h = harness();
  await h.tick(MIN, MIN);
  await h.tick(181 * MIN, 181 * MIN);
  h.waits.clear();
  await h.tick(182 * MIN, 0);
  await h.tick(201 * MIN, 19 * MIN);
  h.assertAlive();
  await h.tick(203 * MIN, 21 * MIN);
  assert.deepEqual(h.killed, ['worker-quota']);
  assert.deepEqual(h.tornDown, ['worker-quota']);
  assert.equal(h.rec.outcome, 'reaped-idle');
});

test('ordinary idle worker is still reaped', async () => {
  const h = harness({ held: false });
  await h.tick();
  assert.deepEqual(h.killed, ['worker-quota']);
  assert.deepEqual(h.tornDown, ['worker-quota']);
  assert.equal(h.rec.outcome, 'reaped-idle');
  assert.equal(h.notices.length, 1);
});

test('a different agent being held does not exempt an idle worker', async () => {
  const h = harness({ held: false });
  h.waits.set('other-worker', { provider: 'claude' });
  await h.tick();
  assert.deepEqual(h.killed, ['worker-quota']);
  assert.equal(h.rec.outcome, 'reaped-idle');
});

test('exactly twenty minutes without a hold is still within the allowance', async () => {
  const h = harness({ held: false });
  await h.tick(20 * MIN, 20 * MIN);
  h.assertAlive();
});

test('completion releases a held worker normally', async () => {
  const h = harness({ done: true });
  await h.tick();
  assert.deepEqual(h.killed, ['worker-quota']);
  assert.deepEqual(h.tornDown, ['worker-quota']);
  assert.equal(h.rec.outcome, 'done');
  assert.deepEqual(h.notices, []);
});

test('an explicit token cap still releases a held worker', async () => {
  const h = harness({ tokenCap: 100, tokens: 101 });
  await h.tick();
  assert.deepEqual(h.killed, ['worker-quota']);
  assert.deepEqual(h.tornDown, ['worker-quota']);
  assert.equal(h.rec.outcome, 'reaped-token-cap');
  assert.equal(h.notices.length, 1);
});
