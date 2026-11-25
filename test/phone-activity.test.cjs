'use strict';

// Live activity on the floor cards and the read-only /api/transcript tail.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const loadTs = require('../test-support/load-ts.cjs');
const { startPhoneServer, stripAnsi, tailLines } = loadTs('src/main/phone.ts');

function phone(extra = {}) {
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  const enqueued = [];
  const deps = {
    token: () => 'secret',
    state: () => ({ agents: [{ id: 'worker', name: 'Elm', status: 'working', action: 'editing foo.ts' }] }),
    tasks: () => ({ tasks: [] }),
    patchTask: () => true, sendToGod() {}, roots: () => [],
    enqueue: (...a) => { enqueued.push(a); return true; },
    activity: (id) => (id === 'worker' ? { actionSince: 1000, lastOutputAt: 2000 } : undefined),
    transcript: (id) => (id === 'worker' ? 'one\r\ntwo\r\n' : null),
    ...extra,
  };
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (cb) => { handler = cb; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer(deps));
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  return {
    enqueued,
    request(p, { auth = 'Bearer secret', method = 'GET' } = {}) {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: p, method, headers: auth ? { authorization: auth } : {} });
        req.destroy = () => reject(new Error('destroyed'));
        let status;
        handler(req, { writeHead(c) { status = c; }, end(raw) { try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); } } });
        req.emit('end');
      });
    },
  };
}

test('snapshot carries actionSince and lastOutputAt per agent', async () => {
  const { body } = await phone().request('/api/state');
  assert.equal(body.agents[0].action, 'editing foo.ts');
  assert.equal(body.agents[0].actionSince, 1000);
  assert.equal(body.agents[0].lastOutputAt, 2000);
});

test('snapshot activity fields are null when the app has none', async () => {
  const { body } = await phone({ activity: undefined }).request('/api/state');
  assert.equal(body.agents[0].actionSince, null);
  assert.equal(body.agents[0].lastOutputAt, null);
});

test('transcript returns the agent output lines', async () => {
  const { status, body } = await phone().request('/api/transcript?id=worker');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.lines, ['one', 'two']);
  assert.equal(body.truncated, false);
});

test('transcript needs the token', async () => {
  const p = phone();
  assert.equal((await p.request('/api/transcript?id=worker', { auth: '' })).status, 401);
  assert.equal((await p.request('/api/transcript?id=worker', { auth: 'Bearer wrong' })).status, 401);
});

test('transcript for an unknown agent is a clean error', async () => {
  const { status, body } = await phone().request('/api/transcript?id=nobody');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: false, error: 'agent not found' });
  assert.deepEqual((await phone().request('/api/transcript')).body, { ok: false, error: 'agent not found' });
});

test('transcript is read-only: POST is refused and nothing is enqueued', async () => {
  const p = phone();
  const r = await p.request('/api/transcript?id=worker', { method: 'POST' });
  assert.notEqual(r.status, 200);
  assert.equal(p.enqueued.length, 0);
});

test('transcript is bounded to 400 lines', async () => {
  const raw = Array.from({ length: 1000 }, (_, i) => 'line' + i).join('\n');
  const { body } = await phone({ transcript: () => raw }).request('/api/transcript?id=worker');
  assert.equal(body.lines.length, 400);
  assert.equal(body.lines[399], 'line999');
  assert.equal(body.lines[0], 'line600');
  assert.equal(body.truncated, true);
});

test('transcript is bounded to 64 KB, keeping the newest lines', async () => {
  const raw = Array.from({ length: 300 }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(496)).join('\n');
  const { body } = await phone({ transcript: () => raw }).request('/api/transcript?id=worker');
  const bytes = Buffer.byteLength(body.lines.join('\n'));
  assert.ok(bytes <= 64 * 1024, 'bytes ' + bytes);
  assert.ok(body.lines[body.lines.length - 1].startsWith('299'));
  assert.equal(body.truncated, true);
});

test('transcript strips ANSI escape codes', async () => {
  const raw = '\x1b[31mred\x1b[0m text\n\x1b]0;title\x07\x1b[2K\x1b[1;1Hnext \x1b(Bline';
  const { body } = await phone({ transcript: () => raw }).request('/api/transcript?id=worker');
  assert.deepEqual(body.lines, ['red text', 'next line']);
});

test('stripAnsi and tailLines helpers', () => {
  assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
  assert.equal(stripAnsi('a\x07b\rc'), 'ab\rc');
  assert.deepEqual(tailLines('a\nb\nc', 2, 1000).lines, ['b', 'c']);
});
