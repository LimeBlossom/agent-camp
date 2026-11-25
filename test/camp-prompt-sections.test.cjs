'use strict';

/**
 * Camp: prompt sections overridable one at a time; how-to text moves into PROTOCOL files.
 *
 * Contract:
 * 1. <hive>/prompts/sections/<key>.md overrides one named section
 *    (vaultLine, spawnQueueLine, godLine, guardrailsLine, ledgerLine, etc.)
 *    and supports placeholders ({{name}}, {{id}}, {{dir}}, {{root}}, {{tools}}).
 * 2. Overriding one section replaces only its own section; conditional sections
 *    (vault inbox, spawn queue, unity, tools) and untouched sections survive with
 *    their bundled text.
 * 3. Gating remains strictly in code:
 *    - vaultLine is only emitted if vault-inbox/ exists in hive root.
 *    - spawnQueueLine is only emitted if agent is God and orchestratorMaySpawn is true.
 *    - godLine is only emitted if agent is God.
 * 4. Missing overrides fall back cleanly to bundled text.
 * 5. Long how-to text (vault file naming convention, worker spawn JSON schema & engine list)
 *    moves into PROTOCOL.md and PROTOCOL-BOSS.md; the bundled prompt lines become concise
 *    one-line pointers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function createTempHive(t, prefix = 'md-prompt-sections-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmTree(dir));
  const hiveRoot = path.join(dir, 'hive');
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  return { dir, hiveRoot, hive };
}

function promptForAgent(hive, meta, opts = {}) {
  const root = hive.root();
  const dir = path.join(root, 'agents', meta.id);
  return hive.injectedPrompt(
    meta,
    dir,
    root,
    opts.semanticMemory ?? false,
    opts.knowledgeGraph ?? false,
    opts.kgCliPath,
    opts.toolsLine ?? ''
  );
}

// ─── Test 1: loadPromptSection method exists and reads section with placeholders ──

test('loadPromptSection loads and interpolates section template when present', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'guardrailsLine.md'),
    'Guardrails: custom safety circuit for {{name}} (id: {{id}}) in {{dir}} at {{root}}.',
    'utf8'
  );

  assert.equal(typeof hive.loadPromptSection, 'function', 'hive.loadPromptSection must be defined');

  const loaded = hive.loadPromptSection('guardrailsLine', {
    name: 'Maple',
    id: 'pika-1',
    dir: '/hive/agents/pika-1',
    root: hiveRoot
  });

  assert.equal(
    loaded,
    `Guardrails: custom safety circuit for Maple (id: pika-1) in /hive/agents/pika-1 at ${hiveRoot}.`
  );
});

// ─── Test 2: loadPromptSection returns null when file is absent ───────────────

test('loadPromptSection returns null when section file is missing', (t) => {
  const { hive } = createTempHive(t);
  assert.equal(typeof hive.loadPromptSection, 'function', 'hive.loadPromptSection must be defined');
  assert.equal(hive.loadPromptSection('nonExistentSection'), null);
  assert.equal(hive.loadPromptSection('guardrailsLine'), null);
});

// ─── Test 3: Section override replaces ONLY its own section ───────────────────

test('section override replaces only its own section and preserves all other bundled sections', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'guardrailsLine.md'),
    'Guardrails: custom strict safety circuit breaker for {{name}}.',
    'utf8'
  );

  const meta = { id: 'worker-1', name: 'Birch', provider: 'claude', cwd: hiveRoot, isGod: false };
  const prompt = promptForAgent(hive, meta);

  // Custom guardrails text is present
  assert.match(prompt, /Guardrails: custom strict safety circuit breaker for Birch\./);

  // Bundled default guardrails text is replaced
  assert.doesNotMatch(prompt, /Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer\/constrain"/);

  // All other baseline protocol sections remain intact
  assert.match(prompt, /HIVE PROTOCOL: follow it every task\./);
  assert.match(prompt, /1\. At the START of a task, read/);
  assert.match(prompt, /2\. .*memory\.md is a short CURRENT digest/);
  assert.match(prompt, /3\. To ask another agent for something/);
  assert.match(prompt, /4\. At the END of a task, update memory\.md/);
  assert.match(prompt, /5\. Never read the whole .*tasks\.json/);
  assert.match(prompt, /LIVE CONTEXT: each agent row in the LIVE ROSTER/);
  assert.match(prompt, /Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR\./);
});

// ─── Test 4: Conditional sections survive when a section is overridden ────────

test('conditional sections (vault, spawnQueue, tools) survive when an unrelated section is overridden', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  // Override guardrails section
  fs.writeFileSync(
    path.join(sectionsDir, 'guardrailsLine.md'),
    'Guardrails: override for {{name}}.',
    'utf8'
  );

  // Enable conditions
  fs.mkdirSync(path.join(hiveRoot, 'vault-inbox'), { recursive: true });
  hive.setOrchestratorMaySpawn(true);

  const bossMeta = { id: 'god-1', name: 'Michael', provider: 'claude', cwd: hiveRoot, isGod: true };
  const prompt = promptForAgent(hive, bossMeta, { toolsLine: 'TOOLS YOU HAVE: custom-tool-mcp' });

  // Custom override is present
  assert.match(prompt, /Guardrails: override for Michael\./);

  // Unlike whole-prompt override (prompts/boss.md), conditional sections survive:
  assert.match(prompt, /VAULT INBOX:/, 'vaultLine must survive override of unrelated section');
  assert.match(prompt, /SPAWNING A WORKER:/, 'spawnQueueLine must survive override of unrelated section');
  assert.match(prompt, /TOOLS YOU HAVE: custom-tool-mcp/, 'toolsLine must survive override of unrelated section');
});

// ─── Test 5: Gating stays in code: vaultLine requires vault-inbox folder ───────

test('vaultLine section override is gated on presence of vault-inbox directory in hive root', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'vaultLine.md'),
    'VAULT INBOX: custom vault filing instructions for {{name}} at {{root}}.',
    'utf8'
  );

  const meta = { id: 'worker-1', name: 'Cedar', provider: 'claude', cwd: hiveRoot, isGod: false };

  // Condition FALSE: vault-inbox does NOT exist
  const promptWithoutVault = promptForAgent(hive, meta);
  assert.doesNotMatch(
    promptWithoutVault,
    /VAULT INBOX:/,
    'vaultLine override must NOT be emitted when vault-inbox directory does not exist'
  );

  // Condition TRUE: create vault-inbox
  fs.mkdirSync(path.join(hiveRoot, 'vault-inbox'), { recursive: true });
  const promptWithVault = promptForAgent(hive, meta);
  assert.match(
    promptWithVault,
    /VAULT INBOX: custom vault filing instructions for Cedar at /,
    'vaultLine override must be emitted when vault-inbox directory exists'
  );
});

// ─── Test 6: Gating stays in code: spawnQueueLine requires isGod and orchestratorMaySpawn

test('spawnQueueLine section override is gated on isGod and orchestratorMaySpawn', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'spawnQueueLine.md'),
    'SPAWNING A WORKER: custom ephemeral worker spawn queue for {{name}}.',
    'utf8'
  );

  const workerMeta = { id: 'worker-1', name: 'Alder', provider: 'claude', cwd: hiveRoot, isGod: false };
  const bossMeta = { id: 'god-1', name: 'Michael', provider: 'claude', cwd: hiveRoot, isGod: true };

  // 1. Worker agent with toggle ON: should NOT get spawnQueueLine
  hive.setOrchestratorMaySpawn(true);
  const workerPrompt = promptForAgent(hive, workerMeta);
  assert.doesNotMatch(workerPrompt, /SPAWNING A WORKER:/, 'worker must never receive spawnQueueLine');

  // 2. Boss agent with toggle OFF: should NOT get spawnQueueLine
  hive.setOrchestratorMaySpawn(false);
  const bossPromptOff = promptForAgent(hive, bossMeta);
  assert.doesNotMatch(bossPromptOff, /SPAWNING A WORKER:/, 'boss with spawn toggle off must not receive spawnQueueLine');

  // 3. Boss agent with toggle ON: gets custom spawnQueueLine
  hive.setOrchestratorMaySpawn(true);
  const bossPromptOn = promptForAgent(hive, bossMeta);
  assert.match(
    bossPromptOn,
    /SPAWNING A WORKER: custom ephemeral worker spawn queue for Michael\./,
    'boss with spawn toggle on must receive custom spawnQueueLine override'
  );
});

// ─── Test 7: Gating stays in code: godLine requires isGod ─────────────────────

test('godLine section override is gated on isGod', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'godLine.md'),
    'ORCHESTRATOR DIRECTIVE: You are {{name}} ({{id}}), commander of {{root}}.',
    'utf8'
  );

  const workerMeta = { id: 'worker-1', name: 'Ash', provider: 'claude', cwd: hiveRoot, isGod: false };
  const bossMeta = { id: 'god-1', name: 'Michael', provider: 'claude', cwd: hiveRoot, isGod: true };

  const workerPrompt = promptForAgent(hive, workerMeta);
  assert.doesNotMatch(workerPrompt, /ORCHESTRATOR DIRECTIVE:/, 'worker must not receive godLine');

  const bossPrompt = promptForAgent(hive, bossMeta);
  assert.match(bossPrompt, /ORCHESTRATOR DIRECTIVE: You are Michael \(god-1\), commander of /);
});

// ─── Test 8: Placeholders are fully substituted ───────────────────────────────

test('placeholders (name, id, dir, root, tools) are fully substituted in section overrides', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'guardrailsLine.md'),
    'Guardrails for {{name}} [id={{id}}] in dir={{dir}} under root={{root}} with tools={{tools}}. Repeat: {{name}} is safe.',
    'utf8'
  );

  const meta = { id: 'agent-42', name: 'Larch', provider: 'claude', cwd: hiveRoot, isGod: false };
  const toolsLine = 'TOOLS YOU HAVE: shadow-ball, curse';
  const prompt = promptForAgent(hive, meta, { toolsLine });

  const agentDir = path.join(hiveRoot, 'agents', 'agent-42');
  const expectedLine = `Guardrails for Larch [id=agent-42] in dir=${agentDir} under root=${hiveRoot} with tools=${toolsLine}. Repeat: Larch is safe.`;

  assert.ok(prompt.includes(expectedLine), `expected prompt to contain substituted line: ${expectedLine}`);
  assert.doesNotMatch(prompt, /\{\{(name|id|dir|root|tools)\}\}/, 'no placeholder syntax must remain');
});

// ─── Test 9: Multiple section overrides coexist independently ─────────────────

test('multiple section overrides can coexist independently', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const sectionsDir = path.join(hiveRoot, 'prompts', 'sections');
  fs.mkdirSync(sectionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sectionsDir, 'guardrailsLine.md'),
    'CUSTOM GUARDRAILS: Safe boundaries for {{name}}.',
    'utf8'
  );
  fs.writeFileSync(
    path.join(sectionsDir, 'ledgerLine.md'),
    'CUSTOM LEDGER: Kanban instructions for {{name}} in {{root}}.',
    'utf8'
  );

  const meta = { id: 'worker-2', name: 'Oak', provider: 'claude', cwd: hiveRoot, isGod: false };
  const prompt = promptForAgent(hive, meta);

  assert.match(prompt, /CUSTOM GUARDRAILS: Safe boundaries for Oak\./);
  assert.match(prompt, /CUSTOM LEDGER: Kanban instructions for Oak in /);

  // Other sections fall back to bundled text
  assert.match(prompt, /HIVE PROTOCOL: follow it every task\./);
  assert.match(prompt, /1\. At the START of a task/);
  assert.match(prompt, /LIVE CONTEXT: each agent row in the LIVE ROSTER/);
});

// ─── Test 10: Part 2: Long how-to text moves into PROTOCOL files with concise prompt pointers

test('bundled vaultLine and spawnQueueLine are concise pointers, with detailed how-to text in PROTOCOL files', (t) => {
  const { hiveRoot, hive } = createTempHive(t);

  // Create vault-inbox so vaultLine is generated
  fs.mkdirSync(path.join(hiveRoot, 'vault-inbox'), { recursive: true });
  hive.setOrchestratorMaySpawn(true);

  const bossMeta = { id: 'god-1', name: 'Michael', provider: 'claude', cwd: hiveRoot, isGod: true };
  const prompt = promptForAgent(hive, bossMeta);

  // Extract lines from prompt
  const lines = prompt.split('\n');
  const vaultPromptLine = lines.find((l) => l.startsWith('VAULT INBOX:'));
  assert.ok(vaultPromptLine, 'prompt must contain VAULT INBOX line');

  const spawnPromptLine = lines.find((l) => l.startsWith('SPAWNING A WORKER:'));
  assert.ok(spawnPromptLine, 'prompt must contain SPAWNING A WORKER line');

  // Bundled vaultLine in prompt should be a concise one-line pointer referencing PROTOCOL.md
  assert.ok(
    vaultPromptLine.length <= 160,
    `bundled vaultLine should be a concise pointer (<= 160 chars), got ${vaultPromptLine.length}: "${vaultPromptLine}"`
  );
  assert.match(vaultPromptLine, /PROTOCOL\.md/, 'vaultLine in prompt must point to PROTOCOL.md');
  assert.doesNotMatch(
    vaultPromptLine,
    /<UTC yyyymmddThhmmssZ>/,
    'vaultLine in prompt must not contain verbose file naming format'
  );
  assert.doesNotMatch(
    vaultPromptLine,
    /vault keeper sorts new from known/,
    'vaultLine in prompt must not contain detailed keeper sorting rules'
  );

  // Bundled spawnQueueLine in prompt should be a concise one-line pointer referencing PROTOCOL-BOSS.md
  assert.ok(
    spawnPromptLine.length <= 180,
    `bundled spawnQueueLine should be a concise pointer (<= 180 chars), got ${spawnPromptLine.length}: "${spawnPromptLine}"`
  );
  assert.match(spawnPromptLine, /PROTOCOL-BOSS\.md/, 'spawnQueueLine in prompt must point to PROTOCOL-BOSS.md');
  assert.doesNotMatch(
    spawnPromptLine,
    /Required: `objective`/,
    'spawnQueueLine in prompt must not dump inline JSON parameter schema'
  );
  assert.doesNotMatch(
    spawnPromptLine,
    /cheapest first, from "agy"/,
    'spawnQueueLine in prompt must not contain verbose engine descriptions'
  );

  // PROTOCOL.md must contain the full vault inbox instructions and naming format
  const protocolMd = fs.readFileSync(path.join(hiveRoot, 'PROTOCOL.md'), 'utf8');
  assert.match(protocolMd, /## Vault inbox/i, 'PROTOCOL.md must have Vault inbox section');
  assert.match(
    protocolMd,
    /<UTC yyyymmddThhmmssZ>-<your-id>-<slug>\.md/,
    'PROTOCOL.md must contain the vault entry file naming schema'
  );
  assert.match(
    protocolMd,
    /README\.md/,
    'PROTOCOL.md must reference vault-inbox/README.md shape'
  );

  // PROTOCOL-BOSS.md must contain the full worker spawn schema and engine list
  const protocolBossMd = fs.readFileSync(path.join(hiveRoot, 'PROTOCOL-BOSS.md'), 'utf8');
  assert.match(protocolBossMd, /## Spawning a worker/i, 'PROTOCOL-BOSS.md must have Spawning a worker section');
  assert.match(protocolBossMd, /"objective"/, 'PROTOCOL-BOSS.md must document objective parameter');
  assert.match(protocolBossMd, /"engines"/, 'PROTOCOL-BOSS.md must document engines parameter');
  assert.match(protocolBossMd, /claude.*codex.*agy/, 'PROTOCOL-BOSS.md must document available engines list');
  assert.match(protocolBossMd, /"difficulty"/, 'PROTOCOL-BOSS.md must document difficulty parameter');
});
