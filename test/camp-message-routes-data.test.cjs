'use strict';

/**
 * Camp: harness message routes and notice text become data.
 *
 * Contract:
 * 1. Recipients are hard-coded in index.ts: informGod sends to god (9 callers),
 *    and so do the heartbeat (reengageGod), webhook intake, and wrap-up unpark.
 *    A routes map in config (workerLifecycle, webhook, heartbeat, wrapUp) is read
 *    per send and falls back to godId via resolveTo.
 * 2. Harness-authored message bodies:
 *    - drainForStop in hive.ts
 *    - worker reaped (token-cap & idle) and worktree reclaimed (GC) notices in index.ts
 *    - unityPromptText in unityBroker.ts
 *    - startPromptText in shared/dormantWake.ts
 *    become <hive>/prompts/messages/<key>.md templates with a bundled fallback.
 *    Edits to templates reach live agents on the next turn/send without restart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts tests
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-routes-userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userDataDir } }
};

test.after(() => rmTree(userDataDir));

const {
  DEFAULT_MESSAGE_ROUTES,
  getMessageRoute,
  resolveRecipient,
  resolveRouteRecipient
} = loadTs('src/main/messageRoutes.ts');

const {
  BUNDLED_MESSAGE_TEMPLATES,
  interpolateTemplate,
  loadMessageTemplate,
  renderMessageTemplate
} = loadTs('src/main/messageTemplates.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { unityPromptText } = loadTs('src/main/unityBroker.ts');
const { startPromptText } = loadTs('src/shared/dormantWake.ts');
const { readConfig, writeConfig } = loadTs('src/main/config.ts');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const activeIndexSource = indexSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

function createTempHive(t, prefix = 'md-routes-data-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmTree(dir));
  const hiveRoot = path.join(dir, 'hive');
  const hive = new HiveManager(() => dir);
  hive.ensureHive();
  return { dir, hiveRoot, hive };
}

function dropInboxMessage(hiveRoot, agentId, id, subject = 'Test Subject', body = 'Test Body') {
  const inboxDir = path.join(hiveRoot, 'agents', agentId, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${id}.json`),
    JSON.stringify({ id, from: 'boss', act: 'request', subject, body }),
    'utf8'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: Route Resolution Contract & Defaults
// ─────────────────────────────────────────────────────────────────────────────

test('DEFAULT_MESSAGE_ROUTES defines default recipient ("god") for all standard route keys', () => {
  assert.equal(DEFAULT_MESSAGE_ROUTES.workerLifecycle, 'god');
  assert.equal(DEFAULT_MESSAGE_ROUTES.webhook, 'god');
  assert.equal(DEFAULT_MESSAGE_ROUTES.heartbeat, 'god');
  assert.equal(DEFAULT_MESSAGE_ROUTES.wrapUp, 'god');
});

test('getMessageRoute falls back to "god" when routes config is absent or empty', () => {
  assert.equal(getMessageRoute('workerLifecycle', null), 'god');
  assert.equal(getMessageRoute('workerLifecycle', {}), 'god');
  assert.equal(getMessageRoute('workerLifecycle', { routes: {} }), 'god');
  assert.equal(getMessageRoute('webhook', { routes: {} }), 'god');
  assert.equal(getMessageRoute('heartbeat', { routes: {} }), 'god');
  assert.equal(getMessageRoute('wrapUp', { routes: {} }), 'god');
  assert.equal(getMessageRoute('unknownRoute', { routes: {} }), 'god');
});

test('getMessageRoute honours configured recipient for workerLifecycle, webhook, heartbeat, wrapUp', () => {
  const config = {
    routes: {
      workerLifecycle: 'coordinator-agent',
      webhook: 'triage-agent',
      heartbeat: 'floor-manager',
      wrapUp: 'closer-agent',
      customIntegration: 'custom-worker'
    }
  };
  assert.equal(getMessageRoute('workerLifecycle', config), 'coordinator-agent');
  assert.equal(getMessageRoute('webhook', config), 'triage-agent');
  assert.equal(getMessageRoute('heartbeat', config), 'floor-manager');
  assert.equal(getMessageRoute('wrapUp', config), 'closer-agent');
  assert.equal(getMessageRoute('customIntegration', config), 'custom-worker');
});

test('resolveRecipient and resolveRouteRecipient map aliases ("god", "boss", "human") to godId', () => {
  const godId = 'michael-01';
  assert.equal(resolveRecipient('god', godId), 'michael-01');
  assert.equal(resolveRecipient('boss', godId), 'michael-01');
  assert.equal(resolveRecipient('human', godId), 'michael-01');
  assert.equal(resolveRecipient('worker-quince', godId), 'worker-quince');

  const config = { routes: { workerLifecycle: 'boss', webhook: 'custom-worker' } };
  assert.equal(resolveRouteRecipient('workerLifecycle', config, godId), 'michael-01');
  assert.equal(resolveRouteRecipient('webhook', config, godId), 'custom-worker');
  assert.equal(resolveRouteRecipient('heartbeat', config, godId), 'michael-01'); // falls back to 'god' -> godId
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: Route Overrides in Engine Notice Handlers (index.ts)
// ─────────────────────────────────────────────────────────────────────────────

test('informGod routes workerLifecycle notices to config.routes.workerLifecycle override', () => {
  // informGod in index.ts must not hardcode `to: 'god'`. It must resolve recipient via routes.workerLifecycle.
  const informGodSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function informGod('),
    activeIndexSource.indexOf('function finalizeWorkerWorktree(')
  );
  assert.ok(
    !informGodSlice.includes("to: 'god'"),
    'informGod must not hardcode { to: "god" }; it must resolve recipient from config.routes.workerLifecycle'
  );
  assert.ok(
    /workerLifecycle/.test(informGodSlice),
    'informGod must query the workerLifecycle route from config or route resolver'
  );
});

test('informGod falls back to god when routes.workerLifecycle is omitted', () => {
  const informGodSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function informGod('),
    activeIndexSource.indexOf('function finalizeWorkerWorktree(')
  );
  assert.ok(
    /getMessageRoute|resolveRouteRecipient|routes\?\.workerLifecycle/.test(informGodSlice),
    'informGod must use route helper with fallback to god'
  );
});

test('reengageGod routes heartbeat notice to config.routes.heartbeat override', () => {
  const reengageSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function reengageGod('),
    activeIndexSource.indexOf('function breakerToast(')
  );
  assert.ok(
    !reengageSlice.includes("to: 'god'"),
    'reengageGod must not hardcode { to: "god" }; it must resolve recipient from config.routes.heartbeat'
  );
  assert.ok(
    /heartbeat/.test(reengageSlice),
    'reengageGod must query the heartbeat route from config or route resolver'
  );
});

test('reengageGod falls back to god when routes.heartbeat is omitted', () => {
  const reengageSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function reengageGod('),
    activeIndexSource.indexOf('function breakerToast(')
  );
  assert.ok(
    /getMessageRoute|resolveRouteRecipient|routes\?\.heartbeat/.test(reengageSlice),
    'reengageGod must use route helper with fallback to god'
  );
});

// The marker comments the first version anchored on are stripped from activeIndexSource, so
// indexOf returned -1 and the slice was garbage; anchor on the send call itself.
function webhookSendSlice() {
  const end = activeIndexSource.indexOf("}, 'webhook')");
  assert.ok(end > 0, "webhook hive.send call not found in index.ts");
  return activeIndexSource.slice(activeIndexSource.lastIndexOf('hive.send({', end), end);
}

test('webhook intake routes task request to config.routes.webhook override', () => {
  const webhookSlice = webhookSendSlice();
  assert.ok(
    !webhookSlice.includes("to: 'god'"),
    'webhook intake must not hardcode { to: "god" }; it must resolve recipient from config.routes.webhook'
  );
  assert.ok(
    /webhook/.test(webhookSlice),
    'webhook intake must query the webhook route from config or route resolver'
  );
});

test('webhook intake falls back to god when routes.webhook is omitted', () => {
  const webhookSlice = webhookSendSlice();
  assert.ok(
    /getMessageRoute|resolveRouteRecipient|routes\?\.webhook/.test(webhookSlice),
    'webhook intake must use route helper with fallback to god'
  );
});

test('unparkAfterClosingTime routes wrap-up notice to config.routes.wrapUp override', () => {
  const unparkSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function unparkAfterClosingTime('),
    activeIndexSource.indexOf('function nudgeWorker(')
  );
  assert.ok(
    !unparkSlice.includes("to: 'god'"),
    'unparkAfterClosingTime must not hardcode { to: "god" }; it must resolve recipient from config.routes.wrapUp'
  );
  assert.ok(
    /wrapUp/.test(unparkSlice),
    'unparkAfterClosingTime must query the wrapUp route from config or route resolver'
  );
});

test('routes are read per send dynamically, reflecting config edits without app restart', () => {
  // Routes must be queried on each send (e.g. via readConfig() or getter), not cached once at boot.
  const informGodSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('function informGod('),
    activeIndexSource.indexOf('function finalizeWorkerWorktree(')
  );
  assert.ok(
    /readConfig\(\)|getMessageRoute|resolveRouteRecipient/.test(informGodSlice),
    'informGod must read config on each invocation to honor live route changes'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 3: Message Templates Contract & Placeholder Interpolation
// ─────────────────────────────────────────────────────────────────────────────

test('loadMessageTemplate returns null when template file is absent in <hive>/prompts/messages/', (t) => {
  const { hiveRoot } = createTempHive(t);
  assert.equal(loadMessageTemplate(hiveRoot, 'nonExistentTemplate'), null);
  assert.equal(loadMessageTemplate(hiveRoot, 'drainForStop'), null);
  assert.equal(loadMessageTemplate(null, 'drainForStop'), null);
});

test('loadMessageTemplate rejects invalid template keys for path safety', (t) => {
  const { hiveRoot } = createTempHive(t);
  assert.equal(loadMessageTemplate(hiveRoot, '../drainForStop'), null);
  assert.equal(loadMessageTemplate(hiveRoot, 'path/traversal'), null);
  assert.equal(loadMessageTemplate(hiveRoot, 'key with spaces'), null);
});

test('loadMessageTemplate interpolates placeholders when <hive>/prompts/messages/<key>.md exists', (t) => {
  const { hiveRoot } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });

  fs.writeFileSync(
    path.join(msgDir, 'workerReapedTokenCap.md'),
    'ALERT: Agent {{workerId}} hit token limit (used: {{used}}, cap: {{tokenCap}}). Check branch immediately!',
    'utf8'
  );

  const rendered = loadMessageTemplate(hiveRoot, 'workerReapedTokenCap', {
    workerId: 'birch',
    used: '150,000',
    tokenCap: '100,000'
  });

  assert.equal(
    rendered,
    'ALERT: Agent birch hit token limit (used: 150,000, cap: 100,000). Check branch immediately!'
  );
});

test('renderMessageTemplate returns interpolated override when file exists, and bundled fallback when absent', (t) => {
  const { hiveRoot } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });

  const fallback = 'Default fallback for {{workerId}} with {{used}} tokens.';

  // When template file is absent -> uses fallback with interpolated placeholders
  const defaultRendered = renderMessageTemplate(hiveRoot, 'customNotice', { workerId: 'elm', used: 5000 }, fallback);
  assert.equal(defaultRendered, 'Default fallback for elm with 5000 tokens.');

  // When template file is present -> overrides fallback
  fs.writeFileSync(path.join(msgDir, 'customNotice.md'), 'Custom override: {{workerId}} used {{used}}!', 'utf8');
  const customRendered = renderMessageTemplate(hiveRoot, 'customNotice', { workerId: 'elm', used: 5000 }, fallback);
  assert.equal(customRendered, 'Custom override: elm used 5000!');
});

test('HiveManager exposes loadMessageTemplate reading from <hiveRoot>/prompts/messages/', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  assert.equal(typeof hive.loadMessageTemplate, 'function', 'hive.loadMessageTemplate must be a function');

  assert.equal(hive.loadMessageTemplate('drainForStop'), null);

  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.writeFileSync(path.join(msgDir, 'drainForStop.md'), 'Pending: {{count}} messages in {{inboxDir}}.', 'utf8');

  const loaded = hive.loadMessageTemplate('drainForStop', { count: 3, inboxDir: '/agents/w1/inbox' });
  assert.equal(loaded, 'Pending: 3 messages in /agents/w1/inbox.');
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 4: Harness-Authored Message Bodies & Overrides
// ─────────────────────────────────────────────────────────────────────────────

test('drainForStop in hive.ts uses <hive>/prompts/messages/drainForStop.md template when present', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });

  fs.writeFileSync(
    path.join(msgDir, 'drainForStop.md'),
    'CUSTOM DRAIN NOTICE: {{count}} items waiting in {{inboxDir}}. Review lines:\n{{lines}}\nMove to {{doneDir}}.',
    'utf8'
  );

  dropInboxMessage(hiveRoot, 'agent-1', 'msg-101', 'Card review', 'Please verify PR');

  const res = hive.drainForStop('agent-1');
  assert.equal(res.block, true);
  assert.match(
    res.reason ?? '',
    /^CUSTOM DRAIN NOTICE: 1 items waiting in .*\/agents\/agent-1\/inbox\. Review lines:\n- \[from boss, request\] Card review: Please verify PR\nMove to .*\/agents\/agent-1\/inbox\/\.done\.$/,
    'drainForStop must use the custom template from <hive>/prompts/messages/drainForStop.md'
  );
});

test('drainForStop in hive.ts falls back cleanly to bundled text when drainForStop.md is absent', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  dropInboxMessage(hiveRoot, 'agent-2', 'msg-102', 'Task update', 'Status is todo');

  const res = hive.drainForStop('agent-2');
  assert.equal(res.block, true);
  assert.match(
    res.reason ?? '',
    /You have 1 new hive message\(s\) in your inbox\. Address them before finishing:/,
    'drainForStop must fall back to the bundled 3-paragraph format when template is missing'
  );
});

test('unityPromptText in unityBroker.ts uses <hive>/prompts/messages/unityPrompt.md template when present', (t) => {
  const { hiveRoot } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });

  fs.writeFileSync(
    path.join(msgDir, 'unityPrompt.md'),
    'CUSTOM UNITY BROKER: Drop job to {{requestsDir}}/<id>.json; outputs land in {{resultsDir}}/<id>.',
    'utf8'
  );

  const rendered = unityPromptText('/agents/w/unity-requests', '/scratch/results', hiveRoot);
  assert.equal(
    rendered,
    'CUSTOM UNITY BROKER: Drop job to /agents/w/unity-requests/<id>.json; outputs land in /scratch/results/<id>.'
  );
});

test('unityPromptText in unityBroker.ts falls back cleanly to bundled text when unityPrompt.md is absent', (t) => {
  const { hiveRoot } = createTempHive(t);
  const rendered = unityPromptText('/agents/w/unity-requests', '/scratch/results', hiveRoot);
  assert.match(
    rendered,
    /^UNITY \(batch only\): you cannot run Unity yourself; the harness runs it for you/,
    'unityPromptText must fall back to bundled prompt when template is missing'
  );
});

test('startPromptText in dormantWake.ts uses <hive>/prompts/messages/startPrompt.md template when present', (t) => {
  const { hiveRoot } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });

  fs.writeFileSync(
    path.join(msgDir, 'startPrompt.md'),
    'CUSTOM START: Agent started with memory at {{memoryPath}} and tasks at {{myTasksPath}}.',
    'utf8'
  );

  const startWork = {
    isGod: false,
    memoryPath: '/hive/agents/w/memory.md',
    archivePath: '/hive/agents/w/memory-archive.md',
    memoryChars: 500,
    myTasksPath: '/hive/agents/w/my-tasks.md',
    tasksPath: '/hive/tasks.json',
    inboxDir: '/hive/agents/w/inbox',
    tasks: [],
    messages: [],
    hiveRoot
  };

  const rendered = startPromptText(startWork);
  assert.equal(
    rendered,
    'CUSTOM START: Agent started with memory at /hive/agents/w/memory.md and tasks at /hive/agents/w/my-tasks.md.'
  );
});

test('startPromptText in dormantWake.ts falls back cleanly to bundled steps when startPrompt.md is absent', (t) => {
  const { hiveRoot } = createTempHive(t);
  const startWork = {
    isGod: false,
    memoryPath: '/hive/agents/w/memory.md',
    archivePath: '/hive/agents/w/memory-archive.md',
    memoryChars: 500,
    myTasksPath: '/hive/agents/w/my-tasks.md',
    tasksPath: '/hive/tasks.json',
    inboxDir: '/hive/agents/w/inbox',
    tasks: [],
    messages: [],
    hiveRoot
  };

  const rendered = startPromptText(startWork);
  assert.match(
    rendered,
    /Read \/hive\/agents\/w\/memory\.md\./,
    'startPromptText must generate standard bundled steps when template is missing'
  );
  assert.match(
    rendered,
    /Nothing is assigned to you yet\./
  );
});

test('worker reaped token-cap notice in index.ts uses workerReapedTokenCap template', () => {
  const reapSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('const tokenCap = (rec.tokenCap'),
    activeIndexSource.indexOf('const rawIdleMs = ptyManager.idleFor')
  );
  assert.ok(
    /workerReapedTokenCap|loadMessageTemplate|renderMessageTemplate/.test(reapSlice),
    'ephemeral worker token cap reap notice must format body using workerReapedTokenCap template'
  );
});

test('worker reaped idle notice in index.ts uses workerReapedIdle template', () => {
  const idleSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('const rawIdleMs = ptyManager.idleFor'),
    activeIndexSource.indexOf('// (2) Process new requests')
  );
  assert.ok(
    /workerReapedIdle|loadMessageTemplate|renderMessageTemplate/.test(idleSlice),
    'ephemeral worker idle reap notice must format body using workerReapedIdle template'
  );
});

test('worker worktree reclaimed notice in index.ts uses workerWorktreeReclaimed template', () => {
  const gcSlice = activeIndexSource.slice(
    activeIndexSource.indexOf('async function gcPreservedWorktrees('),
    activeIndexSource.indexOf('async function ephemeralWorkerTick(')
  );
  assert.ok(
    /workerWorktreeReclaimed|loadMessageTemplate|renderMessageTemplate/.test(gcSlice),
    'worktree reclaimed GC notice must format body using workerWorktreeReclaimed template'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Part 5: Fallback safety and byte-identical defaults
// ─────────────────────────────────────────────────────────────────────────────

test('a template with an unknown placeholder, a blank body or an unreadable path falls back to the built-in text', (t) => {
  const { hiveRoot, hive } = createTempHive(t);
  const msgDir = path.join(hiveRoot, 'prompts', 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  dropInboxMessage(hiveRoot, 'agent-3', 'msg-103');

  fs.writeFileSync(path.join(msgDir, 'drainForStop.md'), 'Typo {{cuont}} here', 'utf8');
  assert.match(hive.drainForStop('agent-3').reason, /^You have 1 new hive message\(s\)/);

  dropInboxMessage(hiveRoot, 'agent-3', 'msg-104');
  fs.writeFileSync(path.join(msgDir, 'drainForStop.md'), '  \n', 'utf8');
  assert.match(hive.drainForStop('agent-3').reason, /^You have 1 new hive message\(s\)/);

  // a directory where the file should be: readFileSync throws
  fs.rmSync(path.join(msgDir, 'drainForStop.md'));
  fs.mkdirSync(path.join(msgDir, 'drainForStop.md'));
  dropInboxMessage(hiveRoot, 'agent-3', 'msg-105');
  assert.match(hive.drainForStop('agent-3').reason, /^You have 1 new hive message\(s\)/);
});

test('getMessageRoute falls back to god when the routed agent is not on the floor', () => {
  const known = (id) => id === 'real-agent';
  assert.equal(getMessageRoute('webhook', { routes: { webhook: 'real-agent' } }, known), 'real-agent');
  assert.equal(getMessageRoute('webhook', { routes: { webhook: 'ghost' } }, known), 'god');
  assert.equal(getMessageRoute('webhook', { routes: { webhook: 'boss' } }, known), 'boss');
  assert.equal(getMessageRoute('webhook', { routes: { webhook: '  ' } }, known), 'god');
});

test('bundled notice texts match the pre-template wording exactly', () => {
  const r = (k, v) => interpolateTemplate(BUNDLED_MESSAGE_TEMPLATES[k], v);
  assert.equal(
    r('workerReapedTokenCap', { workerId: 'w1', used: '9', tokenCap: '5' }),
    'Worker w1 used 9 tokens (> its cap of 5) and was reaped. Any committed work on its branch is preserved for you.'
  );
  assert.equal(
    r('workerReapedIdle', { workerId: 'w1', idleMinutes: 31, capMinutes: 30 }),
    'Worker w1 produced no output for 31 min (> the 30 min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.'
  );
  assert.equal(
    r('workerWorktreeReclaimed', { workerId: 'w1', detail: 'merged', wtPath: '/x' }),
    'The preserved worktree for w1 is now integrated (merged), so it and its scratch dir were garbage-collected.\nWorktree: /x'
  );
});
