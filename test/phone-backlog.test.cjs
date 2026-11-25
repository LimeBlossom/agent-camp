'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer } = loadTs('src/main/phone.ts');
const { unbacklogPatch, unbacklogMailBody } = loadTs('src/shared/backlog.ts');

const shelved = () => ({
  id: 'shelved', title: 'Later card', project: 'Alpha', assignee: 'worker',
  status: 'blocked', backloggedAt: '2026-10-30T12:00:00Z',
  description: 'Read the full deferred plan.',
  humanQA: [{ q: 'Which approach should we use?' }],
});

// Capture the real HTTP handler without opening the production port or requiring Tailscale.
function phone(tasks = [shelved()], patchOk = true) {
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
    http.createServer = (callback) => {
      handler = callback;
      return { on() {}, listen() {} };
    };
    assert.ok(startPhoneServer(deps));
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  return {
    patches, mail,
    request(path, body, token = 'secret') {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: path, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token } });
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

test('phone state partitions shelved cards from the active board and ASK ME', async () => {
  const p = phone([
    shelved(),
    { id: 'active', title: 'Active', status: 'blocked', humanQA: [{ q: 'Now?' }] },
    { id: 'done', status: 'done', backloggedAt: '2026-10-29T00:00:00Z' },
    { id: 'empty', status: 'todo', backloggedAt: '' },
  ]);
  const { status, body } = await p.request('/api/state');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.backlog), 'state must publish a separate backlog array');
  assert.deepEqual(body.backlog.map((t) => t.id), ['shelved']);
  assert.deepEqual(body.board.map((t) => t.id), ['active', 'done', 'empty']);
  assert.deepEqual(body.asks.map((t) => t.id), ['active']);
});

test('backlog payload includes card metadata, description and open question for reading', async () => {
  const { body } = await phone().request('/api/state');
  const card = body.backlog?.find((t) => t.id === 'shelved');
  assert.ok(card, 'shelved card must be readable on the phone');
  for (const key of ['title', 'project', 'assignee', 'description', 'backloggedAt']) {
    assert.equal(card[key], shelved()[key], key);
  }
  assert.equal(card.q, shelved().humanQA[0].q);
});

test('empty phone state still exposes an empty backlog list', async () => {
  assert.deepEqual((await phone([]).request('/api/state')).body.backlog, []);
});

test('phone bring-back uses the existing patch and informs the Boss after success', async () => {
  const p = phone();
  const reply = await p.request('/api/unbacklog', { taskId: 'shelved' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.deepEqual(p.patches, [{ id: 'shelved', patch: unbacklogPatch() }]);
  assert.ok(Object.hasOwn(p.patches[0].patch, 'backloggedAt'), 'undefined must reach patchTask before JSON serialization');
  assert.deepEqual(p.mail, [{
    subject: 'BACK FROM BACKLOG: "Later card"',
    body: unbacklogMailBody('Later card', 'shelved'),
  }]);
  const { body } = await p.request('/api/state');
  assert.deepEqual(body.backlog, []);
  assert.equal(body.board[0].status, 'blocked', 'bring-back must leave scheduling to the Boss');
  assert.deepEqual(body.asks.map((t) => t.id), ['shelved']);
});

test('a rejected patch keeps the card shelved and sends no success mail', async () => {
  const p = phone([shelved()], false);
  const { body } = await p.request('/api/unbacklog', { taskId: 'shelved' });
  assert.equal(body.ok, false);
  assert.ok(body.error);
  assert.equal(p.patches.length, 1, 'must attempt the existing patch path');
  assert.deepEqual(p.mail, []);
  assert.equal((await p.request('/api/state')).body.backlog[0].id, 'shelved');
});

test('missing, active and completed cards cannot be brought back', async () => {
  const p = phone([{ id: 'active', status: 'todo' }, { ...shelved(), id: 'done', status: 'done' }]);
  for (const taskId of ['missing', 'active', 'done', 123, null]) {
    const { body } = await p.request('/api/unbacklog', { taskId });
    assert.equal(body.ok, false, String(taskId));
  }
  assert.deepEqual(p.patches, []);
  assert.deepEqual(p.mail, []);
});

test('bring-back requires the phone token', async () => {
  const p = phone();
  assert.equal((await p.request('/api/unbacklog', { taskId: 'shelved' }, 'wrong')).status, 401);
  assert.deepEqual(p.patches, []);
  assert.deepEqual(p.mail, []);
});

class Node {
  constructor(tag) {
    this.tagName = tag; this.childNodes = []; this.parentNode = null;
    this.dataset = {}; this.className = ''; this.attrs = {}; this.style = {};
  }
  get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
  get lastElementChild() { return this.children.at(-1) || null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, n);
    n.parentNode = this; return n;
  }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  set textContent(value) { this.childNodes = []; if (value) this.appendChild(text(value)); }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  closest(tag) { let n = this; while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode; return n; }
  all(pred) { return this.childNodes.flatMap((n) => [...(pred(n) ? [n] : []), ...n.all(pred)]); }
  click() { if (this.onclick) this.onclick({ target: this }); }
}
function text(value) { const n = new Node('#text'); n.data = String(value); return n; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function page(p, failBringBack = false) {
  const body = new Node('BODY'), ids = {}, writes = [];
  for (const match of PHONE_PAGE.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    ids[match[2]] = body.appendChild(new Node(match[1].toUpperCase()));
  }
  // Build navigation from shipped markup: a fabricated Backlog button would mask its absence.
  for (const match of PHONE_PAGE.matchAll(/<button\b[^>]*data-tab="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const b = ids.nav.appendChild(new Node('BUTTON'));
    b.dataset.tab = match[1]; b.textContent = match[2].replace(/<[^>]*>/g, '');
  }
  let timer;
  const script = PHONE_PAGE.split('<script>')[1].split('</script>')[0];
  vm.runInNewContext(script, {
    document: {
      hidden: false, activeElement: null,
      createElement: (tag) => new Node(tag.toUpperCase()), createTextNode: text,
      getElementById: (id) => ids[id] || null,
      querySelectorAll: (sel) => sel === 'nav button' ? ids.nav.children :
        body.all((n) => sel.startsWith('.') ? n.className.split(' ').includes(sel.slice(1)) : n.tagName === sel.toUpperCase()),
      addEventListener() {},
    },
    location: { hash: '#secret', pathname: '/', search: '' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} }, URLSearchParams,
    fetch: async (path, options) => {
      const payload = options.body ? JSON.parse(options.body) : undefined;
      if (payload) writes.push({ path, payload, options });
      const result = failBringBack && path === '/api/unbacklog'
        ? { status: 200, body: { ok: false, error: 'task changed; refresh' } }
        : await p.request(path, payload);
      return { status: result.status, json: async () => result.body };
    },
    setInterval(fn) { timer = fn; },
  });
  await tick(); await tick();
  return {
    main: ids.main, writes,
    openBacklog() {
      const b = ids.nav.children.find((n) => n.dataset.tab === 'backlog');
      assert.ok(b, 'phone navigation must offer Backlog');
      ids.nav.onclick({ target: b });
    },
    async poll() { timer(); await tick(); await tick(); },
  };
}

function bringBackButton(p) {
  const b = p.main.all((n) => n.tagName === 'BUTTON' && /bring back|un-?backlog/i.test(n.textContent))[0];
  assert.ok(b, 'backlog card must offer a bring-back action');
  return b;
}

test('phone navigation opens a Backlog list with title, project and assignee', async () => {
  const p = await page(phone());
  p.openBacklog();
  assert.match(p.main.textContent, /Later card/);
  assert.match(p.main.textContent, /Alpha/);
  assert.match(p.main.textContent, /Elm/);
});

test('phone backlog card exposes its description and open question for reading', async () => {
  const p = await page(phone());
  p.openBacklog();
  assert.match(p.main.textContent, /Read the full deferred plan\./);
  assert.match(p.main.textContent, /Which approach should we use\?/);
});

test('phone bring-back button clears the shelf through the server and refreshes the list', async () => {
  const server = phone(), p = await page(server);
  p.openBacklog();
  bringBackButton(p).click();
  await tick(); await tick();
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0].path, '/api/unbacklog');
  assert.deepEqual(p.writes[0].payload, { taskId: 'shelved' });
  assert.equal(p.writes[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(server.patches.length, 1);
  assert.doesNotMatch(p.main.textContent, /Later card/);
});

test('phone rejected bring-back keeps the card visible and retryable', async () => {
  const p = await page(phone(), true);
  p.openBacklog();
  bringBackButton(p).click();
  await tick(); await tick();
  assert.match(p.main.textContent, /Later card/);
  assert.equal(!!bringBackButton(p).disabled, false);
});

test('phone empty Backlog view has an empty message', async () => {
  const p = await page(phone([]));
  p.openBacklog();
  assert.match(p.main.textContent, /no .*backlog|backlog.*empty|nothing.*backlog/i);
});

test('backlog is newest-shelved first and lists what is stuck behind each card', async () => {
  const dep = (id) => ({ id, title: 'Dep ' + id, status: 'todo', assignee: 'worker', dependsOn: ['shelved'] });
  const p = phone([
    { ...shelved(), id: 'older', backloggedAt: '2026-10-01T00:00:00Z' },
    shelved(),
    ...['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].map(dep),
  ]);
  const { body } = await p.request('/api/state');
  assert.deepEqual(body.backlog.map((t) => t.id), ['shelved', 'older']);
  assert.equal(body.backlog[0].stuckCount, 7);
  assert.equal(body.backlog[0].stuck.length, 6);
  assert.equal(body.backlog[1].stuckCount, 0);
});

test('phone can shelve an open ASK ME card and informs the Boss', async () => {
  const card = { id: 'ask', title: 'Ask card', status: 'blocked', humanQA: [{ q: 'Pick?' }] };
  const p = phone([card]);
  const { body } = await p.request('/api/backlog', { taskId: 'ask' });
  assert.equal(body.ok, true);
  assert.equal(p.patches.length, 1);
  assert.equal(p.patches[0].patch.status, 'blocked');
  assert.ok(Date.parse(p.patches[0].patch.backloggedAt) > 0);
  assert.equal(p.mail[0].subject, 'BACKLOG: "Ask card"');
  const state = (await p.request('/api/state')).body;
  assert.deepEqual(state.asks, []);
  assert.deepEqual(state.backlog.map((t) => t.id), ['ask']);
});

test('shelving refuses cards without an open question, already shelved ones, and bad tokens', async () => {
  const p = phone([shelved(), { id: 'plain', status: 'todo' }]);
  for (const taskId of ['missing', 'shelved', 'plain', 5]) {
    assert.equal((await p.request('/api/backlog', { taskId })).body.ok, false, String(taskId));
  }
  assert.equal((await p.request('/api/backlog', { taskId: 'plain' }, 'wrong')).status, 401);
  assert.deepEqual(p.patches, []);
});
