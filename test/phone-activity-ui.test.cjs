'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));

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

function page(states) {
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
    fetch: (u) => Promise.resolve({ status: 200, json: () => Promise.resolve(u.startsWith('/api/transcript') ? TAIL : states[Math.min(polls++, states.length - 1)]) }),
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


const TAIL = { ok: true, lines: ['alpha', 'beta'], truncated: false };
const tick = () => new Promise((r) => setImmediate(r));

test('floor card shows the live action with how long it has run and last output age', async () => {
  const now = Date.now();
  const states = [{ live: true, asks: [], board: [], agents: [{ id: 'a1', name: 'Pika', status: 'working', action: 'editing foo.ts', actionSince: now - 125000, lastOutputAt: now - 7000, lastReply: '', lastReplyAt: null }] }];
  const p = page(states);
  await tick(); await tick();
  assert.match(p.text(), /editing foo\.ts/);
  const [age] = p.all('age');
  assert.match(age.textContent, /for 2m \d+s/);
  assert.match(age.textContent, /last output \d+s ago/);
});

test('opening an agent offers output that loads read-only from /api/transcript', async () => {
  const states = [{ live: true, asks: [], board: [], agents: [{ id: 'a1', name: 'Pika', status: 'idle', action: 'idle', lastReply: 'hi', lastReplyAt: 1 }] }];
  const p = page(states);
  await tick(); await tick();
  const card = p.main.children[0];
  card.onclick({ target: { tagName: 'DIV', className: '' } });
  const [btn] = p.all('tailbtn');
  assert.equal(btn.textContent, 'Show output');
  btn.onclick();
  await tick(); await tick();
  const [tail] = p.all('tail');
  assert.equal(tail.textContent, 'alpha\nbeta');
});
