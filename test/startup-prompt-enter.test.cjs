'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');
const { createPromptSubmitWatch, pressEnterUntilSubmitted } = loadTs('src/shared/promptSubmit.ts');
const { ptyPayload } = loadTs('src/renderer/src/hooks/queueDelivery.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const read = (name) => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const renderer = read('src/renderer/src/hooks/useHive.ts');
const main = read('src/main/index.ts');

// Evaluate the real sender bodies without booting Electron/React. Only their
// external services and delays are replaced; provider gates and call arguments
// stay intact, including runWorkerWakeBeat's choice of acknowledgement mode.
function functions(source, names, bindings) {
  const ast = ts.createSourceFile('sender.ts', source, ts.ScriptTarget.Latest, true);
  const bodies = names.map((name) => {
    const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `production function ${name} exists`);
    return node.getText(ast);
  }).join('\n');
  const compiled = ts.transpileModule(bodies, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn { ${names.join(',')} };`)(...Object.values(bindings));
}

function harness(provider, confirmAt, { stale = false, foreignAt = 0 } = {}) {
  const watch = createPromptSubmitWatch();
  const agentId = 'cedar-test';
  const ptyId = 'agent-test';
  const writes = [];
  const warnings = [];
  let presses = 0;
  if (stale) watch.notify(agentId);
  const write = (_id, data) => {
    assert.equal(_id, ptyId);
    writes.push(data);
    if (data === '\r') {
      presses++;
      if (presses === foreignAt) watch.notify('another-agent');
      if (presses === confirmAt) watch.notify(agentId);
    }
    return { ok: true };
  };
  // Preserve the shipped retry implementation and arm-before-write ordering.
  // Zero-ms watch timeouts make the 88-second exhaustion path deterministic
  // and short while retaining real timeout cleanup and synchronous hooks.
  const retry = (press, arm) => pressEnterUntilSubmitted(press, () => {
    const wait = arm();
    return () => wait(0);
  }, 1, 4, 1);
  const bindings = {
    promptSubmits: watch,
    pressEnterUntilSubmitted: retry,
    SUBMIT_CONFIRM_MS: 1,
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
    console: { warn: (...args) => warnings.push(args), log: () => {} }
  };
  const sender = functions(renderer, ['submitToPty'], {
    ...bindings,
    writeChains: new Map(),
    waitForTerminalReady: async () => {},
    ptyPayload,
    window: { cth: { writePty: async (...args) => write(...args) } },
    useStore: { getState: () => ({ agents: [{ id: agentId, ptyId, provider }] }) }
  }).submitToPty;
  const wakeSender = functions(main, ['nudgeWorker'], {
    ...bindings, inboxNudgeText, ptyManager: { write }
  }).nudgeWorker;
  let wakeDelivery;
  const beat = functions(main, ['runWorkerWakeBeat'], {
    console: bindings.console,
    hive: {
      enabled: () => true,
      registry: () => ({ godId: 'god', agents: { [agentId]: { provider } } }),
      inbox: () => [{ id: 'unread-1' }]
    },
    limitHeld: () => false,
    ptyForAgent: () => ptyId,
    control: { snapshot: () => ({}) },
    ptyManager: { lastOutputAt: () => 1 },
    closingTime: { wakeMode: () => 'normal' },
    workerWake: { decide: () => [agentId] },
    wakeModeFor: () => 'normal',
    nudgeWorker: (...args) => { wakeDelivery = wakeSender(...args); return wakeDelivery; }
  }).runWorkerWakeBeat;
  return {
    writes, warnings,
    presses: () => presses,
    renderer: () => sender(ptyId, 'START: read your card\nand pending inbox', provider),
    watchdog: async () => { beat(); assert.ok(wakeDelivery, 'watchdog selected a live worker'); await wakeDelivery; }
  };
}

for (const route of ['renderer', 'watchdog']) {
  for (const provider of ['claude', 'codex', 'antigravity', 'gemini']) {
    test(`${route}/${provider}: retries swallowed Enter until fourth press confirms; text once`, async () => {
      const h = harness(provider, 4);
      await h[route]();
      assert.equal(h.presses(), 4, 'three swallowed Enters must not strand the prompt');
      assert.equal(h.writes.filter((s) => s !== '\r').length, 1, 'retry Enter, never retype the prompt');
      assert.equal(h.writes.at(-1), '\r');
      assert.equal(h.warnings.length, 0, 'confirmed submission is not reported as unconfirmed');
    });

    test(`${route}/${provider}: first confirmation stops further Enter and duplicate text`, async () => {
      const h = harness(provider, 1);
      await h[route]();
      assert.equal(h.presses(), 1);
      assert.equal(h.writes.filter((s) => s !== '\r').length, 1);
      assert.equal(h.warnings.length, 0);
    });

    test(`${route}/${provider}: absent acknowledgement exhausts five presses without retyping`, async () => {
      const h = harness(provider, Infinity);
      await h[route]();
      assert.equal(h.presses(), 5, 'unconfirmed text gets the existing bounded retry budget');
      assert.equal(h.writes.filter((s) => s !== '\r').length, 1);
      assert.equal(h.warnings.length, 1, 'exhausted submission must remain visible in diagnostics');
    });

    test(`${route}/${provider}: stale and foreign hooks cannot acknowledge this prompt`, async () => {
      const h = harness(provider, 3, { stale: true, foreignAt: 1 });
      await h[route]();
      assert.equal(h.presses(), 3, 'only a new hook from this agent ends retries');
      assert.equal(h.writes.filter((s) => s !== '\r').length, 1);
    });
  }
}

// These routes converge on the tested renderer sender. Keep argv-start distinct:
// it already starts a turn and must not acquire a second typed START prompt.
test('startup Boss orientation and worker seed use the serialized renderer sender', () => {
  assert.match(renderer, /if \(res\.seedPrompt\) await submitToPty\(GOD_PTY, res\.seedPrompt, godProvider\)/);
  assert.match(renderer, /if \(res\.kickoff\) await submitToPty\(GOD_PTY, res\.kickoff, godProvider\)/);
  assert.match(renderer, /else if \(!res\.startDelivered\) await submitToPty/);
  assert.match(renderer, /submitToPty\(\s*ptyId,\s*withStandingGoal\(live, seed\),\s*inferAgentProvider\(live\.command, live\.provider\)/);
});

test('restore and restart kickoff enter the queue, whose delivery uses submitToPty', () => {
  assert.match(read('src/renderer/src/hooks/useRestoreTeam.ts'), /if \(kickoff\) useStore\.getState\(\)\.enqueueMessage\(restoredAgent\.id, kickoff\)/);
  assert.match(read('src/renderer/src/components/CommandCenterPanel.tsx'), /if \(!resume && res\.kickoff\) useStore\.getState\(\)\.enqueueMessage\(a\.id, res\.kickoff\)/);
  assert.match(renderer, /deliverWithAcknowledgement\([\s\S]*?\(\) => submitToPty\(/);
});

test('both hook channels feed their watches without a Claude-only filter', () => {
  assert.match(renderer, /if \(e\.event === 'UserPromptSubmit'\) promptSubmits\.notify\(e\.agentId\)/);
  assert.match(main, /if \(event === 'UserPromptSubmit' && agentId\) promptSubmits\.notify\(agentId\)/);
});
