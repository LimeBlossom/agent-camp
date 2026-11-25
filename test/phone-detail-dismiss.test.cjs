'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer, serveFile, audioMimeForPath, videoMimeForPath } = loadTs('src/main/phone.ts');
const { parsePhoneMarkdown } = loadTs('src/main/phoneMarkdown.ts');

const asked = () => ({
  id: 'asked', title: 'Pick one', project: 'Alpha', assignee: 'worker', status: 'blocked',
  description: 'The plan.', notes: 'Boss notes here.', result: '', dependsOn: ['other'],
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  humanQA: [
    { q: 'Old question?', a: 'Old answer', askedAt: '2026-11-01T01:00:00Z', answeredAt: '2026-11-01T02:00:00Z' },
    { q: 'Which way?', askedAt: '2026-11-02T01:00:00Z' },
  ],
});
const other = () => ({ id: 'other', title: 'The card it waits on', status: 'todo' });

function phone(tasks, patchOk = true) {
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  const patches = [], mail = [];
  const deps = {
    token: () => 'secret',
    state: () => ({ agents: [{ id: 'worker', name: 'Elm' }] }),
    tasks: () => ({ tasks }),
    patchTask: (id, patch) => {
      patches.push({ id, patch });
      if (patchOk) Object.assign(tasks.find((t) => t.id === id), patch);
      return patchOk;
    },
    sendToGod: (subject, body) => mail.push({ subject, body }),
    enqueue: () => false, roots: () => [],
  };
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (callback) => { handler = callback; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer(deps));
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  return {
    patches, mail,
    request(p, body) {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: p, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer secret' } });
        req.destroy = () => reject(new Error('request destroyed'));
        let status;
        handler(req, {
          writeHead(code) { status = code; },
          end(raw) { try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); } },
        });
        req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
        req.emit('end');
      });
    },
  };
}

test('task detail returns the card read-only, with Q&A history and dependency titles', async () => {
  const p = phone([asked(), other()]);
  const { status, body } = await p.request('/api/task?id=asked');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const t = body.task;
  assert.equal(t.title, 'Pick one');
  assert.equal(t.description, 'The plan.');
  assert.equal(t.notes, 'Boss notes here.');
  assert.deepEqual(t.dependsOn, [{ id: 'other', title: 'The card it waits on' }]);
  assert.deepEqual(t.qa.map((e) => [e.q, e.a, e.dismissed]), [['Old question?', 'Old answer', false], ['Which way?', '', false]]);
  assert.deepEqual(p.patches, [], 'reading a card never writes');
});

test('task detail for an unknown id is a soft error', async () => {
  const { body } = await phone([asked()]).request('/api/task?id=nope');
  assert.equal(body.ok, false);
  assert.ok(body.error);
});

test('dismiss marks only the open question dismissed, keeps it in history, sends no mail', async () => {
  const tasks = [asked()];
  const p = phone(tasks);
  const { body } = await p.request('/api/dismiss', { taskId: 'asked', q: 'Which way?' });
  assert.equal(body.ok, true);
  const qa = tasks[0].humanQA;
  assert.equal(qa.length, 2);
  assert.equal(qa[0].dismissedAt, undefined);
  assert.ok(qa[1].dismissedAt, 'open entry gets dismissedAt');
  assert.equal(qa[1].a, undefined, 'no fabricated answer');
  assert.equal(tasks[0].status, 'blocked');
  assert.deepEqual(p.mail, []);
  const state = await p.request('/api/state');
  assert.deepEqual(state.body.asks, [], 'dismissed ask leaves ASK ME');
});

test('dismiss refuses a question the Boss swapped since the phone polled', async () => {
  const p = phone([asked()]);
  const { body } = await p.request('/api/dismiss', { taskId: 'asked', q: 'Stale question?' });
  assert.equal(body.ok, false);
  assert.deepEqual(p.patches, []);
});

test('sound files parse as audio spans; other files stay plain text', () => {
  const spans = parsePhoneMarkdown('hear `take.mp3` and ![v](/r/voice.ogg); read `notes.txt` or `a.pdf`')[0].spans
    .filter((s) => s.kind !== 'text');
  assert.deepEqual(spans, [
    { kind: 'audio', src: 'take.mp3', alt: 'take.mp3' },
    { kind: 'audio', src: '/r/voice.ogg', alt: 'v' },
    { kind: 'code', text: 'notes.txt' },
    { kind: 'code', text: 'a.pdf' },
  ]);
  assert.equal(audioMimeForPath('/a/b.mp3'), 'audio/mpeg');
  assert.equal(audioMimeForPath('/a/b.mp4'), null);
  assert.equal(videoMimeForPath('/a/b.mp3'), null);
});

test('a sound file is served with its type and Range support, confined to roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-audio-'));
  fs.writeFileSync(path.join(root, 'take.mp3'), Buffer.alloc(500, 7));
  const server = http.createServer((req, res) => {
    void serveFile({ roots: () => [root] }, new URL(req.url, 'http://x').searchParams.get('p'), req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/?p=`;
  try {
    const whole = await fetch(base + encodeURIComponent(path.join(root, 'take.mp3')));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    const part = await fetch(base + encodeURIComponent('take.mp3'), { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(Buffer.from(await part.arrayBuffer()).length, 10);
    const outside = await fetch(base + encodeURIComponent('/etc/x.mp3'));
    assert.equal(outside.status, 404);
  } finally {
    server.close();
  }
});

test('the embedded page script parses and wires detail, dismiss and audio', () => {
  const script = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(PHONE_PAGE, /\/api\/task\?id=/);
  assert.match(PHONE_PAGE, /\/api\/dismiss/);
  assert.match(PHONE_PAGE, /s\.kind === 'audio'/);
});
