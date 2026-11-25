'use strict';

// Tests for camp-ask-timestamps:
// 1. Show each question's askedAt (local time, plus 'x h ago') on the ASK ME board card and on the phone.
// 2. When a card has several asks, each shows its own time.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const loadTs = require('../test-support/load-ts.cjs');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer } = loadTs('src/main/phone.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));

const ASK_ME_TAB_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/src/components/AskMeTab.tsx'),
  'utf8'
);

class MockNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.attrs = {};
    this.style = {};
  }
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
  removeChild(n) {
    const idx = this.childNodes.indexOf(n);
    if (idx !== -1) { this.childNodes.splice(idx, 1); n.parentNode = null; }
    return n;
  }
  set textContent(t) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (t) this.appendChild(text(t));
  }
  get textContent() {
    return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join('');
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  closest(tag) {
    let n = this;
    while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode;
    return n;
  }
  all(pred, acc = []) {
    this.childNodes.forEach((c) => { if (pred(c)) acc.push(c); c.all(pred, acc); });
    return acc;
  }
}
function text(t) { const n = new MockNode('#text'); n.data = String(t); return n; }

function phoneServer(tasks) {
  let handler;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  const deps = {
    token: () => 'secret',
    state: () => ({ agents: [{ id: 'w1', name: 'Elm' }] }),
    tasks: () => ({ tasks }),
    patchTask: () => true,
    sendToGod: () => {},
    enqueue: () => false,
    roots: () => [],
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
    request(p) {
      return new Promise((resolve, reject) => {
        const req = new EventEmitter();
        Object.assign(req, { url: p, method: 'GET', headers: { authorization: 'Bearer secret' } });
        req.destroy = () => reject(new Error('request destroyed'));
        let status;
        handler(req, {
          writeHead(code) { status = code; },
          end(raw) { try { resolve({ status, body: JSON.parse(raw) }); } catch (e) { reject(e); } },
        });
        req.emit('data', Buffer.from(''));
        req.emit('end');
      });
    },
  };
}

function phonePage(states, detailResponses = {}) {
  const body = new MockNode('BODY');
  const byId = {};
  for (const id of ['stamp', 'main', 'askBadge']) { byId[id] = body.appendChild(new MockNode(id === 'main' ? 'MAIN' : 'SPAN')); }
  const nav = byId.nav = body.appendChild(new MockNode('NAV'));
  for (const t of ['floor', 'ask', 'tasks', 'backlog']) { const b = nav.appendChild(new MockNode('BUTTON')); b.dataset.tab = t; }
  let polls = 0, timer = null;
  const document = {
    hidden: false, activeElement: null,
    createElement: (tag) => new MockNode(tag.toUpperCase()),
    createTextNode: text,
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) => body.all((n) => n.tagName === (sel === 'nav button' ? 'BUTTON' : sel.toUpperCase())),
    addEventListener() {},
  };
  const ctx = {
    document,
    location: { hash: '#tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} },
    fetch: (u) => {
      if (u.startsWith('/api/task?id=')) {
        const id = new URL(u, 'http://x').searchParams.get('id');
        const d = detailResponses[id] || { ok: false, error: 'not found' };
        return Promise.resolve({ status: 200, json: () => Promise.resolve(d) });
      }
      return Promise.resolve({ status: 200, json: () => Promise.resolve(states[Math.min(polls++, states.length - 1)]) });
    },
    setInterval(fn) { timer = fn; },
    Date, JSON, Object, Array, String,
  };
  vm.runInNewContext(SCRIPT, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    main: byId.main,
    tab(t) { nav.onclick({ target: { closest: () => nav.children.find((b) => b.dataset.tab === t) } }); },
    text: () => byId.main.textContent,
    all: (cls) => byId.main.all((n) => (n.className || '').split(' ').includes(cls)),
    async tick() { await tick(); await tick(); },
  };
}

// ── Point 1: Phone API state includes askedAt on asks ─────────────────────────

test('phone API (/api/state) includes askedAt for each ask', async () => {
  const askedAt = '2026-11-20T02:15:00.000Z';
  const task = {
    id: 't-timestamp', title: 'Need decision', project: 'Camp', status: 'blocked', assignee: 'w1',
    humanQA: [{ q: 'Option A or Option B?', askedAt }],
  };
  const s = phoneServer([task]);
  const { status, body } = await s.request('/api/state');
  assert.equal(status, 200);
  assert.equal(body.asks.length, 1);
  assert.equal(body.asks[0].id, 't-timestamp');
  assert.equal(body.asks[0].askedAt, askedAt, 'state.asks must carry askedAt from humanQA');
});

test('phone API (/api/state) carries all open asks when a card has several asks', async () => {
  const t1 = '2026-11-20T01:00:00.000Z';
  const t2 = '2026-11-20T03:30:00.000Z';
  const task = {
    id: 't-multi-ask', title: 'Multiple questions', project: 'Camp', status: 'blocked', assignee: 'w1',
    humanQA: [
      { q: 'First question about assets?', askedAt: t1 },
      { q: 'Second question about timing?', askedAt: t2 }
    ],
  };
  const s = phoneServer([task]);
  const { status, body } = await s.request('/api/state');
  assert.equal(status, 200);
  assert.equal(body.asks.length, 2, 'both open asks on the card must be in asks array');
  assert.equal(body.asks[0].askedAt, t1, 'first ask must carry its own askedAt');
  assert.equal(body.asks[1].askedAt, t2, 'second ask must carry its own askedAt');
});

// ── Point 2: Phone Ask Me tab renders askedAt (local time + x h ago) ─────────

test('phone Ask Me tab renders question askedAt as local time plus relative ago', async () => {
  const now = Date.now();
  const askedAt = new Date(now - 2 * 3600 * 1000).toISOString(); // 2 hours ago
  const localTime = new Date(askedAt).toLocaleString();

  const state = {
    live: true,
    asks: [{ id: 't1', title: 'Restart Camp', assignee: 'w1', project: 'Camp', q: 'Restart now?', askedAt }],
    board: [],
    agents: [{ id: 'w1', name: 'Elm' }]
  };

  const p = phonePage([state]);
  await p.tick();
  p.tab('ask');
  await p.tick();

  const cardText = p.text();
  assert.match(cardText, /Restart now\?/, 'question text must render');
  assert.ok(cardText.includes(localTime), `phone ask card must contain local time "${localTime}"`);
  assert.match(cardText, /\b2\s*h\s*ago\b/i, 'phone ask card must contain "2h ago" or "2 h ago"');
});

test('phone Ask Me tab: when a card has several asks, each shows its own time', async () => {
  const now = Date.now();
  const t1 = new Date(now - 4 * 3600 * 1000).toISOString(); // 4 hours ago
  const t2 = new Date(now - 30 * 60 * 1000).toISOString(); // 30 minutes ago
  const localTime1 = new Date(t1).toLocaleString();
  const localTime2 = new Date(t2).toLocaleString();

  const state = {
    live: true,
    asks: [
      { id: 't-multi', title: 'Multi Ask', assignee: 'w1', project: 'Camp', q: 'First question?', askedAt: t1 },
      { id: 't-multi', title: 'Multi Ask', assignee: 'w1', project: 'Camp', q: 'Second question?', askedAt: t2 }
    ],
    board: [],
    agents: [{ id: 'w1', name: 'Elm' }]
  };

  const p = phonePage([state]);
  await p.tick();
  p.tab('ask');
  await p.tick();

  const cardText = p.text();
  assert.ok(cardText.includes(localTime1), `first ask shows its own local time "${localTime1}"`);
  assert.ok(cardText.includes(localTime2), `second ask shows its own local time "${localTime2}"`);
  assert.match(cardText, /\b4\s*h\s*ago\b/i, 'first ask shows "4h ago"');
  assert.match(cardText, /\b30\s*m\s*ago\b/i, 'second ask shows "30m ago"');
});

// ── Point 3: Phone Task Detail renders Q&A timestamps with relative ago ───────

test('phone Task Detail renders each question askedAt with local time and relative ago', async () => {
  const now = Date.now();
  const t1 = new Date(now - 5 * 3600 * 1000).toISOString(); // 5 hours ago
  const t2 = new Date(now - 1 * 3600 * 1000).toISOString(); // 1 hour ago
  const localTime1 = new Date(t1).toLocaleString();
  const localTime2 = new Date(t2).toLocaleString();

  const state = {
    live: true,
    asks: [{ id: 't1', title: 'Card 1', assignee: 'w1', project: 'Camp', q: 'Open question?', askedAt: t2 }],
    board: [],
    agents: [{ id: 'w1', name: 'Elm' }]
  };
  const detail = {
    ok: true,
    task: {
      id: 't1', title: 'Card 1', status: 'blocked', assignee: 'w1',
      qa: [
        { q: 'Earlier question?', a: 'Done', askedAt: t1, answeredAt: t1, dismissed: false },
        { q: 'Open question?', askedAt: t2, dismissed: false }
      ]
    }
  };

  const p = phonePage([state], { t1: detail });
  await p.tick();
  p.tab('ask');
  await p.tick();

  const [tlink] = p.all('tlink');
  assert.ok(tlink, 'title link to open detail must exist');
  tlink.onclick();
  await p.tick();

  const detailText = p.text();
  assert.ok(detailText.includes(localTime1), `earlier Q&A shows local time "${localTime1}"`);
  assert.ok(detailText.includes(localTime2), `open Q&A shows local time "${localTime2}"`);
  assert.match(detailText, /\b5\s*h\s*ago\b/i, 'earlier Q&A shows "5h ago"');
  assert.match(detailText, /\b1\s*h\s*ago\b/i, 'open Q&A shows "1h ago"');
});

// ── Point 4: Desktop ASK ME board card renders askedAt (local time + x h ago) ──

test('desktop AskMeTab renders question askedAt timestamp with local time and x h ago', () => {
  assert.match(
    ASK_ME_TAB_SRC,
    /askedAt/,
    'AskMeTab must reference askedAt to display question timestamp'
  );
  assert.match(
    ASK_ME_TAB_SRC,
    /toLocaleString|\.toLocaleTimeString/,
    'AskMeTab must format askedAt as local time'
  );
  assert.match(
    ASK_ME_TAB_SRC,
    /\bago\b|h ago|m ago/i,
    'AskMeTab must format relative age (e.g. x h ago)'
  );
});

test('desktop AskMeTab: when a card has several asks, each shows its own time', () => {
  // When a card has multiple open questions or several asks in humanQA,
  // AskMeTab must not collapse to only openQuestion(t)! which drops all but the last.
  // It must map each ask/open question and render its own timestamp.
  const collapsesToSingleAsk = /const\s+open\s*=\s*openQuestion\(t\)!;\s*\n[^\n]*dependentsTree[^\n]*\n\s*return\s*\(\s*<div[^>]*>\s*<CardHeader/s;
  assert.doesNotMatch(
    ASK_ME_TAB_SRC,
    collapsesToSingleAsk,
    'AskMeTab must not assume exactly one open question per card; when a card has several asks, each shows its own time'
  );
});

// ── Point 5: Defensive timestamp formatting for invalid or missing askedAt ───

test('phone Ask Me tab handles missing or unparseable askedAt defensively without NaN', async () => {
  const state = {
    live: true,
    asks: [
      { id: 't-bad-1', title: 'Missing Time', assignee: 'w1', project: 'Camp', q: 'No timestamp?', askedAt: undefined },
      { id: 't-bad-2', title: 'Garbage Time', assignee: 'w1', project: 'Camp', q: 'Bad timestamp?', askedAt: 'not-a-date' }
    ],
    board: [],
    agents: [{ id: 'w1', name: 'Elm' }]
  };

  const p = phonePage([state]);
  await p.tick();
  p.tab('ask');
  await p.tick();

  const text = p.text();
  assert.doesNotMatch(text, /NaN/, 'missing or bad timestamp must never render NaN');
  assert.doesNotMatch(text, /Invalid Date/i, 'missing or bad timestamp must never render Invalid Date');
  assert.match(text, /No timestamp\?/, 'first card still renders');
  assert.match(text, /Bad timestamp\?/, 'second card still renders');
});
