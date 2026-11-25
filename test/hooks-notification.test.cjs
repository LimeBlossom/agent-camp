'use strict';
/**
 * HookServer's Notification/Stop branches are what tell the harness an agent is
 * idle and safe to deliver queued mail to. Both branches call notify() but
 * neither had test coverage:
 *   - Stop/SubagentStop always notifies "finished — idle" (unless stop_hook_active)
 *   - Notification only notifies when notification_type === 'idle' OR the message
 *     text contains "waiting for your input" (case-insensitive) — this string
 *     fallback exists for CLI versions/locales that don't send the structured
 *     notification_type field, so both paths need to be proven independently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const electron = require.resolve('electron');
const notifications = [];
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    Notification: class {
      constructor(opts) { this.opts = opts; }
      show() { notifications.push(this.opts); }
      static isSupported() { return true; }
    }
  }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const CONFIG = { notifications: true };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-notif-'));
}

async function floor(t, onEvent) {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => CONFIG, undefined, undefined, undefined, onEvent);
  const fire = (payload) => server.handle({ agent_id: 'jim-1', session_id: 's1', ...payload });
  notifications.length = 0;
  return { home, hive, server, fire };
}

test('SessionStart compact reaches the observer so an idle compaction can finish without PostCompact', async (t) => {
  const { TodoNudger } = loadTs('src/main/todoNudge.ts');
  const cards = [];
  const closes = [];
  const nudger = new TodoNudger({
    facts: () => ({ eligible: true, hasMail: false, canClose: true, cards }),
    nudge: () => false,
    ignored: () => {},
    close: (id) => { closes.push(id); return true; },
    scheduler: { set: () => 1, clear: () => {} }
  });
  const { fire } = await floor(t, (id, event, message, source) => nudger.noteHook(id, event, message, source));
  nudger.begin('jim-1', []);
  await fire({ hook_event_name: 'Stop' });
  await fire({ hook_event_name: 'PreCompact' });
  cards.push({ id: 'next', status: 'todo' });
  await fire({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.deepEqual(closes, ['jim-1']);
  assert.equal(nudger.holdMail('jim-1'), true);
});

test('Notification with notification_type "idle" fires a toast', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'Notification', notification_type: 'idle', message: 'anything' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'jim-1');
});

test('Notification with message "waiting for your input" fires a toast (string fallback)', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'Notification', message: 'Claude is Waiting For Your Input' });
  assert.equal(notifications.length, 1, 'must be case-insensitive');
});

test('Notification for a permission request does NOT fire the idle toast', async (t) => {
  const { fire } = await floor(t);
  await fire({
    hook_event_name: 'Notification',
    notification_type: 'permission',
    message: 'Claude wants to run a command'
  });
  assert.equal(notifications.length, 0,
    'a permission request is surfaced natively in the CLI session, not as a desktop toast');
});

test('Notification with neither field set does NOT fire', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'Notification' });
  assert.equal(notifications.length, 0);
});

test('Stop fires "finished — idle"', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'Stop' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, 'finished — idle');
});

test('Stop with stop_hook_active does NOT re-notify', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'Stop', stop_hook_active: true });
  assert.equal(notifications.length, 0,
    'an already-re-entered Stop boundary must not spam another toast');
});

test('SubagentStop behaves the same as Stop', async (t) => {
  const { fire } = await floor(t);
  await fire({ hook_event_name: 'SubagentStop' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, 'finished — idle');
});

test('notifications setting off suppresses the OS toast but the hook still resolves', async (t) => {
  const home = tmpHome();
  t.after(() => rmTree(home));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  notifications.length = 0;
  const res = await server.handle({ agent_id: 'jim-1', session_id: 's1', hook_event_name: 'Stop' });
  assert.equal(notifications.length, 0, 'notifications:false must suppress the OS toast');
  assert.deepEqual(res, {}, 'the hook itself still resolves normally');
});

test('Boss PostCompact reaches the observer used for reorientation', async (t) => {
  const { hive, home } = await floor(t);
  await hive.ensureAgent({ id: 'god', name: 'Boss', isGod: true, provider: 'claude', cwd: home });
  const { bossCompactResumeText, isWorkStartPrompt } = loadTs('src/shared/hiveNudge.ts');
  const resumes = [];
  const server = new HookServer(hive, () => null, () => CONFIG, undefined, undefined, undefined,
    (agentId, event) => {
      if (event === 'PostCompact' && agentId && hive.isGod(agentId)) {
        resumes.push(bossCompactResumeText('/hive/agents/' + agentId));
      }
    });
  await server.handle({ agent_id: 'god', hook_event_name: 'PostCompact' });
  await server.handle({ agent_id: 'jim-1', hook_event_name: 'PostCompact' });
  assert.equal(resumes.length, 1);
  assert.match(resumes[0], /my-tasks\.md/);
  assert.equal(isWorkStartPrompt(resumes[0]), true);
});
