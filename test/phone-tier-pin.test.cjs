'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const loadTs = require('../test-support/load-ts.cjs');
const { startPhoneServer } = loadTs('src/main/phone.ts');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));
const TAIL = { ok: true, lines: [], truncated: false };

class Node {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.className = ''; this.attrs = {}; this.style = {}; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 200; }
  get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  set textContent(t) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; if (t) this.appendChild(text(t)); }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  closest(tag) { let n = this; while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode; return n; }
  all(pred, acc = []) { this.childNodes.forEach((c) => { if (pred(c)) acc.push(c); c.all(pred, acc); }); return acc; }
}
function text(t) { const n = new Node('#text'); n.data = String(t); return n; }

function page(states, posts) {
  const body = new Node('BODY');
  const byId = {};
  for (const id of ['stamp', 'main', 'askBadge']) { byId[id] = body.appendChild(new Node(id === 'main' ? 'MAIN' : 'SPAN')); }
  const nav = byId.nav = body.appendChild(new Node('NAV'));
  for (const t of ['floor', 'ask', 'tasks']) { const b = nav.appendChild(new Node('BUTTON')); b.dataset.tab = t; }
  let polls = 0, timer = null;
  const document = {
    hidden: false, activeElement: null,
    createElement: (tag) => new Node(tag.toUpperCase()),
    createTextNode: text,
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) => body.all((n) => sel[0] === '.' ? n.className.split(' ')[0] === sel.slice(1) : n.tagName === (sel === 'nav button' ? 'BUTTON' : sel.toUpperCase())),
    addEventListener() {},
  };
  const ctx = {
    document,
    location: { hash: '#tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} },
    fetch: (u, o) => { if (o && o.method === 'POST') { posts.push({ path: u, body: JSON.parse(o.body) }); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }); } return Promise.resolve({ status: 200, json: () => Promise.resolve(u.startsWith('/api/transcript') ? TAIL : states[Math.min(polls++, states.length - 1)]) }); },
    setInterval(fn) { timer = fn; },
    Date, JSON, Object, Array, String,
  };
  vm.runInNewContext(SCRIPT, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    main: byId.main,
    async poll() { timer(); await tick(); await tick(); },
    text: () => byId.main.textContent,
    all: (cls) => byId.main.all((n) => n.className.split(' ').includes(cls)),
    tab(t) { nav.onclick({ target: { closest: () => nav.children.find((b) => b.dataset.tab === t) } }); },
    replies: () => byId.main.all((n) => n.className === 'reply'),
    videos: () => byId.main.all((n) => n.tagName === 'VIDEO'),
  };
}


const tick = () => new Promise((r) => setImmediate(r));

const PIN = { provider: 'claude', model: 'claude-opus-4-8', label: 'claude/claude-opus-4-8' };

function phone(extra = {}) {
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  const cleared = [];
  const deps = {
    token: () => 'secret',
    state: () => ({ agents: [{ id: 'worker', name: 'Elm' }, { id: 'plain', name: 'Plain' }, { id: 'boss', name: 'Boss', isGod: true }] }),
    tasks: () => ({ tasks: [] }), patchTask: () => true, sendToGod() {}, enqueue: () => false, roots: () => [],
    agentTier: (id) => (id === 'worker' ? { tier: 'Strong', pin: { ...PIN, unused: 'needs Unity' } } : id === 'plain' ? { tier: 'Light' } : null),
    clearPin: (id) => { cleared.push(id); return id === 'worker'; },
    ...extra
  };
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (cb) => { handler = cb; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer(deps));
  } finally { http.createServer = originalCreate; os.networkInterfaces = originalInterfaces; }
  return {
    cleared,
    request(p, body, token = 'secret') {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: p, method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token } });
        req.destroy = () => reject(new Error('destroyed'));
        let status;
        handler(req, { writeHead(c) { status = c; }, end(raw) { try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); } } });
        req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
        req.emit('end');
      });
    }
  };
}

test('/api/state carries each agent tier and its pin, with why an unusable pin is not used', async () => {
  const p = phone();
  const st = await p.request('/api/state');
  const by = (id) => st.body.agents.find((a) => a.id === id);
  assert.equal(by('worker').tier, 'Strong');
  assert.deepEqual(by('worker').pin, { ...PIN, unused: 'needs Unity' });
  assert.equal(by('plain').tier, 'Light');
  assert.equal(by('plain').pin, undefined);
  assert.equal(by('boss').tier, undefined);
});

test('POST /api/clear-pin needs the token, refuses unknown agents and clears through the camp', async () => {
  const p = phone();
  assert.equal((await p.request('/api/clear-pin', { id: 'worker' }, 'wrong')).status, 401);
  assert.equal((await p.request('/api/clear-pin', {})).status, 400);
  assert.equal((await p.request('/api/clear-pin', { id: 'ghost' })).status, 404);
  assert.deepEqual(p.cleared, []);
  const ok = await p.request('/api/clear-pin', { id: 'worker' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.deepEqual(p.cleared, ['worker']);
});

test('the opened agent shows its tier and pin, and Clear pin posts the agent id', async () => {
  const long = 'antigravity/gemini-4-future-ultra-high-thinking-preview-2026-11-experimental';
  const states = [{ live: true, asks: [], board: [], agents: [
    { id: 'w', name: 'Pika', status: 'idle', action: 'idle', lastReply: '', lastReplyAt: null, tier: 'Strong', pin: { provider: 'antigravity', model: 'x', label: long, unused: 'needs Unity' } },
    { id: 'n', name: 'Nopin', status: 'idle', action: 'idle', lastReply: '', lastReplyAt: null, tier: 'Light' }
  ] }];
  const posts = [];
  const p = page(states, posts);
  await tick(); await tick();
  const [card, other] = p.main.children;
  card.onclick({ target: { tagName: 'DIV', className: '' } });
  other.onclick({ target: { tagName: 'DIV', className: '' } });
  const text = p.text();
  assert.match(text, /Tier: Strong/);
  assert.match(text, /Tier: Light/);
  assert.ok(text.includes('Pin: ' + long + ' (not used: needs Unity)'));
  const clears = p.main.all((n) => n.tagName === 'BUTTON' && n.textContent === 'Clear pin');
  assert.equal(clears.length, 1, 'only the pinned agent offers Clear pin');
  clears[0].onclick();
  await tick(); await tick();
  assert.deepEqual(posts, [{ path: '/api/clear-pin', body: { id: 'w' } }]);
});

test('the phone and Edit Agent clear a pin through one camp function', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ipc = src.slice(src.indexOf("ipcMain.handle('engine:clearPin'"));
  assert.match(ipc.slice(0, ipc.indexOf('});') + 3), /clearAgentPin\(agentId\)/);
  const phoneDeps = src.slice(src.indexOf('startPhoneServer({'));
  assert.match(phoneDeps.slice(0, phoneDeps.indexOf('\n  });')), /clearPin: \(id\) => clearAgentPin\(id\)/);
});
