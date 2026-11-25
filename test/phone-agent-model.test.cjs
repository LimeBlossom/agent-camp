'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const loadTs = require('../test-support/load-ts.cjs');
const { startPhoneServer } = loadTs('src/main/phone.ts');

const OPUS = { provider: 'claude', model: 'claude-opus-4-8', label: 'claude/claude-opus-4-8' };
const SONNET = { provider: 'claude', model: 'claude-sonnet-4-6', label: 'claude/claude-sonnet-4-6' };

function phone(extra = {}) {
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  const calls = [];
  const deps = {
    token: () => 'secret',
    state: () => ({
      agents: [{ id: 'worker', name: 'Elm', model: 'claude-sonnet-4-6' }, { id: 'boss', name: 'Boss', isGod: true }],
      restorableAgents: [{ id: 'sleeper', name: 'Zzz' }]
    }),
    tasks: () => ({ tasks: [] }), patchTask: () => true, sendToGod() {}, enqueue: () => false, roots: () => [],
    modelChoices: () => ({ current: SONNET, choices: [SONNET, OPUS] }),
    switchModel: async (id, entry, confirmBoss) => { calls.push({ id, entry, confirmBoss }); return { ok: true, state: 'pending' }; },
    modelSwitching: (id) => (id === 'worker' ? { to: 'claude/claude-opus-4-8', state: 'pending' } : null),
    ...extra
  };
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (cb) => { handler = cb; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer(deps));
  } finally { http.createServer = originalCreate; os.networkInterfaces = originalInterfaces; }
  return {
    calls,
    request(path, body, token = 'secret') {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token } });
        req.destroy = () => reject(new Error('destroyed'));
        let status;
        handler(req, { writeHead(c) { status = c; }, end(raw) { try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); } } });
        req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
        req.emit('end');
      });
    }
  };
}

test('POST /api/agent-model needs the token', async () => {
  const p = phone();
  const r = await p.request('/api/agent-model', { id: 'worker', provider: 'claude', model: 'claude-opus-4-8' }, 'wrong');
  assert.equal(r.status, 401);
  assert.equal(p.calls.length, 0);
});

test('a valid request reaches the switch with the chosen entry and reports its state', async () => {
  const p = phone();
  const r = await p.request('/api/agent-model', { id: 'worker', provider: 'claude', model: 'claude-opus-4-8' });
  assert.equal(r.status, 200);
  assert.deepEqual({ ok: r.body.ok, state: r.body.state }, { ok: true, state: 'pending' });
  assert.deepEqual(p.calls, [{ id: 'worker', entry: { provider: 'claude', model: 'claude-opus-4-8' }, confirmBoss: false }]);
});

test('missing fields, unknown agents and entries outside the agent choices are refused without switching', async () => {
  const p = phone();
  assert.equal((await p.request('/api/agent-model', { provider: 'claude' })).status, 400);
  assert.equal((await p.request('/api/agent-model', { id: 'worker' })).status, 400);
  const unknown = await p.request('/api/agent-model', { id: 'ghost', provider: 'claude', model: 'claude-opus-4-8' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.ok, false);
  const bad = await p.request('/api/agent-model', { id: 'worker', provider: 'claude', model: 'claude-nonesuch' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /not available/);
  assert.equal(p.calls.length, 0);
});

test('the Boss is refused unless the request carries confirmBoss', async () => {
  const p = phone();
  const refused = await p.request('/api/agent-model', { id: 'boss', provider: 'claude', model: 'claude-opus-4-8' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.ok, false);
  assert.equal(p.calls.length, 0);
  const ok = await p.request('/api/agent-model', { id: 'boss', provider: 'claude', model: 'claude-opus-4-8', confirmBoss: true });
  assert.equal(ok.status, 200);
  assert.equal(p.calls[0].confirmBoss, true);
});

test('an agent the camp reports unswitchable comes back as a clean refusal', async () => {
  const p = phone({ switchModel: async () => ({ ok: false, code: 'unknown-entry', error: 'model not available for this agent' }) });
  const r = await p.request('/api/agent-model', { id: 'worker', provider: 'claude', model: 'claude-opus-4-8' });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'model not available for this agent');
});

test('GET /api/agent-model lists the choices; state carries the pending switch', async () => {
  const p = phone();
  const r = await p.request('/api/agent-model?id=worker');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.choices.map((c) => c.label), ['claude/claude-sonnet-4-6', 'claude/claude-opus-4-8']);
  assert.equal((await p.request('/api/agent-model?id=ghost')).status, 404);
  const st = await p.request('/api/state');
  const w = st.body.agents.find((a) => a.id === 'worker');
  assert.deepEqual(w.switching, { to: 'claude/claude-opus-4-8', state: 'pending' });
  assert.equal(st.body.agents.find((a) => a.id === 'boss').switching, undefined);
});

test('the phone page offers a model picker with a current -> new confirm step', () => {
  const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
  assert.match(PHONE_PAGE, /\/api\/agent-model/);
  assert.match(PHONE_PAGE, /confirmBoss/);
  assert.match(PHONE_PAGE, /\\u2192/);
});

test('opening the phone picker refreshes its list for the following switch', async () => {
  const gemini = { provider: 'antigravity', model: 'gemini-4-future-high', label: 'Gemini 4 Future (High)' };
  let choices = [SONNET];
  const refreshes = [];
  const p = phone({
    modelChoices: async (id, refresh) => {
      refreshes.push([id, refresh]);
      if (refresh) choices = [SONNET, gemini];
      return { current: SONNET, choices };
    }
  });

  const opened = await p.request('/api/agent-model?id=worker');
  assert.deepEqual(opened.body.choices, [SONNET, gemini]);
  const switched = await p.request('/api/agent-model', { id: 'worker', provider: gemini.provider, model: gemini.model });
  assert.equal(switched.status, 200);
  assert.deepEqual(refreshes, [['worker', true], ['worker', undefined]]);
});
